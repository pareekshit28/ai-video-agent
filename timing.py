"""Durable take timestamps and estimates learned from comparable local renders."""
import math
from statistics import median
import time


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def estimate(store, scene, clip):
    samples = []
    keys = ("provider", "steps", "megapixels", "aspectRatio", "refImageSize")
    for saved_scene in store.scenes(scene["projectId"]):
        for saved in saved_scene["clips"]:
            for take in [saved, *saved.get("versions", [])]:
                conf, clock = take.get("submittedSettings", {}), take.get("timing", {})
                if take.get("status") != "complete" or take.get("duration") != clip.get("nextDuration", clip["duration"]):
                    continue
                if any(conf.get(k) != scene["settings"].get(k) for k in keys):
                    continue
                start, finish, completed = (clock.get(k) for k in ("renderStartedAt", "renderFinishedAt", "completedAt"))
                if all(number(v) for v in (start, finish, completed)) and start < finish <= completed:
                    samples.append((completed, finish - start, completed - finish))
    recent = sorted(samples, reverse=True)[:10]
    if not recent:
        return {}
    return {"expectedRenderSeconds": median(s[1] for s in recent),
            "expectedSaveSeconds": median(s[2] for s in recent), "estimateSamples": len(recent)}


def history_times(clip, record):
    clock = clip.setdefault("timing", {})
    for event, data in record.get("status", {}).get("messages", []):
        stamp = data.get("timestamp") if isinstance(data, dict) else None
        if number(stamp) and stamp > 0:
            key = {"execution_start": "renderStartedAt", "execution_success": "renderFinishedAt"}.get(event)
            if key:
                clock[key] = stamp / 1000  # ComfyUI history uses Unix milliseconds.


def observe_progress(clip, now=None):
    """Read a snapshot; never register hooks or change Comfy's progress state."""
    now = time.time() if now is None else now
    try:
        from comfy_execution.progress import get_progress_state
        registry = get_progress_state()
        if registry.prompt_id != clip.get("jobId"):
            return
        nodes = dict(registry.nodes)
    except (ImportError, AttributeError, RuntimeError):
        return  # Older builds still have queue/history and learned estimates.
    sampler = dict(nodes.get("125", {}))
    value, total = sampler.get("value"), sampler.get("max")
    if not (number(value) and number(total) and total > 1 and 0 <= value <= total):
        return
    clock = clip.setdefault("timing", {})
    sample = clock.get("sampling", {})
    if sample.get("total") != total or value < sample.get("value", 0):
        sample = {}
    sample.setdefault("firstValue", value)
    sample.setdefault("firstObservedAt", now)
    if sample.get("value") != value:
        sample["observedAt"] = now
    sample.update(value=value, total=total)
    clock["sampling"] = sample


def public(clip, now=None):
    now = time.time() if now is None else now
    clock = clip.get("timing", {})
    status = clip["status"]
    terminal = status in ("complete", "failed")
    end = clock.get("completedAt") or clock.get("failedAt") or now
    result = {**clock, "serverNow": now, "elapsedSeconds": None, "remainingSeconds": None,
              "estimatedCompletionAt": None, "etaKind": None}
    if number(clock.get("submittedAt")):
        result["elapsedSeconds"] = max(0, end - clock["submittedAt"])
    if terminal or status in ("submitting", "queued", "submission-unknown", "recoverable"):
        return result
    if status == "saving" and number(clock.get("savingStartedAt")) and number(clock.get("expectedSaveSeconds")):
        finish = clock["savingStartedAt"] + clock["expectedSaveSeconds"]
    elif status == "rendering" and number(clock.get("renderStartedAt")) and number(clock.get("expectedRenderSeconds")):
        finish = clock["renderStartedAt"] + clock["expectedRenderSeconds"] + clock.get("expectedSaveSeconds", 0)
    else:
        sample = clock.get("sampling", {})
        value, first, total = (sample.get(k) for k in ("value", "firstValue", "total"))
        observed, started = sample.get("observedAt"), sample.get("firstObservedAt")
        if status == "rendering" and all(number(v) for v in (value, first, total, observed, started)) and first < value < total and observed > started and now - observed < 30:
            remaining = (observed - started) / (value - first) * (total - value) - (now - observed)
            if remaining > 0:
                result.update(remainingSeconds=remaining, etaKind="sampling")
        return result
    if finish > now:
        result.update(remainingSeconds=finish - now, estimatedCompletionAt=finish, etaKind="history")
    else:
        result["etaKind"] = "overdue"  # Never promise 0 seconds while work is running.
    return result
