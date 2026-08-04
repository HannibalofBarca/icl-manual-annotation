"""Backend for the ICL dense value / key-event annotation tool.

Serves task/episode metadata pulled from a lerobot v2.1 dataset on Hugging
Face (which dataset is a CLI flag, not hardcoded — see --dataset below),
hands the frontend direct HF video URLs (no video proxying — HF supports
CORS + byte-range requests so <video> can stream/scrub directly), and
persists annotations as small per-episode JSON files on local disk.

This tool assumes a bimanual robot recorded with exactly 3 cameras keyed
"observation.images.{zed,fish0,fish1}" (see CAMERAS below) — that part is
NOT dataset-configurable; only the dataset/repo itself is.
"""

import argparse
import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from huggingface_hub import hf_hub_download

DEFAULT_REPO_ID = "adityx23/icl-dataset"


def _parse_cli_args():
    """Parsed both when run directly (`python server.py --dataset ...`) and
    when imported by uvicorn's own CLI (`python -m uvicorn server:app ...`)
    — parse_known_args() ignores whatever unrelated flags uvicorn's argv
    carries in the latter case, so --dataset silently falls back to the
    environment variable or default instead of erroring."""
    parser = argparse.ArgumentParser(
        description="ICL manual annotation server",
        add_help=False,
    )
    parser.add_argument(
        "--dataset", "--repo-id",
        dest="dataset",
        default=None,
        help="Hugging Face dataset repo id to annotate, e.g. 'owner/name' (lerobot v2.1 format). "
        f"Defaults to $ICL_DATASET_REPO_ID or '{DEFAULT_REPO_ID}'.",
    )
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0, i.e. reachable on the LAN)")
    parser.add_argument("--port", type=int, default=8901, help="Bind port (default: 8901)")
    parser.add_argument("-h", "--help", action="help", help="Show this help message and exit")
    args, _unknown = parser.parse_known_args()
    return args


_CLI_ARGS = _parse_cli_args()
REPO_ID = _CLI_ARGS.dataset or os.environ.get("ICL_DATASET_REPO_ID") or DEFAULT_REPO_ID
CAMERAS = ["observation.images.zed", "observation.images.fish0", "observation.images.fish1"]

BASE_DIR = Path(__file__).parent
META_DIR = BASE_DIR / "meta_cache"
ANN_DIR = BASE_DIR / "annotations"
VOCAB_DIR = BASE_DIR / "subtask_vocab"
STATIC_DIR = BASE_DIR / "static"
TASK_MAPPING_PATH = BASE_DIR / "task_mapping.json"
ANN_DIR.mkdir(exist_ok=True)
META_DIR.mkdir(exist_ok=True)
VOCAB_DIR.mkdir(exist_ok=True)

_save_lock = threading.Lock()


def _load_meta():
    info_path = hf_hub_download(REPO_ID, "meta/info.json", repo_type="dataset", local_dir=META_DIR)
    tasks_path = hf_hub_download(REPO_ID, "meta/tasks.jsonl", repo_type="dataset", local_dir=META_DIR)
    episodes_path = hf_hub_download(REPO_ID, "meta/episodes.jsonl", repo_type="dataset", local_dir=META_DIR)
    info = json.loads(Path(info_path).read_text())
    tasks = [json.loads(line) for line in Path(tasks_path).read_text().splitlines() if line.strip()]
    episodes = [json.loads(line) for line in Path(episodes_path).read_text().splitlines() if line.strip()]
    return info, tasks, episodes


INFO, TASKS, EPISODES = _load_meta()
CHUNKS_SIZE = INFO["chunks_size"]
FPS = INFO["fps"]

def canonicalize_task_name(raw: str) -> str:
    """Standardized task name: lowercase, no square brackets, underscores
    become spaces, whitespace collapsed. This is what merges dataset
    duplicates like "[2 Gear Assembly]" and "2 gear assembly" into one
    task everywhere (dropdown, episode counts, annotation json, vocab)."""
    s = raw.lower().replace("[", "").replace("]", "").replace("_", " ")
    return re.sub(r"\s+", " ", s).strip()


EPISODE_BY_INDEX = {ep["episode_index"]: ep for ep in EPISODES}

_raw_names_by_canonical: dict[str, set[str]] = {}
_episodes_by_canonical: dict[str, list[dict]] = {}
for ep in EPISODES:
    raw_name = ep["tasks"][0]
    canon = canonicalize_task_name(raw_name)
    _raw_names_by_canonical.setdefault(canon, set()).add(raw_name)
    _episodes_by_canonical.setdefault(canon, []).append(ep)

