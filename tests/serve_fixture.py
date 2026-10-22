"""HTTP/UI integration fixture. Fake Comfy queue and Codex; real routes, store and browser UI."""
import argparse
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import types

from aiohttp import web

PACKAGE = Path(__file__).resolve().parents[1]
temporary = tempfile.TemporaryDirectory()
root = Path(temporary.name)
routes = web.RouteTableDef()
folder_paths = types.ModuleType("folder_paths")
folder_paths.get_output_directory = lambda: str(root / "output")
folder_paths.get_input_directory = lambda: str(root / "input")
folder_paths.get_filename_list = lambda kind: []
server = types.ModuleType("server")
server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes))
nodes = types.ModuleType("nodes")
template = json.loads((PACKAGE / "templates/h3-api.json").read_text())
nodes.NODE_CLASS_MAPPINGS = {n["class_type"]: object for n in template.values()} | {"LoadImage": object, "LoadAudio": object, "MiniMaxH3AddGuide": object}
execution = types.ModuleType("execution")
async def validate_prompt(*args): return True, {}, [], {}
execution.validate_prompt = validate_prompt
mm = types.ModuleType("comfy.model_management")
mm.unload_all_models = lambda: None
mm.soft_empty_cache = lambda: None
comfy = types.ModuleType("comfy"); comfy.__path__ = []; comfy.model_management = mm
sys.modules.update(folder_paths=folder_paths, server=server, nodes=nodes, execution=execution, comfy=comfy)
sys.modules["comfy.model_management"] = mm
spec = importlib.util.spec_from_file_location("ava_fixture", PACKAGE / "__init__.py", submodule_search_locations=[str(PACKAGE)])
package = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = package
spec.loader.exec_module(package)
eng = package.routes.engine()
eng.watch = lambda *args: None
planning_fixture = {"delay": 0, "fail": False, "calls": 0, "live": False}
real_ask = package.planner.ask
eng.bridge.pair()
eng.bridge.touch("fixture_pc", [{"id": "codex-default-test", "name": "Default test model", "default": True, "images": True},
                                {"id": "codex-alternate-test", "name": "Alternate test model", "default": False, "images": True}], "fixture")


def styled_prompt(refs, action):
    prompt = " ".join(f"{r['name']} {r.get('subjectLabel') or ''} follows the supplied reference." for r in refs)
    prompt += " Live-action, warm sunrise light. Static shot, camera locked off; no camera movement. " + action
    prompt += " A window latch clicks over soft room ambience. No dialogue or music."
    prompt = prompt.strip()
    return package.planner.h3_prompt.validate(prompt, refs, 15)


async def ask(store, instruction, payload, images=(), model_file=None):
    if planning_fixture["live"]:
        return await real_ask(store, instruction, payload, images, model_file=model_file)
    if instruction == package.planner.DISCOVER:
        return {"title": "Window scene", "summary": "A woman opens a window and smiles.", "references": [
            {"id": "woman", "name": "Woman", "kind": "character", "description": "The woman in the script"}]}
    if instruction == package.planner.PLAN:
        planning_fixture["calls"] += 1
        await asyncio.sleep(planning_fixture["delay"])
        if planning_fixture["fail"]:
            raise ValueError("Fixture Codex planning failed; the saved draft is retained.")
        ids = [r["id"] for r in payload["suppliedReferences"]]
        # Two clips deliberately exercise frame-aware continuation; this fake is not a planner-quality evaluation.
        return {"clips": [{"id": "open", "title": "Open window", "duration": 5, "referenceIds": ids, "transition": "first", "prompt": styled_prompt(payload["suppliedReferences"], "Woman opens the window.")},
                          {"id": "smile", "title": "Smile", "duration": 5, "referenceIds": ids, "transition": "continue", "prompt": "She smiles at the sunrise."}]}
    return {"prompt": styled_prompt(payload.get("references", []), "Woman smiles at the sunrise.")}
package.planner.ask = ask

