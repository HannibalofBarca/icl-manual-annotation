"""Builds manual_icl_demo_dataset_continuous.zip (dense per-frame progress) from
manual_icl_demo_dataset_milestone.zip (sparse key_events per episode), both produced by this
tool's own annotation set.

Interpolation: value holds flat between key events, then eases up to each milestone over a
window of width --window-seconds sitting entirely BEFORE that milestone's own timestamp, using
smootherstep (Ken Perlin's quintic, s^3*(s*(s*6-15)+10)) rather than a logistic sigmoid -- it
lands exactly on the annotated value at the milestone's own timestamp (not just close to it,
the way a sigmoid centered on the milestone only asymptotically approaches it), and has zero
1st and 2nd derivative at both window edges so it blends into the flat holds with no kink in
value, slope, or curvature. See the "Lead-Window Playground" artifact worked out with the user
for the reasoning and the k=2.5s choice.

Output schema matches the previous (wrong, segment-stretched-sigmoid) export's shape --
episode_uid, episode_index, task, success, final_progress, fps, num_frames, points -- so
anything already reading it (see ICVFE Evals/analysis/pipeline.py::load_curve_set, which only
needs episode_uid/task/points[].progress) keeps working unmodified. `interpolation` and
`window_seconds` replace the old `steepness` field.
"""

import argparse
import json
import zipfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).parent
DEFAULT_INPUT = ROOT / "manual_icl_demo_dataset_milestone.zip"
DEFAULT_OUTPUT = ROOT / "manual_icl_demo_dataset_continuous.zip"
DEFAULT_WINDOW_SECONDS = 2.5


def smootherstep(s: np.ndarray) -> np.ndarray:
    return s * s * s * (s * (s * 6 - 15) + 10)


def densify_lead_window(key_events: list[dict], num_frames: int, fps: float, window_seconds: float) -> np.ndarray:
    """One progress value (0-1) per frame, holding flat between events and easing up to each
    one over a window of width `window_seconds` immediately before its own timestamp."""
    sorted_events = sorted(key_events, key=lambda e: e["time"])
    times = np.arange(num_frames, dtype=np.float64) / fps
    values = np.full(num_frames, sorted_events[0]["value"], dtype=np.float64)

    for i in range(1, len(sorted_events)):
        window_end = sorted_events[i]["time"]
        window_start = window_end - window_seconds
        delta = sorted_events[i]["value"] - sorted_events[i - 1]["value"]
        span = window_end - window_start
        if span > 0:
            s = np.clip((times - window_start) / span, 0.0, 1.0)
        else:
            s = (times >= window_end).astype(np.float64)
        values += delta * smootherstep(s)

    return np.clip(values, 0.0, 1.0)


def subtask_at_frame(key_events: list[dict], frame_index: int) -> str:
    """The subtask label for a given frame: the event's own subtask exactly at its anchor
    frame, otherwise the subtask of the next event being worked toward (or the last event's,
    once past it) -- matches the convention already used in the previous export."""
    sorted_events = sorted(key_events, key=lambda e: e["frame"])
    for i, e in enumerate(sorted_events):
        if frame_index == e["frame"]:
            return e["subtask"]
        if frame_index < e["frame"]:
            return e["subtask"]
    return sorted_events[-1]["subtask"]


def effective_success(dataset_success, outcome_override) -> str:
    effective = outcome_override if outcome_override is not None else dataset_success
    if isinstance(effective, str):
        return effective
    return "success" if effective else "fail"


def format_record(record: dict) -> str:
    """Pretty-prints `record` like json.dumps(..., indent=2) except `points`, whose entries
    are each kept on one line -- readable per-timestep without indent=2 exploding every
    {frame_index, timestamp, progress, subtask} onto four lines apiece."""
    points = record["points"]
    header = {k: v for k, v in record.items() if k != "points"}
    lines = ["{"]
    for key, value in header.items():
        lines.append(f"  {json.dumps(key)}: {json.dumps(value)},")
    lines.append('  "points": [')
    for idx, point in enumerate(points):
        comma = "," if idx < len(points) - 1 else ""
        lines.append("    " + json.dumps(point) + comma)
    lines.append("  ]")
    lines.append("}")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="manual_icl_demo_dataset_milestone.zip")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--window-seconds", type=float, default=DEFAULT_WINDOW_SECONDS,
                         help="Width (s) of the lead-in window before each milestone")
    args = parser.parse_args()

    num_written = 0
    num_skipped = 0

    with zipfile.ZipFile(args.input) as zf_in, zipfile.ZipFile(args.output, "w", zipfile.ZIP_DEFLATED) as zf_out:
        names = [n for n in zf_in.namelist() if n.endswith(".json")]
        print(f"Found {len(names)} milestone annotation files in {args.input.name}")

        for i, name in enumerate(names, start=1):
            record = json.loads(zf_in.read(name))
            key_events = record.get("key_events") or []
            if not record.get("completed") or len(key_events) < 1:
                num_skipped += 1
                continue

            episode_uid = record["episode_uid"]
            episode_index = record["episode_index"]
            num_frames = record["num_frames"]
            fps = record["fps"]

            dense = densify_lead_window(key_events, num_frames, fps, args.window_seconds)
            sorted_events = sorted(key_events, key=lambda e: e["time"])
            final_progress = round(sorted_events[-1]["value"], 4)

            dense_points = [
                {
                    "frame_index": f,
                    "timestamp": round(f / fps, 4),
                    "progress": round(float(dense[f]) * 100, 2),
                    "subtask": subtask_at_frame(key_events, f),
                }
                for f in range(num_frames)
            ]

            out_record = {
                "episode_uid": episode_uid,
                "episode_index": episode_index,
                "task": record.get("task"),
                "success": effective_success(record.get("dataset_success"), record.get("outcome_override")),
                "final_progress": final_progress,
                "fps": fps,
                "num_frames": num_frames,
                "interpolation": "lead_window_smootherstep",
                "window_seconds": args.window_seconds,
                "points": dense_points,
            }

            out_name = f"manual_icl_demo_dataset_continuous/{episode_uid.replace(':', '__')}.json"
            zf_out.writestr(out_name, format_record(out_record))
            num_written += 1

            if i % 50 == 0:
                print(f"  {i}/{len(names)} processed...")

    print(f"Wrote {num_written} dense annotation files to {args.output}")
    print(f"  skipped (not completed / no key events): {num_skipped}")


if __name__ == "__main__":
    main()