# canonical_task_index -> {"task": canonical name, "raw_task_names": [...], "episodes": [...]}
# IDs are freshly assigned (alphabetical over canonical names), independent of
# the dataset's original (fragmented) task_index numbering.
TASKS_BY_INDEX: dict[int, dict] = {}
CANONICAL_TASK_INDEX_BY_EPISODE: dict[int, int] = {}
for t_idx, canon in enumerate(sorted(_episodes_by_canonical.keys())):
    eps = sorted(_episodes_by_canonical[canon], key=lambda e: e["episode_index"])
    TASKS_BY_INDEX[t_idx] = {
        "task": canon,
        "raw_task_names": sorted(_raw_names_by_canonical[canon]),
        "episodes": eps,
    }
    for e in eps:
        CANONICAL_TASK_INDEX_BY_EPISODE[e["episode_index"]] = t_idx


def _write_task_mapping_file() -> None:
    """Durable task-name -> episode-id record, regenerated fresh on every
    startup from the source dataset. This is what makes the merge legible
    and reusable later for cleaning the actual dataset upstream."""
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "normalization_rule": "lowercase; strip [ and ]; underscores -> spaces; collapse whitespace",
        "canonical_tasks": [
            {
                "canonical_task_index": t_idx,
                "canonical_task": bucket["task"],
                "raw_task_names": bucket["raw_task_names"],
                "total_episodes": len(bucket["episodes"]),
                "episode_indices": [e["episode_index"] for e in bucket["episodes"]],
            }
            for t_idx, bucket in TASKS_BY_INDEX.items()
        ],
    }
    TASK_MAPPING_PATH.write_text(json.dumps(payload, indent=2))


_write_task_mapping_file()

app = FastAPI(title="ICL Manual Annotation")


def ann_path(episode_index: int) -> Path:
    return ANN_DIR / f"episode_{episode_index:06d}.json"


def read_annotation(episode_index: int):
    p = ann_path(episode_index)
    if p.exists():
        return json.loads(p.read_text())
    return None


def is_done(episode_index: int) -> bool:
    a = read_annotation(episode_index)
    return bool(a and a.get("completed"))


def video_url(episode_index: int, camera: str) -> str:
    chunk = episode_index // CHUNKS_SIZE
    return (
        f"https://huggingface.co/datasets/{REPO_ID}/resolve/main/"
        f"videos/chunk-{chunk:03d}/{camera}/episode_{episode_index:06d}.mp4"
    )


def camera_key(camera: str) -> str:
    return camera.rsplit(".", 1)[-1]


def vocab_path(task_index: int) -> Path:
    return VOCAB_DIR / f"task_{task_index:03d}.json"


def read_vocab(task_index: int) -> list[str]:
    p = vocab_path(task_index)
    if p.exists():
        return list(json.loads(p.read_text()).get("subtasks", []))
    return []


def write_vocab(task_index: int, task_name: str, subtasks: set[str]) -> None:
    data = {
        "task_index": task_index,
        "task": task_name,
        "subtasks": sorted(subtasks, key=str.lower),
    }
    p = vocab_path(task_index)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(p)


def _reconcile_vocab_with_canonical_tasks() -> None:
    """Self-heals vocab files left filed under a stale task index (e.g.
    after a task-name merge/renumbering) by moving their contents to the
    correct canonical file. This never deletes entries — from here on,
    syncing is purely additive so removing a subtask via the UI's
    delete-pill stays deleted across restarts."""
    for p in list(VOCAB_DIR.glob("*.json")):
        try:
            data = json.loads(p.read_text())
        except Exception:
            continue
        stored_task_index = data.get("task_index")
        stored_task_name = data.get("task", "")
        bucket = TASKS_BY_INDEX.get(stored_task_index)
        if bucket is not None and bucket["task"] == stored_task_name:
            continue  # already filed correctly
        canon = canonicalize_task_name(stored_task_name)
        correct_idx = next(
            (t_idx for t_idx, b in TASKS_BY_INDEX.items() if b["task"] == canon or stored_task_name in b["raw_task_names"]),
            None,
        )
        if correct_idx is None:
            continue
        merged = set(read_vocab(correct_idx)) | set(data.get("subtasks", []))
        write_vocab(correct_idx, TASKS_BY_INDEX[correct_idx]["task"], merged)
        if vocab_path(correct_idx) != p:
            p.unlink()