queue = []
submissions = []
@routes.post("/test/planning")
async def configure_planning(request):
    body = await request.json()
    planning_fixture.update({key: body[key] for key in ("delay", "fail", "live") if key in body})
    return web.json_response(planning_fixture)
@routes.get("/test/planning")
async def planning_state(request): return web.json_response(planning_fixture)
@routes.get("/queue")
async def get_queue(request): return web.json_response({"queue_running": [], "queue_pending": queue})
@routes.get("/history/{job}")
async def get_history(request): return web.json_response({})
@routes.post("/prompt")
async def post_prompt(request):
    body = await request.json()
    submissions.append(body)
    queue.append([0, body["prompt_id"]])
    return web.json_response({"prompt_id": body["prompt_id"]})
@routes.get("/test/submissions")
async def get_submissions(request): return web.json_response(submissions)
@routes.post("/test/phase")
async def render_phase(request):
    body = await request.json()
    project = eng.store.projects()[0]
    scene = eng.store.scenes(project["id"])[0]
    clip = scene["clips"][0]
    now = time.time()
    clock = clip.setdefault("timing", {})
    if body["phase"] == "rendering":
        scene["paused"] = False
        clip["status"] = "rendering"
        clock.update(renderStartedAt=now - 30, expectedRenderSeconds=180, expectedSaveSeconds=45, estimateSamples=2,
                     sampling={"value": 3, "total": 8, "firstValue": 1, "firstObservedAt": now - 20, "observedAt": now})
    elif body["phase"] == "saving":
        clip["status"] = "saving"
        clock.update(renderFinishedAt=now, savingStartedAt=now)
    elif body["phase"] == "complete":
        relative = eng.store.scene_dir(project["id"], scene["id"]) + "/fixture-source.mp4"
        await asyncio.to_thread(package.media.command, ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size=256x256:rate=24:duration={clip['duration']}", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(eng.store.path(relative))])
        clip["source"] = {"path": relative, "name": "fixture-source.mp4"}
        await eng.check(scene, clip, "http://unused")
        scene["paused"] = True
        queue.clear()
    eng.store.save_scene(scene)
    return web.json_response({"ok": True})
@routes.post("/test/reset")
async def reset_fixture(request):
    planning_fixture.update(delay=0, fail=False, calls=0, live=False)
    queue.clear()
    submissions.clear()
    import shutil
    directory = eng.store.root / "projects"
    if directory.exists():
        assert directory.resolve().is_relative_to(root.resolve())
        shutil.rmtree(directory)
    return web.json_response({"ok": True})
@routes.get("/scripts/app.js")
async def app_js(request):
    return web.Response(content_type="application/javascript", text="""
    export const app={extensionManager:{registerSidebarTab(tab){tab.render(document.querySelector('#sidebar'));}},registerExtension(ext){ext.setup();}};
    """)
@routes.get("/scripts/api.js")
async def api_js(request):
    return web.Response(content_type="application/javascript", text="export const api={fetchApi:(path,options)=>fetch(path,options),apiURL:path=>path};")
@routes.get("/extensions/ava/agent.js")
async def agent_js(request): return web.FileResponse(PACKAGE / "web/agent.js")
@routes.get("/extensions/ava/agent.css")
async def agent_css(request): return web.FileResponse(PACKAGE / "web/agent.css")
@routes.get("/")
async def index(request):
    return web.Response(content_type="text/html", text='<title>ComfyUI fixture</title><div id="sidebar" style="height:100vh"></div><script type="module" src="/extensions/ava/agent.js"></script>')

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8199)
parser.add_argument("--proxy", action="store_true", help="Simulate RunPod rewriting the external Host before ComfyUI")
args = parser.parse_args()

@web.middleware
async def simulate_reverse_proxy(request, handler):
    if args.proxy:
        headers = dict(request.headers)
        headers["Host"] = "comfyui.internal:8188"
        request = request.clone(headers=headers)
    return await handler(request)

application = web.Application(client_max_size=32 * 1024 * 1024, middlewares=[simulate_reverse_proxy])
application.add_routes(routes)
web.run_app(application, host="127.0.0.1", port=args.port)
