"""Verified local H3 video finalization and last-frame extraction."""
import json
import os
from pathlib import Path
import subprocess


def command(args, timeout=600):
    try:
        return subprocess.run(args, capture_output=True, check=True, timeout=timeout,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except FileNotFoundError as error:
        raise ValueError("Install FFmpeg and FFprobe on the ComfyUI server, or set FFMPEG_PATH/FFPROBE_PATH") from error
    except subprocess.CalledProcessError as error:
        raise ValueError("Media processing failed: " + error.stderr.decode(errors="replace")[-1200:]) from error


def probe(path):
    result = command([os.getenv("FFPROBE_PATH", "ffprobe"), "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", str(path)], 30)
    return json.loads(result)


def finalize(store, scene, clip):
    source = store.path(clip["source"]["path"])
    info = probe(source)
    video_stream = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if not video_stream:
        raise ValueError("Output has no video stream; source was retained")
    actual = float(video_stream.get("duration") or info["format"]["duration"])
    if clip["submittedSettings"]["provider"] != "h3":
        raise ValueError("Only local H3 outputs can be finalized by this package")
    seconds = clip["duration"]
    if actual < seconds - 0.07:
        raise ValueError(f"Short output: {actual:.2f}s for {seconds}s requested; source retained")
    base = store.scene_dir(scene["projectId"], scene["id"]) + f"/clips/{clip['id']}-{clip['takeId']}"
    video_path, frame_path = base + ".mp4", base + "-frame.jpg"
    target, frame = store.path(video_path), store.path(frame_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = os.getenv("FFMPEG_PATH", "ffmpeg")
    temporary = target.with_suffix(".part.mp4")
    command([ffmpeg, "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", str(source), "-map", "0:v:0", "-map", "0:a?", "-t", str(seconds), "-vf", "fps=24,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", str(temporary)])
    verified = probe(temporary)
    stream = next(s for s in verified["streams"] if s["codec_type"] == "video")
    saved_duration = float(stream.get("duration") or verified["format"]["duration"])
    numerator, denominator = stream["avg_frame_rate"].split("/")
    if abs(float(numerator) / float(denominator) - 24) > 0.01 or abs(saved_duration - seconds) > 0.08:
        raise ValueError("Saved video failed frame-rate/duration verification; source retained")
    os.replace(temporary, target)
    command([ffmpeg, "-y", "-v", "error", "-sseof", "-2", "-i", str(target), "-an", "-vf", "reverse", "-frames:v", "1", "-q:v", "2", "-update", "1", str(frame)], 60)
    if not frame.is_file() or frame.stat().st_size < 10:
        raise ValueError("Could not extract last decoded frame; source retained")
    return {"video": {"path": video_path, "name": target.name}, "frame": {"path": frame_path, "name": frame.name},
            "extractedFrame": {"path": frame_path, "name": frame.name}, "actualDuration": saved_duration, "status": "complete"}

