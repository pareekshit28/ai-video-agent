"""CPU-only contract tests. Comfy queue/model/Qwen calls are mocked, media is real FFmpeg."""
import asyncio
import copy
import importlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

PACKAGE = Path(__file__).resolve().parents[1]
# Load relative package modules without requiring a ComfyUI/Torch installation.
namespace = types.ModuleType("ava_tests_package")
namespace.__path__ = [str(PACKAGE)]
sys.modules[namespace.__name__] = namespace
core = importlib.import_module(namespace.__name__ + ".core")
qwen = importlib.import_module(namespace.__name__ + ".qwen")
media = importlib.import_module(namespace.__name__ + ".media")
engine_module = importlib.import_module(namespace.__name__ + ".engine")
local_qwen = importlib.import_module(namespace.__name__ + ".local_qwen")
http_contract = importlib.import_module(namespace.__name__ + ".http_contract")


class OriginPolicyTests(unittest.TestCase):
    def test_same_origin_browser_survives_reverse_proxy_host_rewrite(self):
        headers = {"Origin": "https://example-8188.proxy.runpod.net", "Sec-Fetch-Site": "same-origin"}
        self.assertTrue(http_contract.origin_is_allowed(headers, "127.0.0.1:8188"))

    def test_other_site_is_rejected_even_when_the_host_or_config_matches(self):
        for site in ("cross-site", "same-site"):
            headers = {"Origin": "https://pod.example", "Sec-Fetch-Site": site}
            self.assertFalse(http_contract.origin_is_allowed(headers, "pod.example", "https://pod.example"))

    def test_direct_host_works_without_fetch_metadata(self):
        self.assertTrue(http_contract.origin_is_allowed({"Origin": "http://127.0.0.1:8188"}, "127.0.0.1:8188"))

    def test_proxy_without_metadata_requires_an_explicit_public_origin(self):
        headers = {"Origin": "https://example-8188.proxy.runpod.net"}
        self.assertFalse(http_contract.origin_is_allowed(headers, "localhost:8188"))
        self.assertTrue(http_contract.origin_is_allowed(headers, "localhost:8188", "https://example-8188.proxy.runpod.net"))

    def test_forwarded_headers_do_not_authorize_another_site(self):
        headers = {"Origin": "https://unrelated.example", "X-Forwarded-Host": "unrelated.example"}
        self.assertFalse(http_contract.origin_is_allowed(headers, "localhost:8188"))

    def test_local_queue_clients_without_origin_still_work(self):
        self.assertTrue(http_contract.origin_is_allowed({}, "127.0.0.1:8188"))

    def test_invalid_or_opaque_origins_are_rejected(self):
        for origin in ("null", "not a URL", "https://user@pod.example", "https://pod.example/path"):
            self.assertFalse(http_contract.origin_is_allowed({"Origin": origin, "Sec-Fetch-Site": "same-origin"}, "pod.example"))


class Fixture:
    def setup_fixture(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = core.Store(self.root / "state")
        self.project = self.store.create_project("Film")
        self.scene = self.store.create_scene(self.project["id"], "Scene", "A character opens a door, then says hello.")
        path = f"projects/{self.project['id']}/reference.png"
        self.store.path(path).parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (256, 256), "red").save(self.store.path(path))
        self.asset = {"path": path, "kind": "image", "name": "actor.png"}
        self.scene["references"] = [{"id": "actor", "name": "Actor", "kind": "character", "description": "The actor", "assets": [self.asset]}]
        self.scene["clips"] = core.validate_plan(self.scene, {"clips": [
            {"id": "one", "title": "Open", "duration": 5, "referenceIds": ["actor"], "transition": "first", "prompt": "Static shot. Actor opens a door."},
            {"id": "two", "title": "Hello", "duration": 5, "referenceIds": ["actor"], "transition": "continue", "prompt": 'Actor says: "Hello".'}]})
        self.clip = self.scene["clips"][0]
        self.clip["promptContext"] = core.prompt_context(self.store, self.scene, self.clip)
        self.store.save_scene(self.scene)

    def teardown_fixture(self):
        self.temp.cleanup()


