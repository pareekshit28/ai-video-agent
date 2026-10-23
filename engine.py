"""Sequential job lifecycle; every render requires an explicit clip approval."""
import asyncio
import copy
import json
from pathlib import Path
import shutil
import time
from urllib.parse import quote

import aiohttp

from . import core, media as video_media, timing


class Engine:
    def __init__(self, store, input_dir, output_dir):
        self.store, self.input_dir, self.output_dir = store, Path(input_dir), Path(output_dir).resolve()
        self.locks, self.tasks = {}, {}
        self.submit_lock = asyncio.Lock()

    def lock(self, scene_id):
        return self.locks.setdefault(scene_id, asyncio.Lock())

    async def http(self, method, url, **kwargs):
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=90)) as session:
            async with session.request(method, url, allow_redirects=False, **kwargs) as response:
                if response.status >= 300:
                    raise ValueError(f"ComfyUI returned HTTP {response.status}")
                return await response.json()

    def prepare_following(self, scene, clip, base_url):
        # ChatGPT supplied every prompt already. Only the frame binding changes.
        for following in scene["clips"]:
            if not following.get("takeId") and following["status"] not in core.ACTIVE:
                following["promptContext"] = core.prompt_context(self.store, scene, following)
                following.pop("approvedKey", None)
        self.store.save_scene(scene)

    async def submit(self, scene, clip, base_url):
        async with self.submit_lock:
            if any(c["status"] in core.ACTIVE for p in self.store.projects() for s in self.store.scenes(p["id"]) for c in s["clips"]):
                raise ValueError("Finish or recover the current job before approving another render")
            core.ensure_ready(self.store, scene, clip)
            reviewed_key = core.approval_key(self.store, scene, clip)
            take_id, prompt_id = core.uid(), str(__import__("uuid").uuid4())
            core.settings(scene["settings"])  # Reject saved scenes from any unsupported renderer.
            body = core.build_h3(self.store, scene, clip, self.input_dir, take_id)
            import nodes
            missing = sorted({n["class_type"] for n in body.values()} - set(nodes.NODE_CLASS_MAPPINGS))
            if missing:
                raise ValueError("Update ComfyUI; missing nodes: " + ", ".join(missing))
            # Validate before archiving a prior take or reserving submission.
            import execution
            validation = await execution.validate_prompt(prompt_id, body, None)
            if not validation[0]:
                raise ValueError("ComfyUI rejected workflow: " + json.dumps({"error": validation[1], "nodes": validation[3]}, ensure_ascii=False)[:3000])
            frame_reference = copy.deepcopy(core.previous_frame(scene, clip))
            core.archive_take(clip)
            clip.update(takeId=take_id, status="submitting", approvedKey=reviewed_key, submittedPrompt=core.final_prompt(scene, clip),
                        submittedSettings=copy.deepcopy(scene["settings"]), submittedReferences=copy.deepcopy(core.selected(scene, clip)), submittedFrame=frame_reference, jobId=prompt_id,
                        timing={"submittedAt": time.time()})
            scene["paused"] = False
            self.store.save_scene(scene)  # Durable reservation BEFORE the only submit attempt.
            request_path = self.store.scene_dir(scene["projectId"], scene["id"]) + f"/requests/{take_id}.json"
            self.store.write(request_path, {"provider": "h3", "request": body, "takeId": take_id})
            try:
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=90)) as session:
                    async with session.post(base_url + "/prompt", json={"prompt": body, "prompt_id": prompt_id, "client_id": "ai-video-agent"}, allow_redirects=False) as response:
                        if 400 <= response.status < 500 and response.status != 408:
                            clip.update(status="failed", error=f"Submission rejected (HTTP {response.status}); no automatic retry.")
                            clip["timing"]["failedAt"] = time.time()
                        elif response.status != 200:
                            clip.update(status="submission-unknown", error="Submission response uncertain. Recover the existing job; do not submit again.")
                        else:
                            result = await response.json()
                            job_id = result.get("prompt_id")
                            clip.update(jobId=core.identifier(job_id), status="queued")
                            clip["timing"]["queuedAt"] = time.time()
            except Exception:
                clip.update(status="submission-unknown", error="Submission response lost. Check the existing job ID or recover it before another render.")
            self.store.save_scene(scene)
            self.watch(scene["projectId"], scene["id"], base_url)

    def watch(self, project_id, scene_id, base_url):
        if scene_id not in self.tasks or self.tasks[scene_id].done():
            self.tasks[scene_id] = asyncio.create_task(self.monitor(project_id, scene_id, base_url))

    async def monitor(self, project_id, scene_id, base_url):
        try:
            while True:
                async with self.lock(scene_id):
                    scene = self.store.scene(project_id, scene_id)
                    clip = next((c for c in scene["clips"] if c["status"] in core.ACTIVE), None)
                    if not clip or scene.get("paused"):
                        return
                    if clip["status"] in ("submission-unknown", "submitting", "recoverable"):
                        return
                    try:
                        await self.check(scene, clip, base_url)
                        self.store.save_scene(scene)
                    except Exception as error:
                        clip.update(status="recoverable", error=str(error))
                        scene["paused"] = True
                        self.store.save_scene(scene)
                        return
                    if clip["status"] == "complete":
                        scene["paused"] = True
                        self.prepare_following(scene, clip, base_url)
                        return  # Never implicitly approve another clip.
                    if clip["status"] == "failed":
                        return
                await asyncio.sleep(5)
        except asyncio.CancelledError:
            raise

    async def check(self, scene, clip, base_url):
        if clip["submittedSettings"]["provider"] != "h3":
            raise ValueError("This saved job uses an unsupported renderer. Its files are retained; use an H3 scene.")
        if not clip.get("source"):
            job_id = core.identifier(clip["jobId"])
            history = await self.http("GET", base_url + "/history/" + quote(job_id))
            record = history.get(job_id)
            if not record:
                queue = await self.http("GET", base_url + "/queue")
                running = any(row[1] == job_id for row in queue.get("queue_running", []))
                pending = any(row[1] == job_id for row in queue.get("queue_pending", []))
                if not (running or pending):
                    # Comfy history is in memory. A pod restart can lose history while
                    # leaving SaveVideo's unique take output on the mounted volume.
                    directory = self.output_dir / "ai_video_agent/raw" / clip.get("storageSceneId", scene["id"])
                    candidates = [p for p in directory.glob(f"{clip.get('storageClipId', clip['id'])}-{clip['takeId']}_*") if p.suffix.lower() in (".mp4", ".webm", ".mov") and p.is_file()]
                    if len(candidates) != 1:
                        raise ValueError("Job is absent from queue/history and no unique saved take output was found. Recover the existing job ID; no resubmission occurred.")
                    saved = candidates[0]
                    record = {"outputs": {"92": {"videos": [{"filename": saved.name, "subfolder": str(saved.parent.relative_to(self.output_dir)), "type": "output"}]}}}
                else:
                    clip["status"] = "rendering" if running else "queued"
                    clock = clip.setdefault("timing", {})
                    if running:
                        clock.setdefault("renderStartedAt", time.time())
                        clock.pop("queuePosition", None)
                        timing.observe_progress(clip)
                    else:
                        clock["queuePosition"] = next(i + 1 for i, row in enumerate(queue.get("queue_pending", [])) if row[1] == job_id)
                    return
            timing.history_times(clip, record)
            if record.get("status", {}).get("status_str") == "error":
                clip.update(status="failed", error="ComfyUI execution failed. Inspect its queue error, then explicitly regenerate.")
                clip.setdefault("timing", {})["failedAt"] = time.time()
                return
            files = []
            for output in record.get("outputs", {}).values():
                for key in ("videos", "gifs", "images"):
                    files.extend(f for f in output.get(key, []) if Path(f.get("filename", "")).suffix.lower() in (".mp4", ".webm", ".mov"))
            if not files:
                raise ValueError("Completed workflow has no saved video in history")
            file = files[0]
            if file.get("type", "output") != "output":
                raise ValueError("Expected a saved output video")
            source = (self.output_dir / file.get("subfolder", "") / file["filename"]).resolve()
            if not source.is_relative_to(self.output_dir) or not source.is_file():
                raise ValueError("Saved ComfyUI output is missing or outside the output directory")
            relative = self.store.scene_dir(scene["projectId"], scene["id"]) + f"/clips/{clip['id']}-{clip['takeId']}.source{source.suffix}"
            self.store.path(relative).parent.mkdir(parents=True, exist_ok=True)
            await asyncio.to_thread(shutil.copyfile, source, self.store.path(relative))
            clip["source"] = {"path": relative, "name": source.name}
        clip["status"] = "saving"
        clock = clip.setdefault("timing", {})
        clock.setdefault("renderFinishedAt", time.time())
        clock.setdefault("savingStartedAt", time.time())
        clock.pop("queuePosition", None)
        self.store.save_scene(scene)
        clip.update(await asyncio.to_thread(video_media.finalize, self.store, scene, clip))
        clock["completedAt"] = time.time()
        clip.pop("error", None)
