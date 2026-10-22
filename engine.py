"""Sequential job lifecycle; every render requires an explicit clip approval."""
import asyncio
import copy
import json
from pathlib import Path
import shutil
import time
from urllib.parse import quote

import aiohttp

from . import core, media as video_media, planner, timing, codex_bridge


class Engine:
    def __init__(self, store, input_dir, output_dir):
        self.store, self.input_dir, self.output_dir = store, Path(input_dir), Path(output_dir).resolve()
        self.locks, self.tasks = {}, {}
        self.planning_tasks = {}
        self.submit_lock = asyncio.Lock()
        self.planner_lock = asyncio.Lock()
        self.bridge = codex_bridge.get_bridge(store)

    def lock(self, scene_id):
        return self.locks.setdefault(scene_id, asyncio.Lock())

    def planning_status(self, scene):
        job = scene.get("planning", {})
        if job.get("status") == "running" and scene["id"] not in self.planning_tasks:
            job.update(status="failed", finishedAt=time.time(), error="Codex planning was interrupted by a ComfyUI restart. Retry the planning action.")
            self.store.save_scene(scene)
        return job

    def start_planning(self, scene, command, base, clip_id=None, comments="", request_id=None, automatic=False):
        """Called under the scene lock. Persist acceptance before returning HTTP 202."""
        if command not in ("identify", "plan", "planPrompt", "revisePrompt"):
            raise ValueError("Unknown planning action")
        request_id = core.identifier(request_id) if request_id else core.uid()
        previous = self.planning_status(scene)
        inputs = {"action": command, "clipId": clip_id, "comments": comments}
        if previous.get("id") == request_id:
            if previous.get("inputs") != inputs:
                raise ValueError("This planning request ID was already used for different inputs")
            return previous
        if previous.get("status") == "running" and previous.get("inputs") == inputs:
            return previous
        core.ensure_not_planning(scene)
        if command in ("planPrompt", "revisePrompt"):
            clip = next(c for c in scene["clips"] if c["id"] == clip_id)
            prior = core.previous(scene, clip)
            if prior and (prior["status"] != "complete" or not prior.get("frame")):
                raise ValueError("Complete the preceding clip first; its real final frame is required")
        if any(c["status"] in core.ACTIVE for c in scene["clips"]):
            raise ValueError("Finish or recover this scene's active render before Codex planning")
        job = {"id": request_id, "status": "running", "startedAt": time.time(), "inputs": inputs, "automatic": automatic}
        scene["planning"] = job
        self.store.save_scene(scene)
        self.planning_tasks[scene["id"]] = asyncio.create_task(self._run_planning(copy.deepcopy(scene), base))
        return job

    async def _run_planning(self, scene, base):
        job = scene["planning"]
        try:
            inputs = job["inputs"]
            if inputs["action"] == "identify":
                await self.discover(scene, base)
            elif inputs["action"] == "plan":
                await self.plan(scene, base)
            else:
                clip = next(c for c in scene["clips"] if c["id"] == inputs["clipId"])
                await self.plan_prompt(scene, clip, base, inputs["comments"])
                if clip.get("error", "").startswith("Prompt planning needs retry:"):
                    clip.pop("error", None)
            job["status"] = "complete"
        except asyncio.CancelledError:
            job.update(status="failed", error="Codex planning was interrupted. Restart ComfyUI before retrying.")
            raise
        except (ValueError, KeyError, TypeError, StopIteration) as error:
            job.update(status="failed", error=str(error) or "Invalid planning request")
        except Exception:
            import logging
            logging.exception("AI Video Agent background Codex planning failed")
            job.update(status="failed", error="Codex planning failed. Check the ComfyUI server log.")
        finally:
            job["finishedAt"] = time.time()
            try:
                async with self.lock(scene["id"]):
                    saved = self.store.scene(scene["projectId"], scene["id"])
                    if saved.get("planning", {}).get("id") == job["id"]:
                        # A failed run must not replace the prior plan, drafts or takes.
                        if job["status"] == "complete":
                            self.store.save_scene(scene)
                        else:
                            saved["planning"] = job
                            if job.get("automatic") and job["inputs"].get("clipId"):
                                following = next(c for c in saved["clips"] if c["id"] == job["inputs"]["clipId"])
                                following["error"] = "Prompt planning needs retry: " + job["error"]
                            self.store.save_scene(saved)
            finally:
                self.planning_tasks.pop(scene["id"], None)

    async def http(self, method, url, **kwargs):
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=90)) as session:
            return await planner.request_json(session, method, url, **kwargs)

    async def ask(self, base_url, instruction, payload, images=(), project_id=None):
        async with self.planner_lock:
            return await planner.ask(self.store, instruction, payload, images, model_file=planner.config(self.store, project_id)["model"])

    async def discover(self, scene, base_url):
        if any(c.get("takeId") for c in scene["clips"]):
            raise ValueError("Create a new scene to rediscover references after rendering takes")
        result = await self.ask(base_url, planner.DISCOVER, {"script": core.text(scene["script"])}, project_id=scene["projectId"])
        references = core.validate_references(result)
        # Retain supplied media for slots with stable IDs.
        existing = {r["id"]: r for r in scene["references"]}
        for ref in references:
            ref["assets"] = existing.get(ref["id"], {}).get("assets", [])
        if scene.get("autoName", True):
            scene["name"] = core.text(result["title"], 150)
        scene.update(summary=core.text(result["summary"], 1500), references=references, clips=[])

    async def plan(self, scene, base_url):
        if any(c.get("takeId") for c in scene["clips"]):
            raise ValueError("Plans with submitted takes are preserved. Create another scene to replan the script.")
        manifest, images = planner.reference_context(self.store, scene)
        result = await self.ask(base_url, planner.PLAN, {"script": core.text(scene["script"]), "suppliedReferences": manifest, "settings": scene["settings"]}, images, project_id=scene["projectId"])
        clips = core.validate_plan(scene, result)
        scene["clips"] = clips
        clips[0]["promptContext"] = core.prompt_context(self.store, scene, clips[0])

    async def plan_prompt(self, scene, clip, base_url, comments=""):
        prior = core.previous(scene, clip)
        if prior and (prior["status"] != "complete" or not prior.get("frame")):
            raise ValueError("Complete the preceding clip first; its real final frame is required")
        manifest, paths = planner.reference_context(self.store, scene, core.selected(scene, clip))
        if prior:
            paths.append(self.store.path(prior["frame"]["path"]))
        result = await self.ask(base_url, planner.PROMPT, {"script": scene["script"], "summary": scene["summary"],
            "references": manifest, "previousFrameAttachment": len(paths) if prior else None,
            "previous": {"prompt": prior.get("submittedPrompt"), "actualDuration": prior.get("actualDuration")} if prior else None,
            "frameGuideEnabled": core.continuation(clip),
            "target": {"outline": clip["outline"], "prompt": clip["prompt"], "duration": clip.get("nextDuration", clip["duration"]),
                       "continuation": core.continuation(clip)}, "settings": scene["settings"], "comments": comments,
            "remainingOutline": [c["outline"] for c in scene["clips"][scene["clips"].index(clip) + 1:]]}, paths, project_id=scene["projectId"])
        prompt = core.text(result["prompt"], 12000)
        if core.TAGS.search(prompt):
            raise ValueError("Codex returned numbered media tags; retry prompt planning")
        clip.update(prompt=prompt, promptContext=core.prompt_context(self.store, scene, clip))
        clip.pop("frameAnalysis", None)
        if prior and isinstance(result.get("frameAnalysis"), str) and result["frameAnalysis"].strip():
            clip["frameAnalysis"] = core.text(result["frameAnalysis"][:4000], 4000)
        clip.pop("approvedKey", None)

    def prepare_following(self, scene, clip, base_url):
        """Persist the finished take, then inspect its frame in a separate planning task."""
        core.invalidate_following(scene, clip)
        self.store.save_scene(scene)
        index = scene["clips"].index(clip)
        if index + 1 < len(scene["clips"]) and not any(c["status"] in core.ACTIVE for c in scene["clips"]):
            following = scene["clips"][index + 1]
            if not following.get("takeId"):
                self.start_planning(scene, "planPrompt", base_url, following["id"], automatic=True)

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
            core.archive_take(clip)
            clip.update(takeId=take_id, status="submitting", approvedKey=reviewed_key, submittedPrompt=core.final_prompt(scene, clip),
                        submittedSettings=copy.deepcopy(scene["settings"]), submittedReferences=copy.deepcopy(core.selected(scene, clip)), jobId=prompt_id,
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
                    directory = self.output_dir / "ai_video_agent/raw" / scene["id"]
                    candidates = [p for p in directory.glob(f"{clip['id']}-{clip['takeId']}_*") if p.suffix.lower() in (".mp4", ".webm", ".mov") and p.is_file()]
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
