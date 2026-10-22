"""Same-origin ComfyUI workspace API. Credentials stay in server environment variables."""
import asyncio
import copy
from contextlib import AsyncExitStack
import json
import os
from pathlib import Path
import shutil

from aiohttp import web
import folder_paths
from server import PromptServer

from . import core, media, qwen, local_qwen
from .engine import Engine
from .http_contract import origin_is_allowed

_engine = None


def engine():
    global _engine
    if _engine is None:
        root = os.getenv("AVA_STORAGE_DIR", str(Path(folder_paths.get_output_directory()) / "ai_video_agent"))
        _engine = Engine(core.Store(root), folder_paths.get_input_directory(), folder_paths.get_output_directory())
    return _engine


def base_url(request):
    # Use the actual listening socket, never the caller's Host header for loopback calls.
    port = request.transport.get_extra_info("sockname")[1]
    return os.getenv("AVA_COMFY_URL", f"http://127.0.0.1:{port}").rstrip("/")


def origin_guard(request):
    if not origin_is_allowed(request.headers, request.host, os.getenv("AVA_PUBLIC_ORIGIN", "")):
        raise web.HTTPForbidden(text="Request origin was rejected. Open the workspace from your ComfyUI URL. If the proxy removes browser origin metadata, set AVA_PUBLIC_ORIGIN to that public URL and restart ComfyUI.")


def find_clip(scene, clip_id):
    return next(c for c in scene["clips"] if c["id"] == core.identifier(clip_id))


def check_mutable(scene, clip=None):
    if any(c["status"] in core.ACTIVE for c in ([clip] if clip else scene["clips"])):
        raise ValueError("This job is active or needs recovery. Pause/resume or recover it first.")


def errors(handler):
    async def wrapped(request):
        try:
            return await handler(request)
        except web.HTTPException as error:
            if error.status < 400:
                raise
            return web.json_response({"error": error.text or error.reason}, status=error.status)
        except FileNotFoundError:
            return web.json_response({"error": "Saved project, scene or media file was not found"}, status=404)
        except (ValueError, KeyError, TypeError, StopIteration) as error:
            return web.json_response({"error": str(error) or "Invalid request"}, status=400)
        except Exception:
            import logging
            logging.exception("AI Video Agent request failed")
            return web.json_response({"error": "Operation failed. Check the ComfyUI server log; saved takes are retained."}, status=500)
    return wrapped


@PromptServer.instance.routes.get("/ava-agent/state")
@errors
async def state(request):
    eng = engine()
    projects = eng.store.projects()
    project_id = request.query.get("projectId")
    project = next((p for p in projects if p["id"] == project_id), None)
    episodes, scenes, videos = [], [], []
    episode_id = ""
    if project:
        episodes = project["episodes"]
        requested_episode = request.query.get("episodeId")
        episode_id = requested_episode if any(e["id"] == requested_episode for e in episodes) else episodes[0]["id"] if episodes else ""
        all_scenes = eng.store.scenes(project_id)
        scenes = [s for s in all_scenes if s["episodeId"] == episode_id]
        episode_names = {e["id"]: e["name"] for e in episodes}
        for saved in all_scenes:
            for clip in saved["clips"]:
                for take in [clip, *clip.get("versions", [])]:
                    if take.get("video"):
                        videos.append({k: take.get(k) for k in ("id", "title", "video", "duration", "actualDuration", "timing")} | {"sceneName": saved["name"], "episodeName": episode_names.get(saved["episodeId"], "Episode 1")})
    # Restore monitoring after a server restart, but never resubmit a job.
    for watched_project in projects:
        for watched_scene in eng.store.scenes(watched_project["id"]):
            if not watched_scene.get("paused") and any(c["status"] in core.ACTIVE for c in watched_scene["clips"]):
                eng.watch(watched_project["id"], watched_scene["id"], base_url(request))
    summaries = [{k: p[k] for k in ("id", "name", "createdAt")} for p in projects]
    return web.json_response({"projects": summaries, "project": project, "episodes": episodes, "selectedEpisodeId": episode_id, "scenes": scenes, "videos": videos,
                              "qwen": qwen.config(eng.store, project_id if project else None), "storage": str(eng.store.root)})


