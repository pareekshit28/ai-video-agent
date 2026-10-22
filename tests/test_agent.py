"""CPU-only contract tests. Comfy queue/model/Qwen calls are mocked, media is real FFmpeg."""
import asyncio
import copy
from concurrent.futures import ThreadPoolExecutor
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
timing = importlib.import_module(namespace.__name__ + ".timing")
h3_prompt = importlib.import_module(namespace.__name__ + ".h3_prompt")

BASE_PROMPT = ("integrated_multimodal_description: [Shot 1] Live-action. Static medium shot of an actor opening a door. "
               "The actor (S1) says with synchronized lips: <d>[English] Hello.</d>\n"
               "overall_soundscape: The latch clicks over quiet room ambience.\nnon_diegetic_music: N/A")
REF_PROMPT = ("subject_definitions: Actor <Subject 1> follows the supplied appearance.\n"
              "summary: [reference generation] Actor opens the door and speaks.\n"
              "retention_analysis: <Subject 1>: fully_preserved - visual identity and clothing.\n"
              "detailed_description: Live-action. [Shot 1] Static medium shot of Actor <Subject 1> opening a door. "
              "Actor (S1) says with synchronized lips: <d>[English] Hello.</d>\n"
              "overall_soundscape: The latch clicks over quiet room ambience.\nnon_diegetic_music: N/A")


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
        self.scene = self.store.create_scene(self.project["id"], "Scene", "A character opens a door, then says hello.", episode_id=core.DEFAULT_EPISODE)
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


