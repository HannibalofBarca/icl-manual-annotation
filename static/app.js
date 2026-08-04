(() => {
  "use strict";

  const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];
  const AUTOSAVE_DELAY_MS = 1200;

  const S = {
    annotator: localStorage.getItem("annotatorName") || "",
    tasks: [],
    currentTaskIndex: null,
    taskEpisodes: [],
    episode: null,
    fps: 30,
    numFrames: 0,
    duration: 0,
    keyEvents: [],
    subtaskVocab: [],
    outcomeOverride: null,
    selectedEventId: null,
    completed: false,
    playbackRate: 1,
    isPlaying: false,
  };

  let idCounter = 0;
  const newId = () => `seg_${Date.now()}_${idCounter++}`;

  // ---------------------------------------------------------------- DOM refs
  const $ = (id) => document.getElementById(id);
  const taskSelect = $("taskSelect");
  const searchBox = $("searchBox");
  const posLabel = $("posLabel");
  const prevBtn = $("prevBtn");
  const nextBtn = $("nextBtn");
  const statusBadge = $("statusBadge");
  const saveBtn = $("saveBtn");
  const clearBtn = $("clearBtn");
  const deleteBtn = $("deleteBtn");
  const markSuccessBtn = $("markSuccessBtn");
  const markFailBtn = $("markFailBtn");
  const clearOutcomeBtn = $("clearOutcomeBtn");
  const datasetOutcomeTag = $("datasetOutcomeTag");
  const annotatorInput = $("annotatorInput");
  const themeToggleBtn = $("themeToggleBtn");

  const videos = { zed: $("cam-zed"), fish0: $("cam-fish0"), fish1: $("cam-fish1") };
  const master = videos.zed;

  const bigValueChartSvg = $("bigValueChart");
  const scrubber = $("scrubber");
  const scrubFill = $("scrubFill");
  const scrubPlayhead = $("scrubPlayhead");
  const subtaskLane = $("subtaskLane");
  const subtaskVocabRow = $("subtaskVocabRow");
  const timeText = $("timeText");
  const frameText = $("frameText");

  const playBtn = $("playBtn");
  const speedButtonsEl = $("speedButtons");

  const subtaskValueInput = $("subtaskValueInput");

  const subtaskNameInput = $("subtaskNameInput");
  const addKeyEventBtn = $("addKeyEventBtn");
  const subtaskCount = $("subtaskCount");
  const subtaskList = $("subtaskList");
  const subtaskOptionsDl = $("subtaskOptions");
  const taskMetaLine = $("taskMetaLine");
  const toastEl = $("toast");

  annotatorInput.value = S.annotator;

  // ---------------------------------------------------------------- theme
  function applyTheme(theme) {
    if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
    themeToggleBtn.textContent = theme === "light" ? "☀️" : "🌙";
  }
  applyTheme(localStorage.getItem("theme") === "light" ? "light" : "dark");
  themeToggleBtn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    localStorage.setItem("theme", next);
    applyTheme(next);
  });

  // -------------------------------------------------------------------- API
  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const j = await res.json();
        msg = j.detail || msg;
      } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  }

  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.classList.toggle("error", !!isError);
    toastEl.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function formatTime(seconds) {
    if (!isFinite(seconds)) seconds = 0;
    const totalTenths = Math.round(Math.max(0, seconds) * 10);
    const m = Math.floor(totalTenths / 600);
    const s = (totalTenths % 600) / 10;
    return `${m}:${s.toFixed(1).padStart(4, "0")}`;
  }

  function valueColor(v) {
    const clamped = Math.max(0, Math.min(1, v));
    return `hsl(${Math.round(clamped * 120)}, 75%, 50%)`;
  }

  // ------------------------------------------------------------ nav guard
  function hasUnfinishedContent() {
    return (S.keyEvents.length > 0 || !!S.outcomeOverride) && !S.completed;
  }

  function confirmNavigateAway() {
    if (!hasUnfinishedContent()) return true;
    return confirm(
      "This episode has annotations that haven't been marked complete (Save). Leave anyway?"
    );
  }

  window.addEventListener("beforeunload", (e) => {
    if (hasUnfinishedContent()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ------------------------------------------------------------- tasks list
  async function loadTasks() {
    S.tasks = await api("/api/tasks");
    renderTaskSelect();
  }

  function renderTaskSelect() {
    const prevVal = taskSelect.value;
    taskSelect.innerHTML =
      '<option value="">Select a task…</option>' +
      S.tasks
        .map(
          (t) =>
            `<option value="${t.task_index}">${escapeHtml(t.task)} (${t.annotated_count}/${t.total_episodes})</option>`
        )
        .join("");
    if (prevVal) taskSelect.value = prevVal;
  }

  async function refreshTasksKeepSelection() {
    await loadTasks();
    if (S.currentTaskIndex != null) taskSelect.value = String(S.currentTaskIndex);
  }

  async function selectTask(taskIndex) {
    S.currentTaskIndex = taskIndex;
    S.taskEpisodes = await api(`/api/tasks/${taskIndex}/episodes`);
    const first = await api(`/api/tasks/${taskIndex}/first-unannotated`);
    await loadEpisodeByIndex(first.episode_index);
  }

  taskSelect.addEventListener("change", async (e) => {
    const val = e.target.value;
    if (val === "") return;
    if (!confirmNavigateAway()) {
      taskSelect.value = S.currentTaskIndex != null ? String(S.currentTaskIndex) : "";
      return;
    }
    await selectTask(parseInt(val, 10));
  });

  // ----------------------------------------------------------------- nav
  async function navigateByOffset(delta) {
    if (!S.episode) return;
    if (!confirmNavigateAway()) return;
    const curPos = S.episode.position;
    const newPos = Math.max(1, Math.min(curPos + delta, S.episode.total_in_task));
    if (newPos === curPos) return;
    const target = S.taskEpisodes.find((e) => e.position === newPos);
    if (target) await loadEpisodeByIndex(target.episode_index);
  }
  prevBtn.addEventListener("click", () => navigateByOffset(-1));
  nextBtn.addEventListener("click", () => navigateByOffset(1));

  function jumpToSearch() {
    if (!S.episode) return;
    const raw = parseInt(searchBox.value, 10);
    if (isNaN(raw)) return;
    if (!confirmNavigateAway()) {
      searchBox.value = S.episode.position;
      return;
    }
    const pos = Math.max(1, Math.min(raw, S.episode.total_in_task));
    const target = S.taskEpisodes.find((e) => e.position === pos);
    if (target) loadEpisodeByIndex(target.episode_index);
  }
  searchBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      jumpToSearch();
    }
  });

  // -------------------------------------------------------------- annotator
  annotatorInput.addEventListener("change", () => {
    S.annotator = annotatorInput.value.trim();
    localStorage.setItem("annotatorName", S.annotator);
  });
  if (!S.annotator) {
    setTimeout(() => {
      const name = prompt("Enter your name (used to tag annotations):", "");
      if (name && name.trim()) {
        S.annotator = name.trim();
        annotatorInput.value = S.annotator;
        localStorage.setItem("annotatorName", S.annotator);
      }
    }, 200);
  }

  // ----------------------------------------------------------- episode load
  async function loadEpisodeByIndex(episodeIndex) {
    const ep = await api(`/api/episode/${episodeIndex}`);
    S.episode = ep;
    S.fps = ep.fps;
    S.numFrames = ep.length;
    S.duration = ep.length / ep.fps;

    const ann = ep.annotation;
    S.keyEvents = ((ann && ann.key_events) || []).map((e) => ({ value: 0.5, ...e }));
    S.outcomeOverride = (ann && ann.outcome_override) || null;
    S.completed = !!(ann && ann.completed);
    S.selectedEventId = null;
    clearTimeout(scheduleAutosave._t);

    videos.zed.src = ep.videos.zed;
    videos.fish0.src = ep.videos.fish0;
    videos.fish1.src = ep.videos.fish1;
    Object.values(videos).forEach((v) => {
      v.load();
      v.playbackRate = S.playbackRate;
    });
    S.isPlaying = false;
    updatePlayButton();

    const suggestions = new Set(ep.subtask_suggestions || []);
    S.keyEvents.forEach((e) => suggestions.add(e.subtask));
    subtaskOptionsDl.innerHTML = [...suggestions]
      .map((s) => `<option value="${escapeHtml(s)}"></option>`)
      .join("");

    S.subtaskVocab = (ep.subtask_suggestions || []).slice();
    renderSubtaskVocab();

    posLabel.textContent = `${ep.position} / ${ep.total_in_task}`;
    searchBox.value = ep.position;
    searchBox.placeholder = String(ep.total_in_task);

    const lastBy = ann && ann.annotator ? ` · last saved by ${escapeHtml(ann.annotator)}` : "";
    taskMetaLine.textContent = `Episode index ${ep.episode_index} · ${ep.length} frames · outcome: ${ep.success || "?"}${lastBy}`;

    seekTo(0);
    renderAll();
    updateStatusBadge();
  }

  // --------------------------------------------------------------- videos
  function getMasterTime() {
    return master.currentTime || 0;
  }

  function seekTo(t) {
    const clamped = Math.max(0, Math.min(t, S.duration || t));
    Object.values(videos).forEach((v) => {
      const d = v.duration;
      v.currentTime = isFinite(d) ? Math.min(clamped, d) : clamped;
    });
    updatePlayheadVisual(clamped);
  }

  master.addEventListener("timeupdate", () => {
    const t = getMasterTime();
    updatePlayheadVisual(t);
    for (const key of ["fish0", "fish1"]) {
      const v = videos[key];
      if (Math.abs(v.currentTime - t) > 0.15) v.currentTime = t;
    }
  });

  master.addEventListener("ended", () => {
    S.isPlaying = false;
    updatePlayButton();
    Object.values(videos).forEach((v) => v.pause());
  });

  function updatePlayheadVisual(t) {
    const frac = S.duration ? Math.max(0, Math.min(1, t / S.duration)) : 0;
    scrubPlayhead.style.left = `${frac * 100}%`;
    scrubFill.style.width = `${frac * 100}%`;
    const frame = Math.round(t * S.fps);
    timeText.textContent = formatTime(t);
    frameText.textContent = `frame ${frame} / ${Math.max(0, S.numFrames - 1)}`;
    updateChartPlayhead(t);
  }

  function togglePlay() {
    if (!S.episode) return;
    S.isPlaying = !S.isPlaying;
    if (S.isPlaying) {
      Object.values(videos).forEach((v) => v.play().catch(() => {}));
    } else {
      Object.values(videos).forEach((v) => v.pause());
    }
    updatePlayButton();
  }
  function updatePlayButton() {
    playBtn.textContent = S.isPlaying ? "⏸" : "▶";
  }
  playBtn.addEventListener("click", togglePlay);

  function stepFrames(n) {
    S.isPlaying = false;
    Object.values(videos).forEach((v) => v.pause());
    updatePlayButton();
    seekTo(getMasterTime() + (n / S.fps));
  }
  function pauseAndSeek(t) {
    S.isPlaying = false;
    Object.values(videos).forEach((v) => v.pause());
    updatePlayButton();
    seekTo(t);
  }
  $("gotoStartBtn").addEventListener("click", () => pauseAndSeek(0));
  $("gotoEndBtn").addEventListener("click", () => pauseAndSeek(S.duration));
  $("stepBack10").addEventListener("click", () => stepFrames(-10));
  $("stepBackFrame").addEventListener("click", () => stepFrames(-1));
  $("stepFwdFrame").addEventListener("click", () => stepFrames(1));
  $("stepFwd10").addEventListener("click", () => stepFrames(10));

  // speed buttons
  speedButtonsEl.innerHTML = SPEEDS.map((s) => `<button data-speed="${s}">${s}x</button>`).join("");
  speedButtonsEl.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      S.playbackRate = parseFloat(btn.dataset.speed);
      Object.values(videos).forEach((v) => (v.playbackRate = S.playbackRate));
      speedButtonsEl.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    });
    if (parseFloat(btn.dataset.speed) === 1) btn.classList.add("active");
  });

  // scrubber seek
  let scrubbing = false;
  function scrubToClientX(clientX) {
    const rect = scrubber.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    seekTo(frac * S.duration);
  }
  scrubber.addEventListener("pointerdown", (e) => {
    scrubbing = true;
    scrubber.setPointerCapture(e.pointerId);
    scrubToClientX(e.clientX);
  });
  scrubber.addEventListener("pointermove", (e) => {
    if (scrubbing) scrubToClientX(e.clientX);
  });
  scrubber.addEventListener("pointerup", () => (scrubbing = false));

  // ------------------------------------------------- value for new windows
  subtaskValueInput.addEventListener("change", () => {
    let v = parseFloat(subtaskValueInput.value);
    if (isNaN(v)) v = 0.5;
    v = Math.max(0, Math.min(1, v));
    subtaskValueInput.value = v.toFixed(2);
  });

  // ------------------------------------------------------- big value chart
  // The viewBox is kept in sync with the element's real pixel size (see
  // measureChart) so preserveAspectRatio="none" never has to scale x and y
  // by different factors — that non-uniform scaling is what was stretching
  // the axis label text.
  const CHART_PAD_LEFT = 54,
    CHART_PAD_RIGHT = 16,
    CHART_PAD_TOP = 14,
    CHART_PAD_BOTTOM = 34;
  let chartDims = { w: 1000, h: 320, plotW: 1000 - CHART_PAD_LEFT - CHART_PAD_RIGHT, plotH: 320 - CHART_PAD_TOP - CHART_PAD_BOTTOM };

  function measureChart() {
    const rect = bigValueChartSvg.getBoundingClientRect();
    const w = Math.max(200, Math.round(rect.width) || 1000);
    const h = Math.max(120, Math.round(rect.height) || 320);
    chartDims = { w, h, plotW: w - CHART_PAD_LEFT - CHART_PAD_RIGHT, plotH: h - CHART_PAD_TOP - CHART_PAD_BOTTOM };
    return chartDims;
  }

  function niceTimeStep(duration) {
    const target = Math.max(duration / 8, 0.5);
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900];
    for (const s of steps) if (target <= s) return s;
    return 1800;
  }

  function chartXForTime(t) {
    const frac = S.duration ? t / S.duration : 0;
    return CHART_PAD_LEFT + frac * chartDims.plotW;
  }
  function chartYForValue(v) {
    return CHART_PAD_TOP + (1 - Math.max(0, Math.min(1, v))) * chartDims.plotH;
  }
  function timeAtChartClientX(clientX) {
    const rect = bigValueChartSvg.getBoundingClientRect();
    const fracPixel = rect.width ? (clientX - rect.left) / rect.width : 0;
    const vbX = fracPixel * chartDims.w;
    const frac = chartDims.plotW ? (vbX - CHART_PAD_LEFT) / chartDims.plotW : 0;
    return Math.max(0, Math.min(S.duration, frac * S.duration));
  }

  function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
  }

  // Value holds constant from one key event until the next; right at each
  // event's own timestamp it blends smoothly via a sigmoid rather than
  // jumping instantly. Expressed as a sum of shifted sigmoid "steps" —
  // before the first transition settles near 0 (holding the first event's
  // value) and after the last settles near 1 (holding the last event's
  // value), so no special-casing is needed for the flat lead-in/lead-out.
  const KEY_EVENT_TRANSITION_HALF_WIDTH = 0.25; // seconds — fixed, since a
  // point event has no window/gap of its own to derive a width from.
  function buildValueCurve(events) {
    const sorted = [...events].sort((a, b) => a.time - b.time);
    if (!sorted.length) return () => 0.5;
    const transitions = [];
    for (let i = 1; i < sorted.length; i++) {
      transitions.push({
        center: sorted[i].time,
        halfWidth: KEY_EVENT_TRANSITION_HALF_WIDTH,
        delta: sorted[i].value - sorted[i - 1].value,
      });
    }
    const v0 = sorted[0].value;
    return function valueAt(t) {
      let v = v0;
      for (const tr of transitions) {
        v += tr.delta * sigmoid(((t - tr.center) / tr.halfWidth) * 3);
      }
      return Math.max(0, Math.min(1, v));
    };
  }

  function renderBigValueChart() {
    measureChart();
    bigValueChartSvg.setAttribute("viewBox", `0 0 ${chartDims.w} ${chartDims.h}`);
    const chartW = chartDims.w,
      chartH = chartDims.h;

    const parts = [];
    for (const gv of [0, 0.25, 0.5, 0.75, 1]) {
      const y = chartYForValue(gv);
      parts.push(
        `<line class="chart-grid" x1="${CHART_PAD_LEFT}" y1="${y.toFixed(1)}" x2="${chartW - CHART_PAD_RIGHT}" y2="${y.toFixed(1)}" />`
      );
      parts.push(
        `<text class="chart-axis-label" x="${CHART_PAD_LEFT - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end">${gv.toFixed(2)}</text>`
      );
    }
    if (S.duration > 0) {
      const step = niceTimeStep(S.duration);
      for (let t = 0; t <= S.duration + 1e-6; t += step) {
        const x = chartXForTime(t);
        parts.push(
          `<line class="chart-grid" x1="${x.toFixed(1)}" y1="${CHART_PAD_TOP}" x2="${x.toFixed(1)}" y2="${chartH - CHART_PAD_BOTTOM}" />`
        );
        parts.push(
          `<text class="chart-axis-label" x="${x.toFixed(1)}" y="${chartH - CHART_PAD_BOTTOM + 18}" text-anchor="middle">${formatTime(t)}</text>`
        );
      }
    }
    parts.push(
      `<line class="chart-axis" x1="${CHART_PAD_LEFT}" y1="${CHART_PAD_TOP}" x2="${CHART_PAD_LEFT}" y2="${chartH - CHART_PAD_BOTTOM}" />`
    );
    parts.push(
      `<line class="chart-axis" x1="${CHART_PAD_LEFT}" y1="${chartH - CHART_PAD_BOTTOM}" x2="${chartW - CHART_PAD_RIGHT}" y2="${chartH - CHART_PAD_BOTTOM}" />`
    );

    if (S.keyEvents.length && S.duration > 0) {
      const valueAt = buildValueCurve(S.keyEvents);
      const sorted = [...S.keyEvents].sort((a, b) => a.time - b.time);
      const SAMPLES = 400;
      const gradId = "chartCurveGradient";
      const stops = [];
      const pts = [];
      for (let i = 0; i <= SAMPLES; i++) {
        const t = (i / SAMPLES) * S.duration;
        const v = valueAt(t);
        pts.push(`${chartXForTime(t).toFixed(1)},${chartYForValue(v).toFixed(1)}`);
        stops.push(`<stop offset="${((i / SAMPLES) * 100).toFixed(2)}%" stop-color="${valueColor(v)}" />`);
      }
      parts.push(`<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="0">${stops.join("")}</linearGradient></defs>`);
      parts.push(`<polyline class="chart-line" points="${pts.join(" ")}" stroke="url(#${gradId})" />`);

      // dashed marker + label at each key event's own timestamp. Labels
      // that would overlap horizontally (events close together) drop to
      // their own row underneath, rather than colliding at a fixed height.
      const LABEL_ROW_HEIGHT = 12;
      const labelRowRightEdge = [];
      sorted.forEach((ev) => {
        const x = chartXForTime(ev.time);
        const textWidth = ev.subtask.length * 5.5; // rough glyph-width estimate at font-size 10px
        const left = x - textWidth / 2;
        const right = x + textWidth / 2;
        let row = 0;
        while (row < labelRowRightEdge.length && left < labelRowRightEdge[row] + 4) row++;
        labelRowRightEdge[row] = right;

        parts.push(
          `<line class="chart-seg-boundary" x1="${x.toFixed(1)}" y1="${CHART_PAD_TOP}" x2="${x.toFixed(1)}" y2="${chartH - CHART_PAD_BOTTOM}" />`
        );
        parts.push(
          `<text class="chart-seg-label" x="${x.toFixed(1)}" y="${CHART_PAD_TOP + 11 + row * LABEL_ROW_HEIGHT}" text-anchor="middle">${escapeHtml(ev.subtask)}</text>`
        );
      });
    }

    parts.push(
      `<line id="chartPlayhead" class="chart-playhead" x1="${CHART_PAD_LEFT}" y1="${CHART_PAD_TOP}" x2="${CHART_PAD_LEFT}" y2="${chartH - CHART_PAD_BOTTOM}" />`
    );

    bigValueChartSvg.innerHTML = parts.join("");
    updateChartPlayhead(getMasterTime());
  }

  let chartResizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(chartResizeTimer);
    chartResizeTimer = setTimeout(() => {
      if (S.episode) renderBigValueChart();
    }, 150);
  });

  function updateChartPlayhead(t) {
    const el = document.getElementById("chartPlayhead");
    if (!el) return;
    const x = chartXForTime(t).toFixed(1);
    el.setAttribute("x1", x);
    el.setAttribute("x2", x);
  }

  let chartScrubbing = false;
  bigValueChartSvg.addEventListener("pointerdown", (e) => {
    chartScrubbing = true;
    bigValueChartSvg.setPointerCapture(e.pointerId);
    seekTo(timeAtChartClientX(e.clientX));
  });
  bigValueChartSvg.addEventListener("pointermove", (e) => {
    if (chartScrubbing) seekTo(timeAtChartClientX(e.clientX));
  });
  bigValueChartSvg.addEventListener("pointerup", () => (chartScrubbing = false));

  // ----------------------------------------------------------- key events
  // Row-packing for the lane: a key event has no real duration, but its
  // label does occupy horizontal space, so each event is given a synthetic
  // [time, time + labelDuration] span (label pixel-width converted to a
  // time-equivalent via the lane's pixel-per-second) and packed into rows
  // with the same greedy interval algorithm, so overlapping labels stack
  // instead of colliding.
  function assignLaneRows(spans) {
    const sorted = [...spans].sort((a, b) => a.start_time - b.start_time);
    const rowEnds = [];
    const rowOf = {};
    for (const span of sorted) {
      let placed = false;
      for (let r = 0; r < rowEnds.length; r++) {
        if (span.start_time >= rowEnds[r] - 1e-6) {
          rowOf[span.id] = r;
          rowEnds[r] = span.end_time;
          placed = true;
          break;
        }
      }
      if (!placed) {
        rowOf[span.id] = rowEnds.length;
        rowEnds.push(span.end_time);
      }
    }
    return { rowOf, numRows: Math.max(1, rowEnds.length) };
  }

  function addKeyEventAtPlayhead(nameOverride) {
    if (!S.episode) return;
    const name = (nameOverride || subtaskNameInput.value).trim();
    if (!name) {
      toast("Type a subtask name first", true);
      subtaskNameInput.focus();
      return;
    }
    let value = parseFloat(subtaskValueInput.value);
    if (isNaN(value)) value = 0.5;
    value = Math.max(0, Math.min(1, value));
    subtaskValueInput.value = value.toFixed(2);

    const t = getMasterTime();
    const frame = Math.round(t * S.fps);
    const existingIdx = S.keyEvents.findIndex((e) => e.frame === frame);
    const event = { id: existingIdx >= 0 ? S.keyEvents[existingIdx].id : newId(), subtask: name, value, frame, time: frame / S.fps };
    if (existingIdx >= 0) S.keyEvents[existingIdx] = event;
    else S.keyEvents.push(event);
    S.keyEvents.sort((a, b) => a.frame - b.frame);
    S.selectedEventId = event.id;
    if (!nameOverride) subtaskNameInput.value = "";
    if (!S.subtaskVocab.includes(name)) {
      S.subtaskVocab.push(name);
      S.subtaskVocab.sort((a, b) => a.localeCompare(b));
      renderSubtaskVocab();
    }
    renderKeyEventLane();
    renderKeyEventList();
    renderBigValueChart();
    updateStatusBadge();
    scheduleAutosave();
  }
  addKeyEventBtn.addEventListener("click", () => addKeyEventAtPlayhead());
  subtaskNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addKeyEventAtPlayhead();
    }
  });

  function renderSubtaskVocab() {
    subtaskVocabRow.innerHTML = S.subtaskVocab
      .map(
        (name) => `<span class="vocab-pill">
          <button type="button" class="vocab-btn" data-name="${escapeHtml(name)}">${escapeHtml(name)}</button>
          <button type="button" class="vocab-del" data-name="${escapeHtml(name)}" title="Remove from quick-insert list">✕</button>
        </span>`
      )
      .join("");
  }
  subtaskVocabRow.addEventListener("click", (e) => {
    const delBtn = e.target.closest(".vocab-del");
    if (delBtn) {
      deleteVocabEntry(delBtn.dataset.name);
      return;
    }
    const btn = e.target.closest(".vocab-btn");
    if (!btn) return;
    addKeyEventAtPlayhead(btn.dataset.name);
  });

  async function deleteVocabEntry(name) {
    if (S.currentTaskIndex == null) return;
    if (!confirm(`Remove "${name}" from the quick-insert list for this task? (Any key events already using this name are not affected.)`)) return;
    try {
      await api(`/api/tasks/${S.currentTaskIndex}/subtask-vocab?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      S.subtaskVocab = S.subtaskVocab.filter((n) => n !== name);
      renderSubtaskVocab();
      toast(`Removed "${name}" from quick-insert list`);
    } catch (e) {
      toast("Failed to remove: " + e.message, true);
    }
  }

  function deleteKeyEvent(id) {
    S.keyEvents = S.keyEvents.filter((e) => e.id !== id);
    if (S.selectedEventId === id) S.selectedEventId = null;
    renderKeyEventLane();
    renderKeyEventList();
    renderBigValueChart();
    updateStatusBadge();
    scheduleAutosave();
  }

  function updateKeyEventField(id, field, rawValue) {
    const ev = S.keyEvents.find((e) => e.id === id);
    if (!ev) return;
    if (field === "subtask") {
      ev.subtask = rawValue;
    } else if (field === "value") {
      const v = parseFloat(rawValue);
      if (!isNaN(v)) ev.value = Math.max(0, Math.min(1, v));
    } else if (field === "time") {
      const v = parseFloat(rawValue);
      if (!isNaN(v)) {
        ev.time = Math.max(0, Math.min(S.duration, v));
        ev.frame = Math.round(ev.time * S.fps);
      }
    }
    S.keyEvents.sort((a, b) => a.frame - b.frame);
    renderKeyEventLane();
    renderKeyEventList();
    renderBigValueChart();
    scheduleAutosave();
  }

  const ROW_H = 26;

  function renderKeyEventLane() {
    subtaskLane.innerHTML = "";
    const laneRect = subtaskLane.getBoundingClientRect();
    const laneWidthPx = laneRect.width || 1000;
    const pxPerSecond = S.duration ? laneWidthPx / S.duration : 0;
    const spans = S.keyEvents.map((e) => {
      const labelPx = 24 + e.subtask.length * 6; // dot + label width estimate
      const labelDuration = pxPerSecond ? labelPx / pxPerSecond : 0;
      return { id: e.id, start_time: e.time, end_time: e.time + labelDuration };
    });
    const { rowOf, numRows } = assignLaneRows(spans);
    subtaskLane.style.height = `${numRows * ROW_H + 6}px`;
    S.keyEvents.forEach((ev) => {
      const row = rowOf[ev.id] || 0;
      const leftFrac = S.duration ? ev.time / S.duration : 0;
      const el = document.createElement("div");
      el.className = "key-event-marker" + (S.selectedEventId === ev.id ? " selected" : "");
      el.style.left = `${leftFrac * 100}%`;
      el.style.top = `${row * ROW_H + 3}px`;
      el.dataset.id = ev.id;
      el.innerHTML = `
        <span class="key-event-dot" style="background:${valueColor(ev.value)}"></span>
        <span class="key-event-label">${escapeHtml(ev.subtask || "(untitled)")} · ${ev.value.toFixed(2)}</span>`;
      subtaskLane.appendChild(el);
    });
  }

  // drag handling for the lane (delegated) — a key event only has a single
  // time to move, so dragging is just repositioning it horizontally
  let dragState = null; // {id, moved, startClientX}

  function timeAtClientX(clientX) {
    const rect = subtaskLane.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return frac * S.duration;
  }

  subtaskLane.addEventListener("pointerdown", (e) => {
    const markerEl = e.target.closest(".key-event-marker");
    if (!markerEl) return;
    const id = markerEl.dataset.id;
    const ev = S.keyEvents.find((e) => e.id === id);
    if (!ev) return;
    S.selectedEventId = id;
    dragState = { id, moved: false, startClientX: e.clientX };
    subtaskLane.setPointerCapture(e.pointerId);
    renderKeyEventLane();
    renderKeyEventList();
  });

  subtaskLane.addEventListener("pointermove", (e) => {
    if (!dragState) return;
    if (Math.abs(e.clientX - dragState.startClientX) > 2) dragState.moved = true;
    const ev = S.keyEvents.find((e) => e.id === dragState.id);
    if (!ev) return;
    ev.time = Math.max(0, Math.min(S.duration, timeAtClientX(e.clientX)));
    ev.frame = Math.round(ev.time * S.fps);
    renderKeyEventLane();
  });

  subtaskLane.addEventListener("pointerup", () => {
    if (!dragState) return;
    const ev = S.keyEvents.find((e) => e.id === dragState.id);
    const wasClickOnly = !dragState.moved;
    dragState = null;
    if (ev) {
      S.keyEvents.sort((a, b) => a.frame - b.frame);
      if (wasClickOnly) seekTo(ev.time);
    }
    renderKeyEventLane();
    renderKeyEventList();
    renderBigValueChart();
    if (ev && !wasClickOnly) {
      const input = subtaskList.querySelector(`.seg-row.active input[data-field="time"]`);
      if (input) {
        input.focus();
        input.select();
      }
    }
    updateStatusBadge();
    scheduleAutosave();
  });

  function renderKeyEventList() {
    subtaskCount.textContent = S.keyEvents.length;
    subtaskList.innerHTML = "";
    const sorted = [...S.keyEvents].sort((a, b) => a.time - b.time);
    sorted.forEach((ev) => {
      const row = document.createElement("div");
      row.className = "seg-row" + (S.selectedEventId === ev.id ? " active" : "");
      row.innerHTML = `
        <input class="seg-name" type="text" value="${escapeHtml(ev.subtask)}" list="subtaskOptions" />
        <div class="seg-time-group">
          <span class="seg-value-dot" style="background:${valueColor(ev.value)}"></span>
          <label>value</label>
          <input class="seg-value-field" data-field="value" type="number" min="0" max="1" step="0.01" value="${ev.value.toFixed(2)}" />
          <label>time</label>
          <input class="seg-time-field" data-field="time" type="number" step="0.033" value="${ev.time.toFixed(3)}" />
          <button class="row-del-btn" title="Delete">✕</button>
        </div>`;
      row.querySelector(".seg-name").addEventListener("change", (e) => updateKeyEventField(ev.id, "subtask", e.target.value));
      row.querySelector(".seg-value-field").addEventListener("change", (e) => updateKeyEventField(ev.id, "value", e.target.value));
      row.querySelector(".seg-time-field").addEventListener("change", (e) => updateKeyEventField(ev.id, "time", e.target.value));
      row.querySelector(".seg-time-field").addEventListener("focus", () => {
        S.selectedEventId = ev.id;
        renderKeyEventLane();
      });
      row.querySelector(".row-del-btn").addEventListener("click", () => deleteKeyEvent(ev.id));
      row.addEventListener("click", (e) => {
        if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
        S.selectedEventId = ev.id;
        seekTo(ev.time);
        renderKeyEventLane();
        renderKeyEventList();
      });
      subtaskList.appendChild(row);
    });
  }

  // ------------------------------------------------------------------ save
  function currentPayload(completed) {
    return {
      annotator: S.annotator,
      completed: completed,
      key_events: S.keyEvents.map((e) => ({
        id: e.id,
        subtask: e.subtask,
        value: +e.value.toFixed(3),
        frame: e.frame,
        time: +e.time.toFixed(4),
      })),
      outcome_override: S.outcomeOverride,
    };
  }

  async function saveAnnotation(completed, opts = {}) {
    if (!S.episode) return;
    try {
      await api(`/api/episode/${S.episode.episode_index}/annotations`, {
        method: "POST",
        body: JSON.stringify(currentPayload(completed)),
      });
      S.completed = completed;
      updateStatusBadge();
      const entry = S.taskEpisodes.find((e) => e.episode_index === S.episode.episode_index);
      if (entry) {
        entry.annotated = completed;
        entry.has_draft = !completed && S.keyEvents.length > 0;
      }
      if (!opts.silent) {
        toast(opts.successMessage || (completed ? "Saved & marked complete" : "Draft saved"));
        refreshTasksKeepSelection();
      }
    } catch (e) {
      if (!opts.silent) toast("Save failed: " + e.message, true);
    }
  }

  function scheduleAutosave() {
    clearTimeout(scheduleAutosave._t);
    scheduleAutosave._t = setTimeout(() => saveAnnotation(S.completed, { silent: true }), AUTOSAVE_DELAY_MS);
  }

  saveBtn.addEventListener("click", () => {
    clearTimeout(scheduleAutosave._t);
    if (!S.annotator) {
      const name = prompt("Enter your name before saving:", "");
      if (name && name.trim()) {
        S.annotator = name.trim();
        annotatorInput.value = S.annotator;
        localStorage.setItem("annotatorName", S.annotator);
      }
    }
    saveAnnotation(true);
  });

  clearBtn.addEventListener("click", () => {
    if (!S.episode) return;
    if (S.keyEvents.length === 0) {
      toast("Nothing to clear");
      return;
    }
    if (!confirm("Clear all key events for this episode? This will overwrite the saved draft.")) return;
    clearTimeout(scheduleAutosave._t);
    S.keyEvents = [];
    S.completed = false;
    S.selectedEventId = null;
    renderAll();
    updateStatusBadge();
    saveAnnotation(false, { successMessage: "Cleared" });
  });

  deleteBtn.addEventListener("click", async () => {
    if (!S.episode) return;
    if (!confirm("Permanently delete the saved annotation file for this episode from disk? This cannot be undone.")) return;
    clearTimeout(scheduleAutosave._t);
    try {
      await api(`/api/episode/${S.episode.episode_index}/annotations`, { method: "DELETE" });
      S.keyEvents = [];
      S.completed = false;
      S.selectedEventId = null;
      renderAll();
      updateStatusBadge();
      const entry = S.taskEpisodes.find((e) => e.episode_index === S.episode.episode_index);
      if (entry) {
        entry.annotated = false;
        entry.has_draft = false;
      }
      toast("Annotation deleted");
      refreshTasksKeepSelection();
    } catch (e) {
      toast("Delete failed: " + e.message, true);
    }
  });

  function updateStatusBadge() {
    const hasContent = S.keyEvents.length > 0;
    statusBadge.classList.remove("dirty", "saved");
    if (S.completed) {
      statusBadge.textContent = "Completed";
      statusBadge.classList.add("saved");
    } else if (hasContent) {
      statusBadge.textContent = "In progress";
      statusBadge.classList.add("dirty");
    } else {
      statusBadge.textContent = "Not started";
    }
  }

  function renderAll() {
    renderBigValueChart();
    renderKeyEventLane();
    renderKeyEventList();
    renderOutcomeButtons();
  }

  // ------------------------------------------------------------- outcome
  function renderOutcomeButtons() {
    markSuccessBtn.classList.toggle("active", S.outcomeOverride === "success");
    markFailBtn.classList.toggle("active", S.outcomeOverride === "fail");
    clearOutcomeBtn.disabled = !S.outcomeOverride;

    const dsSuccess = S.episode ? S.episode.success : null;
    datasetOutcomeTag.classList.remove("ds-success", "ds-fail");
    if (dsSuccess === "success") {
      datasetOutcomeTag.textContent = "Dataset: success";
      datasetOutcomeTag.classList.add("ds-success");
    } else if (dsSuccess === "fail") {
      datasetOutcomeTag.textContent = "Dataset: fail";
      datasetOutcomeTag.classList.add("ds-fail");
    } else {
      datasetOutcomeTag.textContent = "Dataset: unknown";
    }
  }

  function markOutcome(value) {
    if (!S.episode) return;
    if (S.outcomeOverride === value) return;
    const label = value === "success" ? "SUCCESS" : "FAIL";
    const datasetLabel = S.episode.success || "unknown";
    if (!confirm(`Mark this episode's outcome as ${label}? This records a correction to the dataset's original label ("${datasetLabel}").`)) return;
    clearTimeout(scheduleAutosave._t);
    S.outcomeOverride = value;
    renderOutcomeButtons();
    saveAnnotation(S.completed, { successMessage: `Outcome marked as ${label}` });
  }
  markSuccessBtn.addEventListener("click", () => markOutcome("success"));
  markFailBtn.addEventListener("click", () => markOutcome("fail"));
  clearOutcomeBtn.addEventListener("click", () => {
    if (!S.episode || !S.outcomeOverride) return;
    if (!confirm("Remove the outcome correction for this episode and revert to the dataset's original label?")) return;
    clearTimeout(scheduleAutosave._t);
    S.outcomeOverride = null;
    renderOutcomeButtons();
    saveAnnotation(S.completed, { successMessage: "Outcome correction cleared" });
  });

  // -------------------------------------------------------------- keyboard
  window.addEventListener("keydown", (e) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
    if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
    } else if (e.code === "ArrowLeft") {
      stepFrames(e.shiftKey ? -10 : -1);
    } else if (e.code === "ArrowRight") {
      stepFrames(e.shiftKey ? 10 : 1);
    } else if (e.code === "Home") {
      pauseAndSeek(0);
    } else if (e.code === "End") {
      pauseAndSeek(S.duration);
    }
  });

  // ------------------------------------------------------------------ boot
  loadTasks().catch((e) => toast("Failed to load tasks: " + e.message, true));
})();