@PromptServer.instance.routes.get("/ava-agent/health")
@errors
async def health(request):
    import nodes
    eng = engine()
    template = json.loads((Path(__file__).parent / "templates/h3-api.json").read_text())
    missing = sorted(({n["class_type"] for n in template.values()} | {"MiniMaxH3AddGuide"}) - set(nodes.NODE_CLASS_MAPPINGS))
    required = {"diffusion_models": [template["127"]["inputs"]["unet_name"]], "text_encoders": [template["128"]["inputs"]["clip_name"]],
                "vae": [template["119"]["inputs"]["vae_name"], template["120"]["inputs"]["vae_name"]]}
    conf = qwen.validate_config(qwen.config(eng.store, request.query.get("projectId")))
    required["text_encoders"].append(conf["model"])
    missing_models = [name for kind, names in required.items() for name in names if name not in folder_paths.get_filename_list(kind)]
    result = {"missingNodes": missing, "missingModels": missing_models, "ffmpeg": bool(shutil.which(os.getenv("FFMPEG_PATH", "ffmpeg"))),
              "ffprobe": bool(shutil.which(os.getenv("FFPROBE_PATH", "ffprobe"))), "qwen": conf,
              "plannerInstalled": conf["model"] in folder_paths.get_filename_list("text_encoders"), "plannerDownload": local_qwen.MODEL_URL}
    return web.json_response(result)