class H3PromptTests(Fixture, unittest.TestCase):
    def setUp(self): self.setup_fixture()
    def tearDown(self): self.teardown_fixture()

    def test_base_and_reference_modes_preserve_original_dialogue(self):
        refs, _ = qwen.reference_context(self.store, self.scene)
        self.assertEqual(BASE_PROMPT, h3_prompt.validate(BASE_PROMPT, [], 15))
        hindi = REF_PROMPT.replace("[English] Hello.", "[Hindi] दरवाज़ा खुला है।")
        self.assertEqual(hindi, h3_prompt.validate(hindi, refs, 15))
        with self.assertRaisesRegex(ValueError, "sections"):
            h3_prompt.validate(BASE_PROMPT, refs, 15)

    def test_reordered_reference_inputs_keep_subject_identity_and_bind_real_media(self):
        self.scene["references"].insert(0, {"id": "room", "name": "Room", "kind": "location", "description": "Room", "assets": [self.asset]})
        refs, paths = qwen.reference_context(self.store, self.scene, core.selected(self.scene, self.clip))
        self.assertEqual("<Subject 2>", refs[0]["subjectLabel"])
        self.assertEqual([self.store.path(self.asset["path"])], paths)
        self.clip["prompt"] = REF_PROMPT.replace("<Subject 1>", "<Subject 2>")
        h3_prompt.validate(self.clip["prompt"], refs, 15)
        bound = core.final_prompt(self.scene, self.clip)
        self.assertIn("<Picture 1>: Actor, <Subject 2>", bound)
        self.assertNotIn("<Picture 2>", bound)

    def test_voice_only_reference_does_not_invent_a_visual_subject(self):
        self.scene["references"][0]["assets"] = [{"path": "voice.wav", "name": "voice.wav", "kind": "audio"}]
        refs, paths = qwen.reference_context(self.store, self.scene)
        self.assertIsNone(refs[0]["subjectLabel"])
        self.assertEqual([], paths)
        voice = REF_PROMPT.replace("Actor <Subject 1> follows the supplied appearance.", "Actor supplies voice timbre only.").replace("<Subject 1>", "Actor")
        self.assertEqual(voice, h3_prompt.validate(voice, refs, 15))
        self.clip["prompt"] = voice
        bound = core.final_prompt(self.scene, self.clip)
        self.assertIn("<Audio 1>: Actor", bound)
        self.assertNotIn("<Picture", bound)

    def test_frame_zero_guide_stays_outside_numbered_identity_images_and_music(self):
        self.clip.update(status="complete", frame=self.asset)
        following = self.scene["clips"][1]
        following["prompt"] = REF_PROMPT
        bound = core.final_prompt(self.scene, following)
        self.assertIn("Opening Frame:", bound.split("subject_definitions:")[0])
        self.assertEqual(1, bound.count("<Picture 1>"))
        self.assertTrue(bound.endswith("non_diegetic_music: N/A"))
        following["transition"] = "cut"
        self.assertNotIn("Opening Frame:", core.final_prompt(self.scene, following))

    def test_rejects_guessed_missing_or_foreign_reference_labels(self):
        refs, _ = qwen.reference_context(self.store, self.scene)
        for invalid in (REF_PROMPT + "\n<Picture 1>", REF_PROMPT + "\n<Audio 1>",
                        REF_PROMPT.replace("<Subject 1>", "<Subject 2>"), REF_PROMPT.replace("<Subject 1>", "Actor")):
            with self.subTest(prompt=invalid), self.assertRaises(ValueError):
                h3_prompt.validate(invalid, refs, 15)

    def test_cut_times_are_chronological_and_inside_clip_duration(self):
        valid = BASE_PROMPT.replace("\noverall_soundscape:", " [Shot 2] At 00:06.500, the shot cuts to the open doorway.\noverall_soundscape:")
        h3_prompt.validate(valid, [], 15)
        for invalid in (valid.replace("00:06.500", "00:15.000"), valid.replace("00:06.500", "00:00.000"),
                        valid.replace("[Shot 2]", "[Shot 3]"), valid.replace("[Shot 1]", "[Shot 1] At 00:00.000,"),
                        valid.replace("\noverall_soundscape:", " [Shot 3] At 00:05.000, return to Actor.\noverall_soundscape:")):
            with self.subTest(prompt=invalid), self.assertRaises(ValueError):
                h3_prompt.validate(invalid, [], 15)

    def test_dialogue_requires_language_balanced_tags_and_ordered_speakers(self):
        valid = BASE_PROMPT.replace("\noverall_soundscape:", " Another actor (S2) replies: <d>[English] Come in.</d> Actor (S1) nods: <d>[English] Thanks.</d>\noverall_soundscape:")
        h3_prompt.validate(valid, [], 15)
        for invalid in (BASE_PROMPT.replace("[English] ", ""), BASE_PROMPT.replace("</d>", ""),
                        BASE_PROMPT.replace("(S1)", "(S2)"), BASE_PROMPT.replace("(S1)", "")):
            with self.subTest(prompt=invalid), self.assertRaises(ValueError):
                h3_prompt.validate(invalid, [], 15)


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
        utils = types.SimpleNamespace(PROGRESS_BAR_HOOK=None)
        utils.set_progress_bar_global_hook = lambda hook: setattr(utils, "PROGRESS_BAR_HOOK", hook)
        comfy.utils = utils
        modules = {"nodes": types.SimpleNamespace(CLIPLoader=lambda: loader),
                   "folder_paths": types.SimpleNamespace(get_filename_list=lambda kind: [local_qwen.DEFAULT_MODEL]),
                   "comfy": comfy, "comfy.model_management": mm, "comfy.utils": utils,
                   "comfy_execution": types.SimpleNamespace(),
                   "comfy_execution.utils": types.SimpleNamespace(get_executing_context=lambda: None)}
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