class CoreTests(Fixture, unittest.TestCase):
    def setUp(self): self.setup_fixture()
    def tearDown(self): self.teardown_fixture()

    def test_path_traversal_rejected(self):
        with self.assertRaises(ValueError): self.store.path("../credentials")
        with self.assertRaises(ValueError): self.store.scene("../project", "scene")

    def test_missing_and_duplicate_references_rejected(self):
        bad = {"clips": [{**self.clip, "referenceIds": ["invented"]}]}
        with self.assertRaises(ValueError): core.validate_plan(self.scene, bad)
        with self.assertRaises(ValueError): core.validate_references({"references": [{"id": "a", "name": "A", "kind": "prop", "description": "x"}] * 2})

    def test_reference_tags_follow_actual_selected_order(self):
        self.scene["references"].insert(0, {"id": "empty", "name": "Empty", "kind": "prop", "description": "empty", "assets": []})
        self.clip["referenceIds"] = ["empty", "actor"]
        prompt = core.final_prompt(self.scene, self.clip)
        self.assertTrue(prompt.startswith("Reference\n<Picture 1>: Actor"))
        self.assertNotIn("Picture 2", prompt)

    def test_reference_bytes_invalidate_approval(self):
        before = core.approval_key(self.store, self.scene, self.clip)
        Image.new("RGB", (256, 256), "blue").save(self.store.path(self.asset["path"]))
        self.assertNotEqual(before, core.approval_key(self.store, self.scene, self.clip))
        with self.assertRaises(ValueError): core.ensure_ready(self.store, self.scene, self.clip)

    def test_steps_do_not_require_replanning_but_change_approval(self):
        context = self.clip["promptContext"]
        key = core.approval_key(self.store, self.scene, self.clip)
        self.scene["settings"]["steps"] = 12
        self.assertEqual(context, core.prompt_context(self.store, self.scene, self.clip))
        self.assertNotEqual(key, core.approval_key(self.store, self.scene, self.clip))

    def test_pending_duration_archives_without_mutating_take(self):
        self.clip.update(takeId="old", duration=5, nextDuration=8, video={"path": "old.mp4"}, status="complete")
        core.archive_take(self.clip)
        self.assertEqual(8, self.clip["duration"])
        self.assertEqual(5, self.clip["versions"][0]["duration"])
        self.assertEqual("old.mp4", self.clip["versions"][0]["video"]["path"])

    def test_later_prompt_requires_actual_previous_frame(self):
        second = self.scene["clips"][1]
        with self.assertRaises(ValueError): core.ensure_ready(self.store, self.scene, second)
        self.clip.update(status="complete", frame=self.asset, takeId="take", submittedPrompt="prior", actualDuration=5)
        second.update(prompt="Next action", promptContext=core.prompt_context(self.store, self.scene, second))
        core.ensure_ready(self.store, self.scene, second)
        self.clip["takeId"] = "replacement"
        with self.assertRaises(ValueError): core.ensure_ready(self.store, self.scene, second)

    def test_h3_preserves_source_model_chain_and_native_guide(self):
        self.clip.update(status="complete", frame=self.asset)
        second = self.scene["clips"][1]
        second["prompt"] = "Continue"
        graph = core.build_h3(self.store, self.scene, second, self.root / "input", "take")
        self.assertEqual("fasth3_omniref_8step_pruned_int8_convrot.safetensors", graph["127"]["inputs"]["unet_name"])
        self.assertEqual(["143", 0], graph["126"]["inputs"]["model"])
        self.assertEqual(["ava_frame_guide", 0], graph["126"]["inputs"]["conditioning"])
        self.assertEqual(["136", 1], graph["125"]["inputs"]["latent_image"])
        self.assertEqual(["136", 1], graph["ava_frame_guide"]["inputs"]["latent"])
        self.assertEqual(0, graph["ava_frame_guide"]["inputs"]["frame_idx"])
        self.assertIn("ref_images.ref_image_0", graph["136"]["inputs"])
        self.assertTrue((self.root / "input" / graph["ava_image_0"]["inputs"]["image"]).exists())

    def test_approval_is_bound_to_next_take(self):
        key = core.approval_key(self.store, self.scene, self.clip)
        self.clip["takeId"] = "new-render"
        self.assertNotEqual(key, core.approval_key(self.store, self.scene, self.clip))

    def test_duration_and_provider_validation(self):
        for value in (True, 1, 16, float("nan")):
            with self.assertRaises(ValueError): core.duration(value)
        self.assertEqual(2.5, core.duration(2.5))
        with self.assertRaises(ValueError): core.settings({"provider": "unsupported"})

    def test_disallowed_manual_tags(self):
        self.clip["prompt"] = "Use <Picture 4>"
        with self.assertRaises(ValueError): core.final_prompt(self.scene, self.clip)

    def test_qwen_json_and_configuration(self):
        self.assertEqual({"a": 1}, qwen.parse_json('<think>reason</think>```json\n{"a":1}\n```'))
        with self.assertRaises(ValueError): qwen.parse_json("[]")
        with self.assertRaises(ValueError): qwen.validate_config({"model": "codex"})

    def test_h3_encoder_cannot_be_selected_as_a_planning_model(self):
        with self.assertRaisesRegex(ValueError, "truncated Qwen text encoder"):
            qwen.validate_config({"model": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"})

    def test_native_qwen_uses_comfy_runtime_and_preserves_image_order(self):
        clip = MagicMock()
        clip.generate.return_value = [1, 2]
        clip.decode.return_value = '{"prompt":"Native response"}'
        loader = MagicMock()
        loader.load_clip.return_value = (clip,)
        mm = types.ModuleType("comfy.model_management")
        mm.unload_all_models = MagicMock()
        mm.soft_empty_cache = MagicMock()
        comfy = types.ModuleType("comfy"); comfy.__path__ = []; comfy.model_management = mm
        modules = {"nodes": types.SimpleNamespace(CLIPLoader=lambda: loader),
                   "folder_paths": types.SimpleNamespace(get_filename_list=lambda kind: [local_qwen.DEFAULT_MODEL]),
                   "comfy": comfy, "comfy.model_management": mm}
        with patch.dict(sys.modules, modules), patch.object(local_qwen, "image_tensor", side_effect=["image-one", "image-two"]):
            result = local_qwen.generate(local_qwen.DEFAULT_MODEL, "system", "content", ["one.png", "two.png"])
        self.assertEqual('{"prompt":"Native response"}', result)
        self.assertEqual(["image-one", "image-two"], clip.tokenize.call_args.kwargs["images"])
        self.assertEqual(2, clip.tokenize.call_args.args[0].count("<|image_pad|>"))
        loader.load_clip.assert_called_once_with(local_qwen.DEFAULT_MODEL, type="stable_diffusion", device="default")
        self.assertEqual(2, mm.unload_all_models.call_count)
        self.assertFalse(clip.generate.call_args.kwargs["do_sample"])

    def test_workflow_links_models_and_requires_explicit_render_approval(self):
        workflow = json.loads((PACKAGE / "workflow.json").read_text(encoding="utf-8"))
        models = json.loads((PACKAGE / "models.json").read_text())
        nodes = {n["type"]: n for n in workflow["nodes"]}
        self.assertEqual(2, nodes["AVAQueueReviewedClip"]["mode"])
        self.assertEqual(models, workflow["extra"]["models"])
        self.assertEqual(models[0]["name"], nodes["AVAQwenPlan"]["widgets_values"][1])
        note = nodes["MarkdownNote"]["widgets_values"][0]
        for model in models:
            self.assertIn(model["url"], note)
            self.assertIn(model["directory"] + "/" + model["name"], note)

    def test_project_deletion_recoverable_trash(self):
        self.store.trash_project(self.project["id"])
        self.assertEqual([], self.store.projects())
        self.assertEqual(1, len(list(self.store.path(".trash").iterdir())))


class EngineTests(Fixture, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.setup_fixture()
        self.engine = engine_module.Engine(self.store, self.root / "input", self.root / "output")
        self.engine.watch = lambda *args: None
        template = json.loads((PACKAGE / "templates/h3-api.json").read_text())
        self.nodes = types.SimpleNamespace(NODE_CLASS_MAPPINGS={t: object for t in {n["class_type"] for n in template.values()} | {"LoadImage", "MiniMaxH3AddGuide"}})
        self.validate = AsyncMock(return_value=(True, {}, [], {}))
        self.modules = patch.dict(sys.modules, {"nodes": self.nodes, "execution": types.SimpleNamespace(validate_prompt=self.validate)})
        self.modules.start()

    async def asyncTearDown(self):
        self.modules.stop()
        self.teardown_fixture()

    async def test_validation_failure_never_reserves_or_submits(self):
        self.validate.return_value = (False, {"message": "Missing model"}, [], {})
        with self.assertRaises(ValueError): await self.engine.submit(self.scene, self.clip, "http://unused")
        self.assertNotIn("takeId", self.store.scene(self.project["id"], self.scene["id"])["clips"][0])

    async def test_lost_response_is_reserved_and_blocks_duplicate(self):
        # Invalid port simulates a lost response without any external network request.
        await self.engine.submit(self.scene, self.clip, "http://127.0.0.1:1")
        saved = self.store.scene(self.project["id"], self.scene["id"])
        self.assertEqual("submission-unknown", saved["clips"][0]["status"])
        self.assertTrue(saved["clips"][0]["jobId"])
        with self.assertRaises(ValueError): await self.engine.submit(saved, saved["clips"][0], "http://127.0.0.1:1")

    async def test_submit_persists_before_network_and_queues_once(self):
        calls = []
        async def prompt(request):
            body = await request.json()
            persisted = self.store.scene(self.project["id"], self.scene["id"])["clips"][0]
            self.assertEqual("submitting", persisted["status"])
            self.assertEqual(body["prompt_id"], persisted["jobId"])
            calls.append(body)
            return web.json_response({"prompt_id": body["prompt_id"]})
        app = web.Application(); app.router.add_post("/prompt", prompt)
        async with TestServer(app) as server:
            await self.engine.submit(self.scene, self.clip, str(server.make_url("")).rstrip("/"))
        self.assertEqual(1, len(calls))
        self.assertEqual("queued", self.clip["status"])

    async def test_failed_next_planning_keeps_completed_take(self):
        self.clip.update(status="queued", takeId="take", jobId="job", submittedSettings=core.DEFAULTS.copy())
        self.scene["paused"] = False
        self.store.save_scene(self.scene)
        async def complete(scene, clip, base):
            clip.update(status="complete", frame=self.asset, video={"path": "saved.mp4"}, actualDuration=5)
        self.engine.check = complete
        self.engine.plan_prompt = AsyncMock(side_effect=ValueError("Qwen unavailable"))
        await self.engine.monitor(self.project["id"], self.scene["id"], "http://unused")
        saved = self.store.scene(self.project["id"], self.scene["id"])
        self.assertEqual("complete", saved["clips"][0]["status"])
        self.assertEqual("saved.mp4", saved["clips"][0]["video"]["path"])
        self.assertIn("Qwen unavailable", saved["clips"][1]["error"])

    async def test_qwen_json_uses_native_model_and_images_without_network(self):
        paths = [self.store.path(self.asset["path"])]
        with patch.object(local_qwen, "generate", return_value='{"prompt":"Native prompt"}') as generate:
            result = await qwen.ask(self.store, qwen.PROMPT, {"target":"clip"}, paths)
        self.assertEqual("Native prompt", result["prompt"])
        self.assertEqual(local_qwen.DEFAULT_MODEL, generate.call_args.args[0])
        self.assertEqual(paths, generate.call_args.args[3])
        self.assertIn(qwen.PROMPT, generate.call_args.args[1])

    async def test_qwen_model_override_is_stored_as_a_local_filename(self):
        model = "qwen3vl_8b_fp8_scaled.safetensors"
        self.store.write("qwen.json", qwen.validate_config({"model": model}))
        with patch.object(local_qwen, "generate", return_value='{"prompt":"Native prompt"}') as generate:
            await qwen.ask(self.store, qwen.PROMPT, {})
        self.assertEqual(model, generate.call_args.args[0])
        self.assertEqual("comfyui", qwen.config(self.store)["runtime"])

    async def test_foreign_renderer_cannot_be_submitted_as_h3(self):
        self.scene["settings"]["provider"] = "unsupported"
        self.clip["promptContext"] = core.prompt_context(self.store, self.scene, self.clip)
        with self.assertRaisesRegex(ValueError, "Only H3 generation"):
            await self.engine.submit(self.scene, self.clip, "http://unused")
        self.validate.assert_not_called()
        self.assertNotIn("takeId", self.clip)

    async def test_foreign_job_cannot_be_polled_as_a_comfy_job(self):
        self.clip.update(submittedSettings={"provider": "unsupported"}, jobId="old-job")
        self.engine.http = AsyncMock()
        with self.assertRaisesRegex(ValueError, "unsupported renderer"):
            await self.engine.check(self.scene, self.clip, "http://unused")
        self.engine.http.assert_not_called()

    async def test_raw_h3_file_recovered_without_queue_history(self):
        output = self.root / "output/ai_video_agent/raw" / self.scene["id"]
        output.mkdir(parents=True)
        (output / "one-take_00001_.mp4").write_bytes(b"fixture-source")
        self.clip.update(status="queued", takeId="take", jobId="job", submittedSettings=core.DEFAULTS.copy())
        self.engine.http = AsyncMock(side_effect=[{}, {"queue_running": [], "queue_pending": []}])
        with patch.object(media, "finalize", return_value={"status": "complete"}) as finalize:
            await self.engine.check(self.scene, self.clip, "http://unused")
        self.assertEqual("complete", self.clip["status"])
        self.assertEqual(b"fixture-source", self.store.path(self.clip["source"]["path"]).read_bytes())
        finalize.assert_called_once()


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg tools required")
class MediaTests(Fixture, unittest.TestCase):
    def setUp(self): self.setup_fixture()
    def tearDown(self): self.teardown_fixture()

    def source(self, seconds):
        relative = f"projects/{self.project['id']}/source.mp4"
        media.command(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size=256x256:rate=24:duration={seconds}", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(self.store.path(relative))])
        self.clip.update(source={"path": relative}, duration=2, takeId="take", submittedSettings=core.DEFAULTS.copy())

    def test_real_finalization_trims_and_extracts_last_frame(self):
        self.source(2.3)
        result = media.finalize(self.store, self.scene, self.clip)
        self.assertAlmostEqual(2, result["actualDuration"], places=2)
        self.assertTrue(self.store.path(result["frame"]["path"]).is_file())
        self.assertTrue(self.store.path(self.clip["source"]["path"]).is_file())

    def test_short_video_is_not_marked_complete(self):
        self.source(1)
        with self.assertRaises(ValueError): media.finalize(self.store, self.scene, self.clip)


if __name__ == "__main__":
    unittest.main()
