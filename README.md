# ICL Manual Annotation

A self-hosted web tool for dense, multi-annotator labeling of robot
teleop episodes stored in [lerobot v2.1](https://github.com/huggingface/lerobot)
format on Hugging Face. Multiple people on the same LAN open it in a
browser, scrub through an episode's synced camera feeds, and mark:

- **Key events** — a subtask name + a value (0–1), typed together and
  dropped at the current playhead position. Value holds constant from
  one key event to the next, with a smooth (sigmoid) transition right at
  each event's timestamp — visualized live as a continuous value-vs-time
  curve.
- **Outcome corrections** — override a dataset episode's success/fail
  label when it's wrong, without touching the upstream dataset.

Everything is saved as small per-episode JSON files on the machine
running the server — no database, no build step.

## Requirements

- Python environment with `fastapi`, `uvicorn`, `huggingface_hub` installed
  (this project was built/run against a conda env named `lerobot` that
  already had `huggingface_hub`; `fastapi`/`uvicorn` were added on top —
  see "Setup" below).
- Network access to Hugging Face (the dataset's metadata and videos are
  streamed from there directly; nothing is bulk-downloaded).

## Setup

```bash
conda activate lerobot   # or any env with huggingface_hub already installed
pip install fastapi "uvicorn[standard]"
```

## Running

```bash
python server.py --dataset owner/dataset-name --host 0.0.0.0 --port 8000
```

- `--dataset` (alias `--repo-id`) — the Hugging Face dataset repo id to
  annotate. Falls back to `$ICL_DATASET_REPO_ID`, then to
  `adityx23/icl-dataset`, if omitted.
- `--host` / `--port` — defaults `0.0.0.0` / `8000` (bound to `0.0.0.0` so
  it's reachable by other machines on the same WiFi/LAN, not just
  `localhost`).

On Windows there's also `start_server.ps1`:

```powershell
.\start_server.ps1
.\start_server.ps1 -Dataset "owner/other-dataset"
.\start_server.ps1 -Dataset "owner/other-dataset" -Port 9000
```

It prints both the `localhost` and LAN URLs on startup — share the LAN
one with other annotators on the same network.

Once running, open the printed URL in a browser: pick a task from the
dropdown (it jumps to the first un-annotated episode), scrub the video,
add key events, and hit **Save**.

## What's dataset-configurable vs. fixed

Only the **dataset repo id** is a runtime flag. Everything else assumes:

- A **bimanual** robot recording (the tool doesn't read state/action data
  at all, so this mostly just means the videos are treated as arbitrary
  multi-camera footage — no arm-count-specific logic exists to generalize).
- Exactly **3 cameras**, keyed `observation.images.zed`,
  `observation.images.fish0`, `observation.images.fish1` (see `CAMERAS` in
  `server.py`). Pointing this at a dataset with a different camera count
  or different camera keys will require editing that list by hand.
- **lerobot v2.1** layout: `meta/info.json`, `meta/tasks.jsonl`,
  `meta/episodes.jsonl`, and videos at
  `videos/chunk-{chunk:03d}/{camera_key}/episode_{index:06d}.mp4`.

If you need a different camera count/naming or a different lerobot
version's file layout, that's a code change, not a flag.

## Data model

**Task name canonicalization.** The source dataset's `meta/tasks.jsonl`
often has duplicate tasks under differently-formatted names (e.g.
`"[2 Gear Assembly]"` vs `"2 gear assembly"`). These are merged into one
canonical task everywhere (dropdown, episode counts, annotation JSON,
subtask vocab) by lowercasing, stripping `[` `]`, turning `_` into spaces,
and collapsing whitespace. The merge is recorded in `task_mapping.json`
(regenerated fresh on every startup) — canonical task index/name, which
raw names it absorbed, and the full list of episode indices in it. That
file is the reusable record if you ever want to push the same cleanup
upstream to the source dataset.

**Annotation JSON** — one file per episode at
`annotations/episode_{index:06d}.json`:

```json
{
  "episode_index": 79,
  "task_index": 1,
  "task": "3 cup tower stacking",
  "annotator": "Archit",
  "completed": true,
  "key_events": [
    { "id": "...", "subtask": "start", "value": 0.0, "frame": 0, "time": 0.0 },
    { "id": "...", "subtask": "move the two cups together", "value": 0.5, "frame": 1431, "time": 47.7 }
  ],
  "dataset_success": "success",
  "outcome_override": null,
  "created_at": "...",
  "updated_at": "..."
}
```

Autosaves as a draft (`completed: false`) ~1.2s after any edit; the Save
button writes immediately with `completed: true`.

**Subtask vocab.** Every subtask name ever typed for a task is tracked
per-task at `subtask_vocab/task_{index:03d}.json`, surfaced in the UI as
one-click "quick insert" pills so annotators don't retype the same
subtask name repeatedly. Purely additive by design — removing a pill via
its "✕" only removes the suggestion, never touches already-saved key
events, and never reappears on its own after a restart.

**Outcome correction.** `meta/episodes.jsonl`'s `success`/`fail` label is
read-only source data; an annotator can override it per-episode
(`outcome_override`) without modifying the original. `GET
/api/export/corrected-episodes` returns the dataset's original labels
merged with every override, for whenever you're ready to clean the
source dataset itself — there's no Hugging Face write path from this
tool (annotators typically won't have push access to the source repo).

## On-disk layout

```
annotations/        one JSON per annotated episode (git-ignored)
subtask_vocab/       one JSON per task's subtask-name suggestions (git-ignored)
meta_cache/           downloaded meta/*.json|jsonl from the dataset (git-ignored)
task_mapping.json     regenerated every startup (git-ignored)
static/                frontend: index.html, app.js, style.css
server.py              FastAPI backend
start_server.ps1        Windows launcher
```

None of the runtime-generated directories are committed — they belong to
whichever machine is running an instance of this tool, not to the repo.

## Notes / limitations

- **Single source of truth, single machine.** The server holds all
  annotation files on whatever machine runs it; every annotator's browser
  (even on other computers) is a thin client saving back to that one
  machine. If two people annotate the *same* episode at once, last save
  wins — no merge logic.