class HierarchyTests(Fixture, unittest.TestCase):
    def setUp(self): self.setup_fixture()
    def tearDown(self): self.teardown_fixture()

    def test_legacy_scenes_appear_in_episode_one_without_moving_media(self):
        project = self.store.project(self.project["id"])
        project.pop("episodes")
        self.store.write(f"projects/{project['id']}/project.json", project)
        self.scene.pop("episodeId")
        self.store.save_scene(self.scene)
        self.assertEqual("Episode 1", self.store.project(project["id"])["episodes"][0]["name"])
        scenes = self.store.scenes(project["id"], core.DEFAULT_EPISODE)
        self.assertEqual([self.scene["id"]], [s["id"] for s in scenes])
        self.assertTrue(self.store.path(self.asset["path"]).is_file())
        self.assertEqual(self.scene["clips"], scenes[0]["clips"])

    def test_episode_scenes_are_isolated_and_membership_is_enforced(self):
        episode = self.store.create_episode(self.project["id"], "Episode 2")
        other = self.store.create_scene(self.project["id"], "Other scene", episode_id=episode["id"])
        self.assertEqual([other["id"]], [s["id"] for s in self.store.scenes(self.project["id"], episode["id"])])
        self.assertEqual([self.scene["id"]], [s["id"] for s in self.store.scenes(self.project["id"], core.DEFAULT_EPISODE)])
        with self.assertRaisesRegex(ValueError, "selected episode"):
            self.store.scene(self.project["id"], self.scene["id"], episode["id"])

    def test_another_projects_episode_and_scene_are_rejected(self):
        episode = self.store.create_episode(self.project["id"], "Project A episode")
        other = self.store.create_project("Project B")
        with self.assertRaisesRegex(ValueError, "this project"):
            self.store.create_scene(other["id"], "Wrong", episode_id=episode["id"])
        with self.assertRaises(FileNotFoundError):
            self.store.scene(other["id"], self.scene["id"])

    def test_library_is_shared_between_episodes_but_not_projects(self):
        project = self.store.project(self.project["id"])
        project["library"] = [{"id": "actor", "assets": [self.asset]}]
        self.store.write(f"projects/{project['id']}/project.json", project)
        self.store.create_episode(project["id"], "Episode 2")
        self.assertEqual([self.asset], self.store.project(project["id"])["library"][0]["assets"])
        other = self.store.create_project("Another project")
        self.assertEqual([], self.store.project(other["id"])["library"])

    def test_qwen_model_selection_is_project_specific(self):
        other = self.store.create_project("Project B")
        chosen = "qwen3vl_8b_fp8_scaled.safetensors"
        self.store.write(f"projects/{self.project['id']}/qwen.json", qwen.validate_config({"model": chosen}))
        self.assertEqual(chosen, qwen.config(self.store, self.project["id"])["model"])
        self.assertEqual(local_qwen.DEFAULT_MODEL, qwen.config(self.store, other["id"])["model"])
        self.assertFalse(self.store.path("qwen.json").exists())

    def test_legacy_pod_model_remains_an_initial_default(self):
        chosen = "qwen3vl_8b_fp8_scaled.safetensors"
        self.store.write("qwen.json", qwen.validate_config({"model": chosen}))
        self.assertEqual(chosen, qwen.config(self.store, self.project["id"])["model"])
        self.store.write(f"projects/{self.project['id']}/qwen.json", qwen.validate_config({"model": local_qwen.DEFAULT_MODEL}))
        self.assertEqual(local_qwen.DEFAULT_MODEL, qwen.config(self.store, self.project["id"])["model"])
        self.assertEqual(chosen, qwen.config(self.store)["model"])

    def test_creation_requires_parents_and_names_scenes_automatically(self):
        with self.assertRaisesRegex(ValueError, "Select an episode"):
            self.store.create_scene(self.project["id"])
        with self.assertRaises(ValueError):
            self.store.create_episode(None)
        one = self.store.create_scene(self.project["id"], episode_id=core.DEFAULT_EPISODE)
        two = self.store.create_scene(self.project["id"], episode_id=core.DEFAULT_EPISODE)
        self.assertEqual(("Scene 1", "Scene 2"), (one["name"], two["name"]))
        self.assertNotEqual(one["id"], two["id"])
        self.assertTrue(one["autoName"])

    def test_scene_deletion_moves_only_that_scene_to_recovery_trash(self):
        sibling = self.store.create_scene(self.project["id"], episode_id=core.DEFAULT_EPISODE)
        self.store.trash_scene(self.project["id"], self.scene["id"], core.DEFAULT_EPISODE)
        self.assertEqual([sibling["id"]], [s["id"] for s in self.store.scenes(self.project["id"])])
        archived = next(self.store.path(".trash/scenes").glob("*/scene.json"))
        self.assertEqual(self.scene["clips"], json.loads(archived.read_text())["clips"])
        self.assertTrue(self.store.project(self.project["id"])["episodes"])

    def test_episode_deletion_preserves_sibling_scenes_and_project_library(self):
        project = self.store.project(self.project["id"])
        project["library"] = [{"id": "shared", "assets": [self.asset]}]
        self.store.write(f"projects/{project['id']}/project.json", project)
        episode = self.store.create_episode(project["id"], "Other episode")
        sibling = self.store.create_scene(project["id"], episode_id=episode["id"])
        self.store.trash_episode(project["id"], core.DEFAULT_EPISODE)
        self.assertEqual([episode], self.store.project(project["id"])["episodes"])
        self.assertEqual([sibling["id"]], [s["id"] for s in self.store.scenes(project["id"])])
        self.assertEqual(project["library"], self.store.project(project["id"])["library"])
        self.assertTrue(list(self.store.path(".trash/episodes").glob("*/episode.json")))

    def test_deleting_last_episode_keeps_project_with_no_episodes(self):
        self.store.trash_episode(self.project["id"], core.DEFAULT_EPISODE)
        self.assertEqual([], self.store.project(self.project["id"])["episodes"])
        self.assertEqual([], self.store.scenes(self.project["id"]))
        created = self.store.create_episode(self.project["id"], "Replacement")
        self.assertEqual([created], self.store.project(self.project["id"])["episodes"])

    def test_active_jobs_block_scene_episode_and_project_deletion(self):
        self.clip["status"] = "recoverable"
        self.store.save_scene(self.scene)
        for operation in (lambda: self.store.trash_scene(self.project["id"], self.scene["id"], core.DEFAULT_EPISODE),
                          lambda: self.store.trash_episode(self.project["id"], core.DEFAULT_EPISODE),
                          lambda: self.store.trash_project(self.project["id"])):
            with self.assertRaisesRegex(ValueError, "active or uncertain"):
                operation()
        self.assertEqual("recoverable", self.store.scene(self.project["id"], self.scene["id"])["clips"][0]["status"])

    def test_episode_archive_failure_restores_moved_scene_directories(self):
        sibling = self.store.create_scene(self.project["id"], episode_id=core.DEFAULT_EPISODE)
        original = self.store.write
        def fail_project_write(relative, value):
            if relative.endswith("/project.json"):
                raise OSError("storage unavailable")
            return original(relative, value)
        with patch.object(self.store, "write", side_effect=fail_project_write):
            with self.assertRaisesRegex(OSError, "storage unavailable"):
                self.store.trash_episode(self.project["id"], core.DEFAULT_EPISODE)
        self.assertEqual({self.scene["id"], sibling["id"]}, {s["id"] for s in self.store.scenes(self.project["id"])})
        self.assertEqual(core.DEFAULT_EPISODE, self.store.project(self.project["id"])["episodes"][0]["id"])

    def test_scene_deletion_rejects_another_episode_before_moving_files(self):
        episode = self.store.create_episode(self.project["id"], "Other")
        with self.assertRaisesRegex(ValueError, "selected episode"):
            self.store.trash_scene(self.project["id"], self.scene["id"], episode["id"])
        self.assertEqual(self.scene["id"], self.store.scene(self.project["id"], self.scene["id"])["id"])


