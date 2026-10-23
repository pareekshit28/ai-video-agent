"""Same-origin ComfyUI workspace API. Credentials stay in server environment variables."""
import asyncio
import copy
import json
import os
from pathlib import Path
import shutil

from aiohttp import web
import folder_paths
from server import PromptServer

from . import core, media, h3_prompt
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
    workspace, videos = None, []
    if project:
        async with eng.lock(project_id):
            workspace = eng.store.workspace(project_id)
            project = eng.store.project(project_id)
            workspace["references"] = [copy.deepcopy(r) for r in project["library"] if r["kind"] != "last-frame"]
            for clip in workspace["clips"]:
                for take in [clip, *clip.get("versions", [])]:
                    if take.get("video"):
                        videos.append({k: take.get(k) for k in ("id", "title", "video", "duration", "actualDuration", "timing", "sceneName")})
    # Restore monitoring after a server restart, never resubmit a render.
    for watched_project in projects:
        for watched_scene in eng.store.scenes(watched_project["id"]):
            if not watched_scene.get("paused") and any(c["status"] in core.ACTIVE for c in watched_scene["clips"]):
                eng.watch(watched_project["id"], watched_scene["id"], base_url(request))
    summaries = [{k: p[k] for k in ("id", "name", "createdAt")} for p in projects]
    return web.json_response({"projects": summaries, "project": project, "workspace": public_scene(eng, workspace) if workspace else None,
                              "videos": videos, "storage": str(eng.store.root)}, headers={"Cache-Control": "no-store"})


@PromptServer.instance.routes.get("/ava-agent/health")
@errors
async def health(request):
    import nodes
    eng = engine()
    template = json.loads((Path(__file__).parent / "templates/h3-api.json").read_text())
    missing = sorted(({n["class_type"] for n in template.values()} | {"MiniMaxH3AddGuide"}) - set(nodes.NODE_CLASS_MAPPINGS))
    required = {"diffusion_models": [template["127"]["inputs"]["unet_name"]], "text_encoders": [template["128"]["inputs"]["clip_name"]],
                "vae": [template["119"]["inputs"]["vae_name"], template["120"]["inputs"]["vae_name"]]}
    missing_models = [name for kind, names in required.items() for name in names if name not in folder_paths.get_filename_list(kind)]
    result = {"missingNodes": missing, "missingModels": missing_models, "ffmpeg": bool(shutil.which(os.getenv("FFMPEG_PATH", "ffmpeg"))),
              "ffprobe": bool(shutil.which(os.getenv("FFPROBE_PATH", "ffprobe")))}
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
    if not isinstance(body, dict):
        raise ValueError("Expected a JSON object")
    eng = engine()
    store = eng.store
    command = body["action"]
    if command == "createProject":
        return web.json_response({"project": store.create_project(body.get("name"))})
    project_id = core.identifier(body.get("projectId"))
    async with eng.lock(project_id):
        scene = store.workspace(project_id)
        async with eng.lock(scene["id"]):
            project = store.project(project_id)
            scene["references"] = [copy.deepcopy(r) for r in project["library"] if r["kind"] != "last-frame"]
            if command == "renameProject":
                project["name"] = core.text(body["name"], 120)
                scene["name"] = project["name"]
                store.write(f"projects/{project_id}/project.json", project)
            elif command == "deleteProject":
                store.trash_project(project_id)
                return web.json_response({"ok": True})
            elif command in ("createLibrary", "cloneLibrary", "removeLibrary"):
                if command == "createLibrary":
                    if body["kind"] not in ("character", "location", "prop"):
                        raise ValueError("Invalid reference kind")
                    project["library"].append({"id": core.uid(), "name": core.text(body["name"], 120), "kind": body["kind"],
                        "description": core.text(body.get("description") or body["name"], 1000), "assets": []})
                else:
                    item = next(r for r in project["library"] if r["id"] == body["referenceId"])
                    if item["kind"] == "last-frame":
                        raise ValueError("Last frames are retained with their rendered takes")
                    check_mutable(scene)
                    if command == "cloneLibrary":
                        project["library"].append({**copy.deepcopy(item), "id": core.uid(), "name": (item["name"] + " (copy)")[:120]})
                    else:
                        if any(item["id"] in c["referenceIds"] for c in scene["clips"]):
                            raise ValueError("This reference is used by saved clips. Deselect it before removing it.")
                        project["library"].remove(item)
                store.write(f"projects/{project_id}/project.json", project)
                return web.json_response({"ok": True})
            elif command == "importPlan":
                check_mutable(scene)
                result = body.get("plan")
                if isinstance(result, str):
                    result = json.loads(result)
                # A caller-generated ID makes a lost import response safe to retry.
                request_id = core.identifier(body["requestId"])
                imports = scene.setdefault("imports", {})
                digest = core.fingerprint(store, {"plan": result})
                if request_id in imports:
                    if imports[request_id] != digest:
                        raise ValueError("Import request ID was already used for different JSON")
                else:
                    core.import_plan(store, scene, result)
                    imports[request_id] = digest
            elif command == "saveSettings":
                check_mutable(scene)
                scene["settings"] = core.settings(body["settings"])
            else:
                clip = find_clip(scene, body["clipId"])
                base = base_url(request)
                if command == "saveClip":
                    check_mutable(scene, clip)
                    if "referenceSlots" in clip:
                        slots = core.bind_slots(scene, clip, body.get("referenceSlots"))
                        refs = list(dict.fromkeys(s["referenceId"] for s in slots if s["referenceId"]))
                    else:
                        refs = body["referenceIds"]
                        available = {r["id"] for r in scene["references"] if r.get("assets")}
                        if not isinstance(refs, list) or any(not isinstance(r, str) for r in refs) or len(set(refs)) != len(refs) or not set(refs) <= available:
                            raise ValueError("Select only supplied project references")
                    if type(body.get("use_last_frame")) is not bool:
                        raise ValueError("use_last_frame must be true or false")
                    if body["use_last_frame"] and not core.previous(scene, clip):
                        raise ValueError("The first project clip has no preceding clip for continuity")
                    prompt = core.text(body["prompt"], 12000)
                    if "referenceSlots" in clip:
                        core.slot_prompt_body(prompt, slots)
                    else:
                        h3_prompt.validate(prompt, [])
                    seconds = core.duration(body["duration"])
                    clip["nextDuration" if clip.get("takeId") else "duration"] = seconds
                    clip.update(prompt=prompt, referenceIds=refs, continuityMode="on" if body["use_last_frame"] else "off")
                    if "referenceSlots" in clip:
                        clip["referenceSlots"] = slots
                    clip["promptContext"] = core.prompt_context(store, scene, clip)
                    clip.pop("approvedKey", None)
                elif command == "approveGenerate":
                    check_mutable(scene, clip)
                    if body.get("reviewKey") != core.approval_key(store, scene, clip):
                        raise ValueError("The saved clip or previous clip frame changed. Save, review it, and approve again.")
                    await eng.submit(scene, clip, base)
                elif command == "pause":
                    scene["paused"] = True
                elif command in ("resume", "recover"):
                    if clip["status"] not in core.ACTIVE or not clip.get("submittedSettings"):
                        raise ValueError("Only an unresolved submitted job can be recovered")
                    if command == "recover":
                        clip["jobId"] = core.identifier(body["jobId"])
                    if not clip.get("jobId"):
                        raise ValueError("Recover a known job ID first")
                    clip.update(status="saving" if clip.get("source") else "queued")
                    clip.pop("error", None)
                    scene["paused"] = False
                elif command == "acknowledgeMissingJob":
                    if clip["status"] not in core.ACTIVE or body.get("confirmed") is not True:
                        raise ValueError("Explicitly confirm the old job cannot produce another result")
                    clip.update(status="failed", error="User checked the queue and released the unresolved submission")
                    scene["paused"] = True
                elif command == "exportGraph":
                    core.ensure_ready(store, scene, clip)
                    return web.json_response({"graph": core.build_h3(store, scene, clip, eng.input_dir, core.uid())})
                else:
                    raise ValueError("Unknown action")
            store.save_scene(scene)
            if command in ("resume", "recover"):
                eng.watch(project_id, scene["id"], base)
            return web.json_response({"workspace": public_scene(eng, scene)})