@PromptServer.instance.routes.post("/ava-agent/action")
@errors
async def action(request):
    origin_guard(request)
    if request.content_type != "application/json":
        raise ValueError("Expected application/json")
    raw = bytearray()
    async for chunk in request.content.iter_chunked(65536):
        raw.extend(chunk)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("Request too large")
    body = json.loads(raw)
    eng = engine()
    store = eng.store
    command = body["action"]
    if command == "createProject":
        return web.json_response({"project": store.create_project(body.get("name"))})
    if not body.get("projectId"):
        raise ValueError("Select a project first")
    project_id = core.identifier(body["projectId"])
    async with eng.lock(project_id):
        project = store.project(project_id)
        if command == "qwenConfig":
            store.write(f"projects/{project_id}/qwen.json", qwen.validate_config(body["config"]))
            return web.json_response({"ok": True})
        if command == "renameProject":
            project["name"] = core.text(body["name"], 120)
            store.write(f"projects/{project_id}/project.json", project)
            return web.json_response({"ok": True})
        if command == "deleteProject":
            async with AsyncExitStack() as stack:
                for scene in sorted(store.scenes(project_id), key=lambda s: s["id"]):
                    await stack.enter_async_context(eng.lock(scene["id"]))
                store.trash_project(project_id)
            return web.json_response({"ok": True})
        if command == "createScene":
            return web.json_response({"scene": store.create_scene(project_id, body.get("name"), body.get("script", ""), body.get("episodeId"))})
        if command == "createEpisode":
            return web.json_response({"episode": store.create_episode(project_id, body.get("name"))})
        if command == "deleteEpisode":
            episode_id = core.identifier(body.get("episodeId"))
            async with AsyncExitStack() as stack:
                for scene in sorted(store.scenes(project_id, episode_id), key=lambda s: s["id"]):
                    await stack.enter_async_context(eng.lock(scene["id"]))
                store.trash_episode(project_id, episode_id)
            return web.json_response({"ok": True})
        if command == "renameEpisode":
            episode = store.episode(project_id, body["episodeId"])
            next(e for e in project["episodes"] if e["id"] == episode["id"])["name"] = core.text(body["name"], 150)
            store.write(f"projects/{project_id}/project.json", project)
            return web.json_response({"ok": True})
        if command in ("createLibrary", "cloneLibrary", "removeLibrary"):
            if command == "createLibrary":
                if body["kind"] not in ("character", "location", "prop"):
                    raise ValueError("Invalid library kind")
                project["library"].append({"id": core.uid(), "name": core.text(body["name"], 120), "kind": body["kind"], "description": core.text(body.get("description") or body["name"], 1000), "assets": []})
            else:
                item = next(r for r in project["library"] if r["id"] == body["referenceId"])
                if command == "cloneLibrary":
                    project["library"].append({**copy.deepcopy(item), "id": core.uid(), "name": (item["name"] + " (copy)")[:120]})
                else:
                    project["library"].remove(item)  # Media stays for scene/take recovery.
            store.write(f"projects/{project_id}/project.json", project)
            return web.json_response({"ok": True})
        scene_id = core.identifier(body["sceneId"])
        async with eng.lock(scene_id):
            scene = store.scene(project_id, scene_id, body.get("episodeId"))
            if command == "renameScene":
                scene.update(name=core.text(body["name"], 150), autoName=False)
                store.save_scene(scene)
                return web.json_response({"ok": True})
            if command == "deleteScene":
                store.trash_scene(project_id, scene_id, core.identifier(body.get("episodeId")))
                return web.json_response({"ok": True})
            core.settings(scene["settings"])
            clip = find_clip(scene, body["clipId"]) if body.get("clipId") else None
            base = base_url(request)
            if command == "saveScene":
                new_settings = core.settings(body["settings"])
                script = core.text(body["script"])
                if any(c.get("takeId") for c in scene["clips"]) and script != scene["script"]:
                    raise ValueError("Create a new scene to change its script after submitting takes")
                if script != scene["script"] and scene["clips"]:
                    scene["clips"] = []
                scene.update(name=core.text(body["name"], 150), script=script, settings=new_settings)
            elif command == "identify":
                check_mutable(scene)
                await eng.discover(scene, base)
            elif command == "plan":
                check_mutable(scene)
                await eng.plan(scene, base)
            elif command == "addLibraryReference":
                check_mutable(scene)
                item = next(r for r in project["library"] if r["id"] == body["referenceId"])
                ref = next((r for r in scene["references"] if r["id"] == body.get("slotId")), None)
                if ref:
                    ref["assets"] = copy.deepcopy(item["assets"])
                elif len(scene["references"]) < 40:
                    scene["references"].append({**copy.deepcopy(item), "id": core.uid()})
                else:
                    raise ValueError("At most 40 reference slots")
            elif command == "createReference":
                check_mutable(scene)
                if len(scene["references"]) >= 40 or body["kind"] not in ("character", "location", "prop"):
                    raise ValueError("Invalid reference kind or too many slots")
                scene["references"].append({"id": core.uid(), "name": core.text(body["name"], 120), "kind": body["kind"], "description": core.text(body.get("description") or body["name"], 1000), "assets": []})
            elif command == "removeAsset":
                check_mutable(scene)
                ref = next(r for r in scene["references"] if r["id"] == body["referenceId"])
                ref["assets"] = [a for a in ref["assets"] if a["path"] != body["path"]]
            elif command == "saveClip":
                check_mutable(scene, clip)
                prompt = body["prompt"].strip() if isinstance(body["prompt"], str) else None
                if prompt or not core.previous(scene, clip):
                    prompt = core.text(prompt, 12000)
                elif prompt is None:
                    raise ValueError("Prompt must be text")
                if core.TAGS.search(prompt):
                    raise ValueError("Use names in prompts; media tags are assigned to actual uploads automatically")
                refs = body["referenceIds"]
                if not isinstance(refs, list) or len(refs) != len(set(refs)) or not set(refs) <= {r["id"] for r in scene["references"] if r.get("assets")}:
                    raise ValueError("Select only supplied references")
                if body["continuityMode"] not in ("auto", "on", "off"):
                    raise ValueError("Invalid continuity mode")
                if not core.previous(scene, clip) and body["continuityMode"] == "on":
                    raise ValueError("The first clip has no preceding frame")
                clip.update(prompt=prompt, referenceIds=refs, continuityMode=body["continuityMode"])
                # Manual prompts are valid for the first clip. Following clips must first be grounded by Qwen.
                if not core.previous(scene, clip):
                    clip["promptContext"] = core.prompt_context(store, scene, clip)
                clip.pop("approvedKey", None)
            elif command == "setDuration":
                value = core.duration(body["duration"])
                clip["nextDuration" if clip.get("takeId") else "duration"] = value
                clip.pop("approvedKey", None)
                clip.pop("promptContext", None)
            elif command in ("planPrompt", "revisePrompt"):
                check_mutable(scene, clip)
                await eng.plan_prompt(scene, clip, base, body.get("comments", ""))
            elif command == "approveGenerate":
                check_mutable(scene, clip)
                # Require the exact latest saved draft that was visible when approval was clicked.
                if body.get("reviewKey") != core.approval_key(store, scene, clip):
                    raise ValueError("The saved clip changed. Refresh, review it, and approve again.")
                await eng.submit(scene, clip, base)
            elif command == "manualClip":
                check_mutable(scene)
                if scene["clips"]:
                    raise ValueError("Use a new scene for Video Studio")
                clip = {"id": core.uid(), "title": "Studio clip", "duration": core.duration(body["duration"]),
                        "prompt": core.text(body["prompt"], 12000), "outline": body["prompt"], "referenceIds": [r["id"] for r in scene["references"] if r.get("assets")],
                        "transition": "first", "continuityMode": "off", "status": "awaiting-approval", "versions": []}
                scene["clips"] = [clip]
                clip["promptContext"] = core.prompt_context(store, scene, clip)
            elif command == "pause":
                scene["paused"] = True  # Remote/native running work continues; no global queue interruption.
            elif command == "resume":
                if not clip or not clip.get("jobId"):
                    raise ValueError("Recover a known job ID first")
                clip.update(status="saving" if clip.get("source") else "queued")
                clip.pop("error", None)
                scene["paused"] = False
            elif command == "recover":
                if clip["status"] not in core.ACTIVE or not clip.get("submittedSettings"):
                    raise ValueError("Only an unresolved submitted job can be recovered")
                clip.update(jobId=core.identifier(body["jobId"]), status="queued")
                scene["paused"] = False
            elif command == "acknowledgeMissingJob":
                if clip["status"] not in core.ACTIVE or body.get("confirmed") is not True:
                    raise ValueError("Explicitly confirm the old job was checked and cannot produce another result")
                clip.update(status="failed", error="User reviewed the ComfyUI queue and released the unresolved submission")
                scene["paused"] = True
            elif command == "restoreFrame":
                if clip["status"] != "complete" or not clip.get("extractedFrame"):
                    raise ValueError("No extracted frame to restore")
                clip["frame"] = copy.deepcopy(clip["extractedFrame"])
                core.invalidate_following(scene, clip)
            elif command == "exportGraph":
                core.ensure_ready(store, scene, clip)
                return web.json_response({"graph": core.build_h3(store, scene, clip, eng.input_dir, core.uid())})
            else:
                raise ValueError("Unknown action")
            store.save_scene(scene)
            if command in ("resume", "recover"):
                eng.watch(project_id, scene_id, base)
            return web.json_response({"scene": public_scene(eng, scene)})