class NativeProgressTests(unittest.TestCase):
    def setUp(self):
        self.context = None
        self.server = types.SimpleNamespace()  # Fresh server: no last_prompt_id.
        self.mm = types.ModuleType("comfy.model_management")
        self.mm.unload_all_models = MagicMock()
        self.mm.soft_empty_cache = MagicMock()
        self.mm.throw_exception_if_processing_interrupted = MagicMock()
        self.utils = types.ModuleType("comfy.utils")
        self.utils.set_progress_bar_global_hook = lambda hook: setattr(self.utils, "PROGRESS_BAR_HOOK", hook)

        def native_hook(value, total, preview, node_id=None):
            # Reproduce main.hijack_progress's missing queued-prompt fallback.
            return self.context.prompt_id if self.context is not None else self.server.last_prompt_id

        self.native_hook = MagicMock(side_effect=native_hook)
        self.utils.PROGRESS_BAR_HOOK = self.native_hook
        utils = self.utils

        class ProgressBar:
            def __init__(self, total):
                self.total, self.current, self.hook = total, 0, utils.PROGRESS_BAR_HOOK

            def update(self, value):
                self.current += value
                if self.hook is not None:
                    self.hook(self.current, self.total, None, node_id=None)

        self.utils.ProgressBar = ProgressBar
        self.clip = MagicMock()
        self.clip.generate.side_effect = lambda *args, **kwargs: (ProgressBar(1).update(1), [1])[1]
        self.clip.decode.return_value = '{"references":[]}'
        loader = MagicMock(); loader.load_clip.return_value = (self.clip,)
        comfy = types.ModuleType("comfy"); comfy.__path__ = []
        comfy.model_management, comfy.utils = self.mm, self.utils
        modules = {"nodes": types.SimpleNamespace(CLIPLoader=lambda: loader),
                   "folder_paths": types.SimpleNamespace(get_filename_list=lambda kind: [local_qwen.DEFAULT_MODEL]),
                   "comfy": comfy, "comfy.model_management": self.mm, "comfy.utils": self.utils,
                   "comfy_execution": types.SimpleNamespace(),
                   "comfy_execution.utils": types.SimpleNamespace(get_executing_context=lambda: self.context)}
        self.patcher = patch.dict(sys.modules, modules)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def generate(self):
        return local_qwen.generate(local_qwen.DEFAULT_MODEL, "system", "content")

    def test_fresh_server_crash_is_reproduced_then_sidebar_generation_succeeds(self):
        with self.assertRaisesRegex(AttributeError, "last_prompt_id"):
            self.utils.ProgressBar(1).update(1)
        self.native_hook.reset_mock()
        self.assertEqual('{"references":[]}', self.generate())
        self.native_hook.assert_not_called()
        self.mm.throw_exception_if_processing_interrupted.assert_called_once()
        self.assertIs(self.native_hook, self.utils.PROGRESS_BAR_HOOK)
        self.assertFalse(local_qwen._sidebar_progress.get())

    def test_canvas_generation_keeps_native_progress(self):
        self.context = types.SimpleNamespace(prompt_id="canvas-prompt")
        self.generate()
        self.native_hook.assert_called_once_with(1, 1, None, node_id=None)
        self.assertIs(self.native_hook, self.utils.PROGRESS_BAR_HOOK)

    def test_other_thread_and_retained_bars_keep_native_progress(self):
        self.server.last_prompt_id = "render-prompt"
        bars = []

        def tokens(*args, **kwargs):
            self.utils.ProgressBar(1).update(1)  # Sidebar: must be suppressed.
            with ThreadPoolExecutor(max_workers=1) as pool:
                bars.append(pool.submit(self.utils.ProgressBar, 2).result())
                pool.submit(bars[0].update, 1).result()
            return [1]

        self.clip.generate.side_effect = tokens
        self.generate()
        self.native_hook.assert_called_once_with(1, 2, None, node_id=None)
        bars[0].update(1)  # Captured wrapper still works after it is restored.
        self.assertEqual(2, self.native_hook.call_count)

    def test_generation_failure_restores_hook_and_offloads_model(self):
        self.clip.generate.side_effect = RuntimeError("model failed")
        with self.assertRaisesRegex(RuntimeError, "model failed"):
            self.generate()
        self.assertIs(self.native_hook, self.utils.PROGRESS_BAR_HOOK)
        self.assertFalse(local_qwen._sidebar_progress.get())
        self.assertEqual(2, self.mm.unload_all_models.call_count)
        self.clip.decode.assert_not_called()

    def test_sidebar_token_progress_keeps_cancellation(self):
        self.mm.throw_exception_if_processing_interrupted.side_effect = RuntimeError("interrupted")
        with self.assertRaisesRegex(RuntimeError, "interrupted"):
            self.generate()
        self.assertIs(self.native_hook, self.utils.PROGRESS_BAR_HOOK)
        self.assertEqual(2, self.mm.unload_all_models.call_count)

    def test_another_extension_hook_is_not_overwritten_on_exit(self):
        replacement = MagicMock()
        self.clip.generate.side_effect = lambda *a, **kw: (self.utils.set_progress_bar_global_hook(replacement), [1])[1]
        self.generate()
        self.assertIs(replacement, self.utils.PROGRESS_BAR_HOOK)

    def test_generation_without_a_native_progress_hook(self):
        self.utils.PROGRESS_BAR_HOOK = None
        self.generate()
        self.assertIsNone(self.utils.PROGRESS_BAR_HOOK)
        self.mm.throw_exception_if_processing_interrupted.assert_called_once()