def public_scene(eng, scene):
    from . import timing
    result = copy.deepcopy(scene)
    for clip in result["clips"]:
        clip["timing"] = timing.public(clip)
        clip["previousFrame"] = core.previous_frame(scene, clip)
        try:
            core.ensure_ready(eng.store, scene, clip)
            clip["reviewKey"] = core.approval_key(eng.store, scene, clip)
        except (ValueError, FileNotFoundError):
            clip["reviewKey"] = None
    return result


@PromptServer.instance.routes.post("/ava-agent/upload")
@errors
async def upload(request):
    origin_guard(request)
    eng = engine()
    project_id = core.identifier(request.query["projectId"])
    async with eng.lock(project_id):
        scene = eng.store.workspace(project_id)
        async with eng.lock(scene["id"]):
            check_mutable(scene)
            project = eng.store.project(project_id)
            ref = next(r for r in project["library"] if r["id"] == request.query["referenceId"])
            if ref["kind"] == "last-frame" or len(ref["assets"]) >= 12:
                raise ValueError("Upload to a reference entry with fewer than 12 files")
            reader = await request.multipart()
            part = await reader.next()
            if not part or not part.filename:
                raise ValueError("Choose a reference file")
            suffix = Path(part.filename).suffix.lower()
            kind = "image" if suffix in (".png", ".jpg", ".jpeg", ".webp") else "audio" if suffix in (".wav", ".mp3", ".m4a", ".flac", ".ogg") else None
            if not kind:
                raise ValueError("Unsupported reference format")
            chunks, size = [], 0
            while chunk := await part.read_chunk():
                size += len(chunk)
                if size > 20 * 1024 * 1024:
                    raise ValueError("Reference files must be at most 20 MiB")
                chunks.append(chunk)
            if not size:
                raise ValueError("Reference is empty")
            directory = f"projects/{project_id}/library"
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
            ref["assets"].append(asset)
            eng.store.write(f"projects/{project_id}/project.json", project)
            return web.json_response({"asset": asset})


@PromptServer.instance.routes.get("/ava-agent/media")
@errors
async def get_media(request):
    relative = request.query["path"]
    project_id = core.identifier(request.query["projectId"])
    store = engine().store
    store.project(project_id)
    path = store.path(relative)
    if not path.is_relative_to(store.path(f"projects/{project_id}")) or path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov", ".wav", ".mp3", ".m4a", ".flac", ".ogg"):
        raise ValueError("Unsupported media path")
    return web.FileResponse(path, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@PromptServer.instance.routes.get("/ava-agent/scene-planning-skill")
@errors
async def download_skill(request):
    return web.FileResponse(Path(__file__).parent / "skills/comfyui-scene-planner/SKILL.md", headers={
        "Content-Disposition": 'attachment; filename="comfyui-scene-planner.md"', "Cache-Control": "no-store"})