def _sync_vocab_with_annotations() -> None:
    """Bootstraps a vocab file for any task that has never had one, from
    whatever subtask names are already saved in its episodes (e.g. episodes
    annotated before the vocab feature existed). A task that already has a
    vocab file — even one curated down to fewer entries via the delete-pill
    — is left alone, so a deliberately removed entry never reappears just
    because it's still referenced by an existing (untouched) episode."""
    by_task: dict[int, set[str]] = {}
    for ep in EPISODES:
        ann = read_annotation(ep["episode_index"])
        if not ann:
            continue
        names = {e.get("subtask", "").strip() for e in ann.get("key_events", []) if e.get("subtask", "").strip()}
        if names:
            t_idx = CANONICAL_TASK_INDEX_BY_EPISODE[ep["episode_index"]]
            by_task.setdefault(t_idx, set()).update(names)
    for t_idx, names in by_task.items():
        if vocab_path(t_idx).exists():
            continue
        write_vocab(t_idx, TASKS_BY_INDEX[t_idx]["task"], names)


_reconcile_vocab_with_canonical_tasks()
_sync_vocab_with_annotations()


def _refresh_annotation_task_fields() -> None:
    """Keep each saved annotation's task_index/task fields in sync with the
    current canonical grouping, so files saved before a task merge (or
    renumbering) don't show stale info until their next save."""
    for ep in EPISODES:
        idx = ep["episode_index"]
        ann = read_annotation(idx)
        if not ann:
            continue
        t_idx = CANONICAL_TASK_INDEX_BY_EPISODE[idx]
        correct_name = TASKS_BY_INDEX[t_idx]["task"]
        if ann.get("task_index") != t_idx or ann.get("task") != correct_name:
            ann["task_index"] = t_idx
            ann["task"] = correct_name
            tmp = ann_path(idx).with_suffix(".json.tmp")
            tmp.write_text(json.dumps(ann, indent=2))
            tmp.replace(ann_path(idx))


_refresh_annotation_task_fields()


@app.get("/api/tasks")
def list_tasks():
    out = []
    for t_idx, bucket in TASKS_BY_INDEX.items():
        eps = bucket["episodes"]
        annotated = sum(1 for ep in eps if is_done(ep["episode_index"]))
        out.append(
            {
                "task_index": t_idx,
                "task": bucket["task"],
                "total_episodes": len(eps),
                "annotated_count": annotated,
            }
        )
    out.sort(key=lambda t: t["task"].lower())
    return out


@app.get("/api/tasks/{task_index}/episodes")
def list_task_episodes(task_index: int):
    bucket = TASKS_BY_INDEX.get(task_index)
    if bucket is None:
        raise HTTPException(404, "task not found")
    out = []
    for i, ep in enumerate(bucket["episodes"]):
        a = read_annotation(ep["episode_index"])
        out.append(
            {
                "position": i + 1,
                "episode_index": ep["episode_index"],
                "length": ep["length"],
                "success": ep.get("success"),
                "annotated": bool(a and a.get("completed")),
                "has_draft": bool(a and not a.get("completed") and a.get("key_events")),
            }
        )
    return out


@app.get("/api/tasks/{task_index}/first-unannotated")
def first_unannotated(task_index: int):
    bucket = TASKS_BY_INDEX.get(task_index)
    if bucket is None:
        raise HTTPException(404, "task not found")
    eps = bucket["episodes"]
    for i, ep in enumerate(eps):
        if not is_done(ep["episode_index"]):
            return {"position": i + 1, "episode_index": ep["episode_index"]}
    return {"position": len(eps), "episode_index": eps[-1]["episode_index"]}


@app.get("/api/episode/{episode_index}")
def get_episode(episode_index: int):
    ep = EPISODE_BY_INDEX.get(episode_index)
    if ep is None:
        raise HTTPException(404, "episode not found")
    t_idx = CANONICAL_TASK_INDEX_BY_EPISODE[episode_index]
    task_name = TASKS_BY_INDEX[t_idx]["task"]
    eps = TASKS_BY_INDEX[t_idx]["episodes"]
    position = next(i + 1 for i, e in enumerate(eps) if e["episode_index"] == episode_index)

    return {
        "episode_index": episode_index,
        "task": task_name,
        "task_index": t_idx,
        "length": ep["length"],
        "fps": FPS,
        "success": ep.get("success"),
        "position": position,
        "total_in_task": len(eps),
        "videos": {camera_key(cam): video_url(episode_index, cam) for cam in CAMERAS},
        "annotation": read_annotation(episode_index),
        "subtask_suggestions": read_vocab(t_idx),
    }