class TimingTests(Fixture, unittest.TestCase):
    def setUp(self): self.setup_fixture()
    def tearDown(self): self.teardown_fixture()

    def test_estimates_use_median_of_matching_takes_and_exclude_queue_time(self):
        sample = {**copy.deepcopy(self.clip), "status": "complete", "takeId": "prior", "submittedSettings": core.DEFAULTS.copy(),
                  "timing": {"submittedAt": 1, "renderStartedAt": 100, "renderFinishedAt": 200, "completedAt": 210}}
        self.clip["versions"] = [sample, {**copy.deepcopy(sample), "timing": {"renderStartedAt": 200, "renderFinishedAt": 400, "completedAt": 420}},
                                 {**copy.deepcopy(sample), "duration": 10},
                                 {**copy.deepcopy(sample), "submittedSettings": {**core.DEFAULTS, "steps": 40}},
                                 {**copy.deepcopy(sample), "status": "failed"}]
        self.store.save_scene(self.scene)
        self.assertEqual({"expectedRenderSeconds": 150, "expectedSaveSeconds": 15, "estimateSamples": 2}, timing.estimate(self.store, self.scene, self.clip))
        self.clip["nextDuration"] = 8
        self.assertEqual({}, timing.estimate(self.store, self.scene, self.clip))

    def test_regeneration_archives_timestamps_and_resets_current_clock(self):
        self.clip.update(takeId="old", timing={"completedAt": 200})
        core.archive_take(self.clip)
        self.assertNotIn("timing", self.clip)
        self.assertEqual(200, self.clip["versions"][0]["timing"]["completedAt"])

    def test_history_provides_actual_execution_times(self):
        self.clip["timing"] = {"renderStartedAt": 110}
        timing.history_times(self.clip, {"status": {"messages": [["execution_start", {"timestamp": 100000}], ["execution_success", {"timestamp": 200000}]]}})
        self.assertEqual({"renderStartedAt": 100, "renderFinishedAt": 200}, self.clip["timing"])

    def test_queued_job_has_elapsed_and_no_guessed_finish(self):
        self.clip.update(status="queued", timing={"submittedAt": 100, "expectedRenderSeconds": 200})
        result = timing.public(self.clip, now=150)
        self.assertEqual(50, result["elapsedSeconds"])
        self.assertIsNone(result["estimatedCompletionAt"])

    def test_render_eta_and_saving_eta_then_actual_completion(self):
        self.clip.update(status="rendering", timing={"submittedAt": 50, "renderStartedAt": 100, "expectedRenderSeconds": 100, "expectedSaveSeconds": 10})
        self.assertEqual(60, timing.public(self.clip, now=150)["remainingSeconds"])
        self.clip.update(status="saving")
        self.clip["timing"]["savingStartedAt"] = 200
        self.assertEqual(5, timing.public(self.clip, now=205)["remainingSeconds"])
        self.clip.update(status="complete")
        self.clip["timing"]["completedAt"] = 215
        result = timing.public(self.clip, now=999)
        self.assertEqual(165, result["elapsedSeconds"])
        self.assertIsNone(result["remainingSeconds"])
        self.assertEqual(215, result["completedAt"])

    def test_overdue_estimate_does_not_promise_zero_remaining(self):
        self.clip.update(status="rendering", timing={"renderStartedAt": 100, "expectedRenderSeconds": 50})
        result = timing.public(self.clip, now=200)
        self.assertEqual("overdue", result["etaKind"])
        self.assertIsNone(result["remainingSeconds"])

    def test_first_render_uses_measured_sampler_rate_and_stale_rate_expires(self):
        self.clip.update(status="rendering", timing={"sampling": {"firstValue": 1, "value": 3, "total": 8, "firstObservedAt": 100, "observedAt": 120}})
        result = timing.public(self.clip, now=125)
        self.assertEqual(45, result["remainingSeconds"])
        self.assertEqual("sampling", result["etaKind"])
        self.assertIsNone(result["estimatedCompletionAt"], "sampler rate must not promise a full-video finish")
        self.assertIsNone(timing.public(self.clip, now=160)["remainingSeconds"])

    def test_progress_from_another_job_is_ignored(self):
        self.clip.update(jobId="ours", timing={})
        registry = types.SimpleNamespace(prompt_id="other", nodes={"125": {"value": 3, "max": 8}})
        modules = {"comfy_execution": types.ModuleType("comfy_execution"), "comfy_execution.progress": types.SimpleNamespace(get_progress_state=lambda: registry)}
        with patch.dict(sys.modules, modules):
            timing.observe_progress(self.clip, now=100)
            self.assertEqual({}, self.clip["timing"])
            registry.prompt_id = "ours"
            timing.observe_progress(self.clip, now=100)
            registry.nodes["125"]["value"] = 4
            timing.observe_progress(self.clip, now=110)
        self.assertEqual(3, self.clip["timing"]["sampling"]["firstValue"])
        self.assertEqual(4, self.clip["timing"]["sampling"]["value"])

    def test_legacy_completed_take_does_not_invent_timestamps(self):
        self.clip["status"] = "complete"
        result = timing.public(self.clip, now=100)
        self.assertNotIn("completedAt", result)
        self.assertIsNone(result["elapsedSeconds"])


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
        self.assertLessEqual(self.clip["timing"]["submittedAt"], self.clip["timing"]["queuedAt"])

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
        with patch.object(local_qwen, "generate", return_value=json.dumps({"prompt": BASE_PROMPT})) as generate:
            result = await qwen.ask(self.store, qwen.PROMPT, {"target":"clip"}, paths)
        self.assertEqual(BASE_PROMPT, result["prompt"])
        self.assertEqual(local_qwen.DEFAULT_MODEL, generate.call_args.args[0])
        self.assertEqual(paths, generate.call_args.args[3])
        self.assertIn(qwen.PROMPT, generate.call_args.args[1])

    async def test_qwen_model_override_is_stored_as_a_local_filename(self):
        model = "qwen3vl_8b_fp8_scaled.safetensors"
        self.store.write("qwen.json", qwen.validate_config({"model": model}))
        with patch.object(local_qwen, "generate", return_value=json.dumps({"prompt": BASE_PROMPT})) as generate:
            await qwen.ask(self.store, qwen.PROMPT, {})
        self.assertEqual(model, generate.call_args.args[0])
        self.assertEqual("comfyui", qwen.config(self.store)["runtime"])

    async def test_planning_minimizes_clips_and_validates_only_selected_reference_mode(self):
        refs, _ = qwen.reference_context(self.store, self.scene)
        plan = {"clips": [{"id": "single", "title": "Complete scene", "duration": 15,
                           "referenceIds": [], "transition": "first", "prompt": BASE_PROMPT}]}
        payload = {"script": "Actor opens a door and says Hello.", "suppliedReferences": refs}
        with patch.object(local_qwen, "generate", return_value=json.dumps(plan)) as generate:
            result = await qwen.ask(self.store, qwen.PLAN, payload)
        clean = core.validate_plan(self.scene, result)
        self.assertEqual(1, len(clean))
        self.assertEqual(15, clean[0]["duration"])
        sent = json.loads(generate.call_args.args[2])
        policy = sent["h3Prompting"]["clipPlanning"]
        self.assertEqual(15, policy["maxSeconds"])
        self.assertTrue(policy["singleClipWhenSceneFits"] and policy["preserveDialogueAndActions"])
        self.assertIn("Do not create one clip per sentence", generate.call_args.args[1])
        self.assertNotIn("h3Prompting", payload, "style metadata must not mutate saved input")
        generate.assert_called_once()

    async def test_reference_plan_leaves_later_outlines_unformatted(self):
        refs, _ = qwen.reference_context(self.store, self.scene)
        plan = {"clips": [{"id": "first", "duration": 15, "referenceIds": ["actor"], "prompt": REF_PROMPT},
                          {"id": "later", "duration": 6, "referenceIds": ["actor"], "prompt": "Later outline, awaiting actual prior frame."}]}
        with patch.object(local_qwen, "generate", return_value=json.dumps(plan)) as generate:
            self.assertEqual(plan, await qwen.ask(self.store, qwen.PLAN, {"suppliedReferences": refs}))
        generate.assert_called_once()

    async def test_h3_format_repair_once_preserves_source_payload_and_reference_binding(self):
        refs, _ = qwen.reference_context(self.store, self.scene)
        payload = {"script": "Actor says Hello.", "references": refs, "frameGuideEnabled": True, "target": {"duration": 15}}
        with patch.object(local_qwen, "generate", side_effect=['{"prompt":"Old unstructured draft"}', json.dumps({"prompt": REF_PROMPT})]) as generate:
            result = await qwen.ask(self.store, qwen.PROMPT, payload)
        self.assertEqual(REF_PROMPT, result["prompt"])
        sent = json.loads(generate.call_args.args[2])
        self.assertEqual(payload["script"], sent["script"])
        self.assertEqual(refs, sent["references"])
        self.assertEqual(15, sent["target"]["duration"])
        self.assertEqual("ref2va", sent["h3Prompting"]["mode"])
        self.assertTrue(sent["h3Prompting"]["frameGuide"])
        self.assertIn("Old unstructured draft", sent["formatRepair"]["previousResponse"])
        self.assertNotIn("formatRepair", payload)
        self.assertEqual(2, generate.call_count)

    async def test_repeated_bad_format_stops_with_actionable_error(self):
        with patch.object(local_qwen, "generate", return_value="Use the workflow") as generate:
            with self.assertRaisesRegex(ValueError, "valid H3 prompt"):
                await qwen.ask(self.store, qwen.PROMPT, {})
        self.assertEqual(2, generate.call_count)

    async def test_reference_discovery_stays_separate_from_style_and_clip_planning(self):
        discovered = {"references": []}
        with patch.object(local_qwen, "generate", return_value=json.dumps(discovered)) as generate:
            self.assertEqual(discovered, await qwen.ask(self.store, qwen.DISCOVER, {"script": "A silent room."}))
        self.assertNotIn("H3 PROMPT CONTRACT", generate.call_args.args[1])
        self.assertNotIn("h3Prompting", json.loads(generate.call_args.args[2]))
        generate.assert_called_once()

    async def test_engine_planning_uses_the_selected_projects_model(self):
        chosen = "qwen3vl_8b_fp8_scaled.safetensors"
        self.store.write(f"projects/{self.project['id']}/qwen.json", qwen.validate_config({"model": chosen}))
        mm = types.SimpleNamespace(unload_all_models=lambda: None, soft_empty_cache=lambda: None)
        comfy = types.ModuleType("comfy"); comfy.__path__ = []; comfy.model_management = mm
        self.engine.http = AsyncMock(return_value={"queue_running": [], "queue_pending": []})
        result = {"title": "Scene", "summary": "Scene summary", "references": []}
        with patch.dict(sys.modules, {"comfy": comfy, "comfy.model_management": mm}), patch.object(qwen, "ask", AsyncMock(return_value=result)) as ask:
            await self.engine.discover(self.scene, "http://unused")
        self.assertEqual(chosen, ask.call_args.kwargs["model_file"])

    async def test_explicit_scene_rename_survives_reference_discovery(self):
        self.scene.update(name="User chosen scene", autoName=False)
        self.engine.ask = AsyncMock(return_value={"title": "Generated name", "summary": "Summary", "references": []})
        await self.engine.discover(self.scene, "http://unused")
        self.assertEqual("User chosen scene", self.scene["name"])

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
        self.assertLessEqual(self.clip["timing"]["renderFinishedAt"], self.clip["timing"]["completedAt"])

    async def test_queue_position_and_render_start_are_persistable(self):
        self.clip.update(jobId="job", submittedSettings=core.DEFAULTS.copy(), status="queued", timing={"submittedAt": 100})
        self.engine.http = AsyncMock(side_effect=[{}, {"queue_running": [], "queue_pending": [[0, "ahead"], [1, "job"]]}, {}, {"queue_running": [[1, "job"]], "queue_pending": []}])
        await self.engine.check(self.scene, self.clip, "http://unused")
        self.assertEqual(2, self.clip["timing"]["queuePosition"])
        await self.engine.check(self.scene, self.clip, "http://unused")
        self.assertEqual("rendering", self.clip["status"])
        self.assertNotIn("queuePosition", self.clip["timing"])
        self.assertGreater(self.clip["timing"]["renderStartedAt"], 100)


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