def public_scene(eng, scene):
    from . import timing
    result = copy.deepcopy(scene)
    for clip in result["clips"]:
        clip["timing"] = timing.public(clip)
        try:
            core.ensure_ready(eng.store, scene, clip)
            clip["reviewKey"] = core.approval_key(eng.store, scene, clip)
        except (ValueError, FileNotFoundError):
            clip["reviewKey"] = None
    return result


@PromptServer.instance.routes.get("/ava-agent/scene")
@errors
async def get_scene(request):
    eng = engine()
    return web.json_response(public_scene(eng, eng.store.scene(request.query["projectId"], request.query["sceneId"], request.query.get("episodeId"))))


@PromptServer.instance.routes.post("/ava-agent/upload")
@errors
async def upload(request):
    origin_guard(request)
    eng = engine()
    project_id, scene_id = core.identifier(request.query["projectId"]), request.query.get("sceneId")
    async with eng.lock(project_id):
        async with eng.lock(scene_id or "library-" + project_id):
            project = eng.store.project(project_id)
            scene = eng.store.scene(project_id, scene_id, request.query.get("episodeId")) if scene_id else None
            frame_clip = find_clip(scene, request.query["clipId"]) if request.query.get("clipId") else None
            if frame_clip:
                if frame_clip["status"] != "complete":
                    raise ValueError("Complete this clip before replacing its last frame")
                ref = None
            else:
                if scene:
                    check_mutable(scene)
                ref = next(r for r in (scene["references"] if scene else project["library"]) if r["id"] == request.query["referenceId"])
                if len(ref["assets"]) >= 12:
                    raise ValueError("At most 12 files per reference slot")
            reader = await request.multipart()
            part = await reader.next()
            if not part or not part.filename:
                raise ValueError("Choose a reference file")
            suffix = Path(part.filename).suffix.lower()
            kind = "image" if suffix in (".png", ".jpg", ".jpeg", ".webp") else "audio" if suffix in (".wav", ".mp3", ".m4a", ".flac", ".ogg") else None
            if not kind or (frame_clip and kind != "image"):
                raise ValueError("Unsupported reference format")
            chunks, size = [], 0
            while chunk := await part.read_chunk():
                size += len(chunk)
                if size > 20 * 1024 * 1024:
                    raise ValueError("Reference files must be at most 20 MiB")
                chunks.append(chunk)
            if not size:
                raise ValueError("Reference is empty")
            directory = eng.store.scene_dir(project_id, scene_id) if scene else f"projects/{project_id}/library"
            relative = directory + "/references/" + core.uid() + suffix
            target = eng.store.path(relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"".join(chunks))
            asset = {"path": relative, "name": Path(part.filename).name, "kind": kind, "bytes": size}
            if kind == "image":
                from PIL import Image
                with Image.open(target) as image:
                    image.verify()
            else:
                data = await asyncio.to_thread(media.probe, target)
                length = float(data.get("format", {}).get("duration", 0))
                if not any(s["codec_type"] == "audio" for s in data.get("streams", [])) or not 0.25 <= length <= 15:
                    raise ValueError("Voice samples must contain 0.25–15 seconds of audio")
                asset["duration"] = length
            if frame_clip:
                frame_clip["frame"] = asset
                core.invalidate_following(scene, frame_clip)
            else:
                ref["assets"].append(asset)
            if scene:
                eng.store.save_scene(scene)
            else:
                eng.store.write(f"projects/{project_id}/project.json", project)
            return web.json_response({"asset": asset})


@PromptServer.instance.routes.get("/ava-agent/media")
@errors
async def get_media(request):
    relative = request.query["path"]
    if not relative.startswith("projects/") or Path(relative).suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov", ".wav", ".mp3", ".m4a", ".flac", ".ogg"):
        raise ValueError("Unsupported media path")
    return web.FileResponse(engine().store.path(relative), headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