@app.post("/api/episode/{episode_index}/annotations")
def save_annotation(episode_index: int, payload: dict = Body(...)):
    ep = EPISODE_BY_INDEX.get(episode_index)
    if ep is None:
        raise HTTPException(404, "episode not found")
    t_idx = CANONICAL_TASK_INDEX_BY_EPISODE[episode_index]
    task_name = TASKS_BY_INDEX[t_idx]["task"]
    now = datetime.now(timezone.utc).isoformat()

    outcome_override = payload.get("outcome_override")
    if outcome_override not in (None, "success", "fail"):
        raise HTTPException(400, "outcome_override must be 'success', 'fail', or null")

    events = payload.get("key_events", [])
    for ev in events:
        try:
            ev["value"] = max(0.0, min(1.0, float(ev.get("value", 0.5))))
        except (TypeError, ValueError):
            ev["value"] = 0.5

    with _save_lock:
        existing = read_annotation(episode_index)
        data = {
            "episode_index": episode_index,
            "task_index": t_idx,
            "task": task_name,
            "num_frames": ep["length"],
            "fps": FPS,
            "annotator": payload.get("annotator", ""),
            "completed": bool(payload.get("completed", False)),
            "key_events": events,
            "dataset_success": ep.get("success"),
            "outcome_override": outcome_override,
            "created_at": (existing or {}).get("created_at", now),
            "updated_at": now,
        }
        tmp = ann_path(episode_index).with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(ann_path(episode_index))

        used_names = {
            e.get("subtask", "").strip()
            for e in data["key_events"]
            if e.get("subtask", "").strip()
        }
        if used_names:
            current_vocab = set(read_vocab(t_idx))
            if not used_names.issubset(current_vocab):
                write_vocab(t_idx, task_name, current_vocab | used_names)
    return data


@app.get("/api/export/corrected-episodes")
def export_corrected_episodes():
    """Merge every saved outcome_override on top of the dataset's original
    episodes.jsonl. This can't be pushed upstream to the Hugging Face
    dataset (no write access to that repo), so it's offered as a local
    corrected copy instead."""
    out = []
    num_corrected = 0
    for ep in EPISODES:
        ann = read_annotation(ep["episode_index"])
        override = ann.get("outcome_override") if ann else None
        t_idx = CANONICAL_TASK_INDEX_BY_EPISODE[ep["episode_index"]]
        row = {
            "episode_index": ep["episode_index"],
            "task_index": t_idx,
            "task": TASKS_BY_INDEX[t_idx]["task"],
            "dataset_success": ep.get("success"),
            "corrected_success": override,
            "effective_success": override if override is not None else ep.get("success"),
            "corrected_by": (ann or {}).get("annotator") if override else None,
            "corrected_at": (ann or {}).get("updated_at") if override else None,
        }
        if override is not None:
            num_corrected += 1
        out.append(row)
    return {"total_episodes": len(out), "num_corrected": num_corrected, "episodes": out}


@app.delete("/api/episode/{episode_index}/annotations")
def delete_annotation(episode_index: int):
    if EPISODE_BY_INDEX.get(episode_index) is None:
        raise HTTPException(404, "episode not found")
    with _save_lock:
        p = ann_path(episode_index)
        if p.exists():
            p.unlink()
    return {"deleted": True}


@app.delete("/api/tasks/{task_index}/subtask-vocab")
def delete_subtask_vocab_entry(task_index: int, name: str):
    bucket = TASKS_BY_INDEX.get(task_index)
    if bucket is None:
        raise HTTPException(404, "task not found")
    with _save_lock:
        current = read_vocab(task_index)
        remaining = [n for n in current if n != name]
        if len(remaining) == len(current):
            raise HTTPException(404, "subtask name not found in this task's vocab")
        # Always write (even an empty list) rather than deleting the file —
        # the file's mere existence is what tells _sync_vocab_with_annotations
        # this task has already been synced/curated, so it won't get
        # rebuilt from scratch (resurrecting this deletion) on next startup.
        write_vocab(task_index, bucket["task"], set(remaining))
    return {"deleted": True, "subtasks": remaining}


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=_CLI_ARGS.host, port=_CLI_ARGS.port)
