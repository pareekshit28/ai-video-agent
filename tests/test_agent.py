"""CPU-only contract tests. Comfy queue/model/Codex calls are mocked, media is real FFmpeg."""
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
planner = importlib.import_module(namespace.__name__ + ".planner")
media = importlib.import_module(namespace.__name__ + ".media")
engine_module = importlib.import_module(namespace.__name__ + ".engine")
codex_bridge = importlib.import_module(namespace.__name__ + ".codex_bridge")
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
REF_SECTIONS = dict(line.split(": ", 1) for line in REF_PROMPT.splitlines())
BASE_SECTIONS = dict(line.split(": ", 1) for line in BASE_PROMPT.splitlines())


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
        refs, _ = planner.reference_context(self.store, self.scene)
        self.assertEqual(BASE_PROMPT, h3_prompt.validate(BASE_PROMPT, [], 15))
        hindi = REF_PROMPT.replace("[English] Hello.", "[Hindi] दरवाज़ा खुला है।")
        self.assertEqual(hindi, h3_prompt.validate(hindi, refs, 15))
        self.assertEqual(BASE_PROMPT, h3_prompt.validate(BASE_PROMPT, refs, 15))

    def test_single_prompt_without_required_sections_or_tags_is_accepted(self):
        refs, _ = planner.reference_context(self.store, self.scene)
        plain = 'Static medium shot. Actor opens the door and says "दरवाज़ा खुला है।" with synchronized lips. The latch clicks over quiet room ambience.'
        for value in (plain, "subject_definitions: " + plain, "detailed_description: " + plain):
            for selected in ([], refs):
                with self.subTest(value=value, references=selected):
                    self.assertEqual(value, h3_prompt.normalize(value, selected, 15))

    def test_normalizes_complete_section_objects_and_formatted_text_without_changing_content(self):
        refs, _ = planner.reference_context(self.store, self.scene)
        for prompt, sections, selected in ((BASE_PROMPT, BASE_SECTIONS, []), (REF_PROMPT, REF_SECTIONS, refs)):
            variants = [dict(reversed(list(sections.items())))]
            for template in ("### {field}: {body}", "**{field}:** {body}", "**{field}**: {body}",
                             "{field}\n{body}", "## {field}\n{body}"):
                variants.append("```text\n" + "\n".join(template.format(field=field.replace("_", " ").title(), body=body)
                                for field, body in reversed(list(sections.items()))) + "\n```")
            for value in variants:
                with self.subTest(value=value):
                    expected = prompt if isinstance(value, dict) else value.removeprefix("```text\n").removesuffix("\n```")
                    self.assertEqual(expected, h3_prompt.normalize(value, selected, 15))

    def test_partial_and_duplicate_legacy_headings_are_not_required_format_gates(self):
        refs, _ = planner.reference_context(self.store, self.scene)
        for value in (REF_PROMPT.replace("retention_analysis:", "retention_notes:"),
                      REF_PROMPT + "\nsummary: Another summary.", "Here is the prompt:\n" + REF_PROMPT):
            self.assertEqual(value, h3_prompt.normalize(value, refs, 15))
        self.assertEqual("subject_definitions: Actor opens the door.",
                         h3_prompt.normalize({"subject_definitions": "Actor opens the door."}, refs, 15))

    def test_normalization_rejects_empty_oversized_nontext_or_foreign_media(self):
        refs, _ = planner.reference_context(self.store, self.scene)
        invalid = [("", "nonempty"), ("x" * 12001, "12000"), ({}, "nonempty"),
                   ({**REF_SECTIONS, "non_diegetic_music": ["N/A"]}, "string"),
                   ("Actor <Picture 1> opens the door.", "media indices"),
                   ({**REF_SECTIONS, "detailed_description": REF_SECTIONS["detailed_description"].replace("<Subject 1>", "<Subject 2>")}, "Subject labels")]
        for value, message in invalid:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, message):
                h3_prompt.normalize(value, refs, 15)

    def test_normalization_preserves_markdown_dialogue_and_soundscape_content(self):
        refs, _ = planner.reference_context(self.store, self.scene)
        prompt = REF_PROMPT.replace("[English] Hello.", "[Hindi] **दरवाज़ा खुला है।**").replace("overall_soundscape: The", "overall_soundscape: **Soft** sounds. The")
        decorated = "\n".join("**" + line.replace(":", ":**", 1) for line in prompt.splitlines())
        self.assertEqual(decorated, h3_prompt.normalize(decorated, refs, 15))

    def test_reordered_reference_inputs_keep_subject_identity_and_bind_real_media(self):
        self.scene["references"].insert(0, {"id": "room", "name": "Room", "kind": "location", "description": "Room", "assets": [self.asset]})
        refs, paths = planner.reference_context(self.store, self.scene, core.selected(self.scene, self.clip))
        self.assertEqual("<Subject 2>", refs[0]["subjectLabel"])
        self.assertEqual([self.store.path(self.asset["path"])], paths)
        self.clip["prompt"] = REF_PROMPT.replace("<Subject 1>", "<Subject 2>")
        h3_prompt.validate(self.clip["prompt"], refs, 15)
        bound = core.final_prompt(self.scene, self.clip)
        self.assertIn("<Picture 1>: Actor, <Subject 2>", bound)
        self.assertNotIn("<Picture 2>", bound)

    def test_voice_only_reference_does_not_invent_a_visual_subject(self):
        self.scene["references"][0]["assets"] = [{"path": "voice.wav", "name": "voice.wav", "kind": "audio"}]
        refs, paths = planner.reference_context(self.store, self.scene)
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

    def test_rejects_guessed_or_foreign_labels_but_allows_names_without_subject_tags(self):
        refs, _ = planner.reference_context(self.store, self.scene)
        for invalid in (REF_PROMPT + "\n<Picture 1>", REF_PROMPT + "\n<Audio 1>",
                        REF_PROMPT.replace("<Subject 1>", "<Subject 2>")):
            with self.subTest(prompt=invalid), self.assertRaises(ValueError):
                h3_prompt.validate(invalid, refs, 15)
        by_name = REF_PROMPT.replace("<Subject 1>", "Actor")
        self.assertEqual(by_name, h3_prompt.validate(by_name, refs, 15))

    def test_optional_shot_notation_is_preserved_without_format_validation(self):
        valid = BASE_PROMPT.replace("\noverall_soundscape:", " [Shot 2] At 00:06.500, the shot cuts to the open doorway.\noverall_soundscape:")
        h3_prompt.validate(valid, [], 15)
        for value in (valid.replace("00:06.500", "00:15.000"), valid.replace("00:06.500", "00:00.000"),
                        valid.replace("[Shot 2]", "[Shot 3]"), valid.replace("[Shot 1]", "[Shot 1] At 00:00.000,"),
                        valid.replace("\noverall_soundscape:", " [Shot 3] At 00:05.000, return to Actor.\noverall_soundscape:")):
            with self.subTest(prompt=value):
                self.assertEqual(value, h3_prompt.validate(value, [], 15))

    def test_plain_dialogue_does_not_need_language_tags_or_speaker_ids(self):
        valid = BASE_PROMPT.replace("\noverall_soundscape:", " Another actor (S2) replies: <d>[English] Come in.</d> Actor (S1) nods: <d>[English] Thanks.</d>\noverall_soundscape:")
        h3_prompt.validate(valid, [], 15)
        plain = 'Actor opens the door and says "Hello." Another actor replies "Come in." Actor says "Thanks."'
        self.assertEqual(plain, h3_prompt.validate(plain, [], 15))


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

    def test_codex_json_and_configuration(self):
        self.assertEqual({"a": 1}, planner.parse_json('<think>reason</think>```json\n{"a":1}\n```'))
        with self.assertRaises(ValueError): planner.parse_json("[]")
        with self.assertRaises(ValueError): planner.validate_config({"model": "../../model"})

    def test_h3_encoder_cannot_be_selected_as_a_planning_model(self):
        with self.assertRaisesRegex(ValueError, "model files"):
            planner.validate_config({"model": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"})

    def test_workflow_links_models_and_requires_explicit_render_approval(self):
        workflow = json.loads((PACKAGE / "workflow.json").read_text(encoding="utf-8"))
        models = json.loads((PACKAGE / "models.json").read_text())
        nodes = {n["type"]: n for n in workflow["nodes"]}
        self.assertEqual(2, nodes["AVAQueueReviewedClip"]["mode"])
        self.assertEqual(models, workflow["extra"]["models"])
        self.assertEqual("", nodes["AVACodexPlan"]["widgets_values"][1])
        self.assertEqual(4, len(models))
        self.assertFalse(any("4b_fp8" in model["name"] for model in models))
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

    def test_codex_model_selection_is_project_specific(self):
        other = self.store.create_project("Project B")
        chosen = "codex-alternate-test"
        self.store.write(f"projects/{self.project['id']}/codex.json", planner.validate_config({"model": chosen}))
        self.assertEqual(chosen, planner.config(self.store, self.project["id"])["model"])
        self.assertEqual("", planner.config(self.store, other["id"])["model"])
        self.assertFalse(self.store.path("codex.json").exists())

    def test_legacy_pod_model_remains_an_initial_default(self):
        chosen = "codex-alternate-test"
        self.store.write("codex.json", planner.validate_config({"model": chosen}))
        self.assertEqual(chosen, planner.config(self.store, self.project["id"])["model"])
        self.store.write(f"projects/{self.project['id']}/codex.json", planner.validate_config({"model": ""}))
        self.assertEqual("", planner.config(self.store, self.project["id"])["model"])
        self.assertEqual(chosen, planner.config(self.store)["model"])

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


class TimingTests(Fixture, unittest.TestCase):
    def setUp(self): self.setup_fixture()
    def tearDown(self): self.teardown_fixture()

    def test_sampling_eta_overrides_legacy_full_render_and_saving_estimates(self):
        self.clip.update(status="rendering", timing={"renderStartedAt": 50, "expectedRenderSeconds": 500, "expectedSaveSeconds": 100,
            "sampling": {"firstValue": 1, "value": 3, "total": 8, "firstObservedAt": 100, "observedAt": 120}})
        result = timing.public(self.clip, now=125)
        self.assertEqual(45, result["remainingSeconds"])
        self.assertEqual("sampling", result["etaKind"])
        self.assertIsNone(result["estimatedCompletionAt"])

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

    def test_loading_and_saving_have_no_eta_then_actual_completion_is_recorded(self):
        self.clip.update(status="rendering", timing={"submittedAt": 50, "renderStartedAt": 100, "expectedRenderSeconds": 100, "expectedSaveSeconds": 10})
        self.assertIsNone(timing.public(self.clip, now=150)["remainingSeconds"])
        self.clip.update(status="saving")
        self.clip["timing"]["savingStartedAt"] = 200
        self.assertIsNone(timing.public(self.clip, now=205)["remainingSeconds"])
        self.assertIsNone(timing.public(self.clip, now=205)["estimatedCompletionAt"])
        self.clip.update(status="complete")
        self.clip["timing"]["completedAt"] = 215
        result = timing.public(self.clip, now=999)
        self.assertEqual(165, result["elapsedSeconds"])
        self.assertIsNone(result["remainingSeconds"])
        self.assertEqual(215, result["completedAt"])

    def test_overdue_estimate_does_not_promise_zero_remaining(self):
        self.clip.update(status="rendering", timing={"sampling": {"firstValue": 1, "value": 3, "total": 4, "firstObservedAt": 100, "observedAt": 120}})
        result = timing.public(self.clip, now=135)
        self.assertIsNone(result["etaKind"])
        self.assertIsNone(result["remainingSeconds"])

    def test_first_render_uses_measured_sampler_rate_and_stale_rate_expires(self):
        self.clip.update(status="rendering", timing={"sampling": {"firstValue": 1, "value": 3, "total": 8, "firstObservedAt": 100, "observedAt": 120}})
        result = timing.public(self.clip, now=125)
        self.assertEqual(45, result["remainingSeconds"])
        self.assertEqual("sampling", result["etaKind"])
        self.assertIsNone(result["estimatedCompletionAt"], "sampler rate must not promise a full-video finish")
        self.assertIsNone(timing.public(self.clip, now=160)["remainingSeconds"])
        self.clip["timing"]["sampling"]["value"] = 8
        self.assertIsNone(timing.public(self.clip, now=125)["remainingSeconds"], "decoding must not inherit a sampling ETA")

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
        self.engine.plan_prompt = AsyncMock(side_effect=ValueError("Codex unavailable"))
        await self.engine.monitor(self.project["id"], self.scene["id"], "http://unused")
        await self.engine.planning_tasks[self.scene["id"]]
        saved = self.store.scene(self.project["id"], self.scene["id"])
        self.assertEqual("complete", saved["clips"][0]["status"])
        self.assertEqual("saved.mp4", saved["clips"][0]["video"]["path"])
        self.assertIn("Codex unavailable", saved["clips"][1]["error"])

    async def test_completed_clip_optimizes_next_prompt_from_actual_frame_without_holding_scene_lock(self):
        path = self.store.path(f"projects/{self.project['id']}/actual-last-frame.png")
        Image.new("RGB", (256,256), "blue").save(path)
        frame = {"path": str(path.relative_to(self.store.root)), "kind":"image", "name":path.name}
        self.clip.update(status="queued", takeId="take", jobId="job", submittedSettings=core.DEFAULTS.copy(), submittedPrompt="Actor opens the door.")
        self.scene["paused"] = False
        self.store.save_scene(self.scene)
        async def complete(scene, clip, base):
            clip.update(status="complete", frame=frame, video={"path":"saved.mp4"}, actualDuration=5)
        self.engine.check = complete
        started, finish = asyncio.Event(), asyncio.Event()
        async def inspect(base, instruction, payload, images, project_id=None):
            self.assertFalse(self.engine.lock(self.scene["id"]).locked())
            self.assertEqual([self.store.path(self.asset["path"]), path], images)
            self.assertEqual(2, payload["previousFrameAttachment"])
            self.assertEqual("Actor opens the door.", payload["previous"]["prompt"])
            started.set()
            await finish.wait()
            return {"frameAnalysis":"Actor is already at the open door; continue from that position.", "prompt":"Actor stays at the open door and says Hello."}
        self.engine.ask = inspect
        self.engine.submit = AsyncMock()
        await self.engine.monitor(self.project["id"], self.scene["id"], "http://unused")
        task = self.engine.planning_tasks[self.scene["id"]]
        try:
            await asyncio.wait_for(started.wait(), 1)
            saved = self.store.scene(self.project["id"], self.scene["id"])
            self.assertTrue(saved["planning"]["automatic"])
            self.assertEqual("running", saved["planning"]["status"])
            self.assertEqual("saved.mp4", saved["clips"][0]["video"]["path"])
            self.assertEqual("", saved["clips"][1]["prompt"])
            finish.set()
            await task
            saved = self.store.scene(self.project["id"], self.scene["id"])
            self.assertEqual("complete", saved["planning"]["status"])
            self.assertEqual("awaiting-approval", saved["clips"][1]["status"])
            self.assertIn("open door", saved["clips"][1]["frameAnalysis"])
            self.assertEqual(core.prompt_context(self.store,saved,saved["clips"][1]), saved["clips"][1]["promptContext"])
            self.engine.submit.assert_not_awaited()
        finally:
            finish.set()
            await task

    async def test_codex_json_uses_selected_model_and_images_through_bridge(self):
        paths = [self.store.path(self.asset["path"])]
        with patch.object(codex_bridge.get_bridge(self.store), "generate", return_value=json.dumps({"prompt": BASE_PROMPT})) as generate:
            result = await planner.ask(self.store, planner.PROMPT, {"target":"clip"}, paths)
        self.assertEqual(BASE_PROMPT, result["prompt"])
        self.assertEqual("", generate.call_args.args[0])
        self.assertEqual(paths, generate.call_args.args[3])
        self.assertIn(planner.PROMPT, generate.call_args.args[1])
        self.assertIn('Return {"prompt":string}', generate.call_args.args[1])
        self.assertIn("ONE complete natural-language text string", generate.call_args.args[1])
        self.assertNotIn('"prompt":{section_name', generate.call_args.args[1])

    async def test_codex_model_override_is_stored_as_a_model_id(self):
        model = "codex-alternate-test"
        self.store.write("codex.json", planner.validate_config({"model": model}))
        with patch.object(codex_bridge.get_bridge(self.store), "generate", return_value=json.dumps({"prompt": BASE_PROMPT})) as generate:
            await planner.ask(self.store, planner.PROMPT, {})
        self.assertEqual(model, generate.call_args.args[0])
        self.assertEqual("codex-pc", planner.config(self.store)["runtime"])

    async def test_planning_minimizes_clips_and_validates_only_selected_reference_mode(self):
        refs, _ = planner.reference_context(self.store, self.scene)
        plan = {"clips": [{"id": "single", "title": "Complete scene", "duration": 15,
                           "referenceIds": [], "transition": "first", "prompt": BASE_SECTIONS}]}
        payload = {"script": "Actor opens a door and says Hello.", "suppliedReferences": refs}
        with patch.object(codex_bridge.get_bridge(self.store), "generate", return_value=json.dumps(plan)) as generate:
            result = await planner.ask(self.store, planner.PLAN, payload)
        clean = core.validate_plan(self.scene, result)
        self.assertEqual(1, len(clean))
        self.assertEqual(BASE_PROMPT, clean[0]["prompt"])
        self.assertEqual(15, clean[0]["duration"])
        sent = json.loads(generate.call_args.args[2])
        policy = sent["h3Prompting"]["clipPlanning"]
        self.assertEqual(15, policy["maxSeconds"])
        self.assertTrue(policy["singleClipWhenSceneFits"] and policy["preserveDialogueAndActions"])
        self.assertIn("Do not create one clip per sentence", generate.call_args.args[1])
        self.assertNotIn("h3Prompting", payload, "style metadata must not mutate saved input")
        generate.assert_called_once()

    async def test_reference_plan_leaves_later_outlines_unformatted(self):
        refs, _ = planner.reference_context(self.store, self.scene)
        plan = {"clips": [{"id": "first", "duration": 15, "referenceIds": ["actor"], "prompt": REF_PROMPT},
                          {"id": "later", "duration": 6, "referenceIds": ["actor"], "prompt": "Later outline, awaiting actual prior frame."}]}
        with patch.object(codex_bridge.get_bridge(self.store), "generate", return_value=json.dumps(plan)) as generate:
            self.assertEqual(plan, await planner.ask(self.store, planner.PLAN, {"suppliedReferences": refs}))
        generate.assert_called_once()

    async def test_structured_plan_and_prompt_are_assembled_before_saving(self):
        refs, paths = planner.reference_context(self.store, self.scene)
        plan = {"clips": [{"id": "first", "duration": 15, "referenceIds": ["actor"], "prompt": dict(reversed(list(REF_SECTIONS.items())))},
                          {"id": "later", "duration": 6, "referenceIds": ["actor"], "prompt": "Unchanged later outline."}]}
        with patch.object(codex_bridge.get_bridge(self.store), "generate", return_value=json.dumps(plan)) as generate:
            result = await planner.ask(self.store, planner.PLAN, {"suppliedReferences": refs}, paths)
        self.assertEqual(REF_PROMPT, result["clips"][0]["prompt"])
        self.assertEqual(plan["clips"][1], result["clips"][1])
        generate.assert_called_once()
        for sections, selected, expected in ((BASE_SECTIONS, [], BASE_PROMPT), (REF_SECTIONS, refs, REF_PROMPT)):
            with patch.object(codex_bridge.get_bridge(self.store), "generate", return_value=json.dumps({"prompt": sections})) as generate:
                result = await planner.ask(self.store, planner.PROMPT, {"references": selected, "target": {"duration": 15}})
            self.assertEqual(expected, result["prompt"])
            generate.assert_called_once()

    async def test_h3_format_repair_once_preserves_source_payload_and_reference_binding(self):
        refs, _ = planner.reference_context(self.store, self.scene)
        payload = {"script": "Actor says Hello.", "references": refs, "frameGuideEnabled": True, "target": {"duration": 15}}
        with patch.object(codex_bridge.get_bridge(self.store), "generate", side_effect=['{"prompt":"Actor <Picture 1> opens the door."}', json.dumps({"prompt": REF_PROMPT})]) as generate:
            result = await planner.ask(self.store, planner.PROMPT, payload)
        self.assertEqual(REF_PROMPT, result["prompt"])
        sent = json.loads(generate.call_args.args[2])
        self.assertEqual(payload["script"], sent["script"])
        self.assertEqual(refs, sent["references"])
        self.assertEqual(15, sent["target"]["duration"])
        self.assertEqual("ref2va", sent["h3Prompting"]["mode"])
        self.assertTrue(sent["h3Prompting"]["frameGuide"])
        self.assertIn("<Picture 1>", sent["formatRepair"]["previousResponse"])
        self.assertNotIn("requiredPromptFields", sent["formatRepair"])
        self.assertNotIn("promptFieldsByMode", sent["h3Prompting"])
        self.assertNotIn("formatRepair", payload)
        self.assertEqual(2, generate.call_count)

    async def test_plain_prompt_with_only_one_legacy_heading_does_not_trigger_repair(self):
        refs, _ = planner.reference_context(self.store, self.scene)
        plain = 'subject_definitions: Actor opens the door and says "Hello." The room stays quiet.'
        payload = {"script": "Actor says Hello.", "references": refs, "target": {"duration": 15}}
        with patch.object(codex_bridge.get_bridge(self.store), "generate", return_value=json.dumps({"prompt": plain})) as generate:
            result = await planner.ask(self.store, planner.PROMPT, payload)
        self.assertEqual(plain, result["prompt"])
        sent = json.loads(generate.call_args.args[2])
        self.assertNotIn("formatRepair", sent)
        self.assertNotIn("promptFieldsByMode", sent["h3Prompting"])
        self.assertNotIn("six Ref2VA", generate.call_args.args[1])
        self.assertNotIn("formatRepair", payload)
        generate.assert_called_once()

    async def test_plain_clip_plan_preserves_codex_clip_count_and_durations_without_section_checks(self):
        refs, _ = planner.reference_context(self.store, self.scene)
        for selected in ([], ["actor"]):
            plan = {"clips": [{"id": "first", "title": "Open", "duration": 12, "referenceIds": selected,
                               "transition": "first", "prompt": 'Actor opens the door and says "Hello."'},
                              {"id": "next", "title": "Reply", "duration": 7, "referenceIds": selected,
                               "transition": "continue", "prompt": "Actor waits for a reply."}]}
            with patch.object(codex_bridge.get_bridge(self.store), "generate", return_value=json.dumps(plan)) as generate:
                result = await planner.ask(self.store, planner.PLAN, {"suppliedReferences": refs})
            clips = core.validate_plan(self.scene, result)
            self.assertEqual(2, len(clips))
            self.assertEqual([12, 7], [clip["duration"] for clip in clips])
            self.assertEqual(plan["clips"][0]["prompt"], clips[0]["prompt"])
            self.assertEqual("", clips[1]["prompt"])
            self.assertEqual(plan["clips"][1]["prompt"], clips[1]["outline"])
            generate.assert_called_once()

    async def test_repeated_bad_format_stops_with_actionable_error(self):
        with patch.object(codex_bridge.get_bridge(self.store), "generate", return_value="Use the workflow") as generate:
            with self.assertRaisesRegex(ValueError, "valid H3 prompt"):
                await planner.ask(self.store, planner.PROMPT, {})
        self.assertEqual(2, generate.call_count)

    async def test_reference_discovery_stays_separate_from_style_and_clip_planning(self):
        discovered = {"references": []}
        with patch.object(codex_bridge.get_bridge(self.store), "generate", return_value=json.dumps(discovered)) as generate:
            self.assertEqual(discovered, await planner.ask(self.store, planner.DISCOVER, {"script": "A silent room."}))
        self.assertNotIn("H3 PROMPT CONTRACT", generate.call_args.args[1])
        self.assertNotIn("h3Prompting", json.loads(generate.call_args.args[2]))
        generate.assert_called_once()

    async def test_engine_planning_uses_the_selected_projects_model(self):
        chosen = "codex-alternate-test"
        self.store.write(f"projects/{self.project['id']}/codex.json", planner.validate_config({"model": chosen}))
        mm = types.SimpleNamespace(unload_all_models=lambda: None, soft_empty_cache=lambda: None)
        comfy = types.ModuleType("comfy"); comfy.__path__ = []; comfy.model_management = mm
        self.engine.http = AsyncMock(return_value={"queue_running": [], "queue_pending": []})
        result = {"title": "Scene", "summary": "Scene summary", "references": []}
        with patch.dict(sys.modules, {"comfy": comfy, "comfy.model_management": mm}), patch.object(planner, "ask", AsyncMock(return_value=result)) as ask:
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


class PlanningRouteTests(Fixture, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.setup_fixture()
        routes = web.RouteTableDef()
        folders = types.SimpleNamespace(get_input_directory=lambda: str(self.root / "input"),
                                        get_output_directory=lambda: str(self.root / "output"))
        server = types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes)))
        spec = importlib.util.spec_from_file_location(namespace.__name__ + ".routes", PACKAGE / "routes.py")
        self.routes = importlib.util.module_from_spec(spec)
        self.modules = patch.dict(sys.modules, {"folder_paths": folders, "server": server, spec.name: self.routes})
        self.modules.start()
        spec.loader.exec_module(self.routes)
        self.engine = engine_module.Engine(self.store, self.root / "input", self.root / "output")
        self.routes._engine = self.engine
        self.gate = asyncio.Event()

        async def slow_plan(scene, base):
            await self.gate.wait()
            scene["clips"][0]["prompt"] = REF_PROMPT
        self.engine.plan = AsyncMock(side_effect=slow_plan)
        application = web.Application()
        application.add_routes(routes)
        self.client = TestClient(TestServer(application))
        await self.client.start_server()
        self.scope = {"projectId": self.project["id"], "episodeId": core.DEFAULT_EPISODE, "sceneId": self.scene["id"]}

    async def asyncTearDown(self):
        self.gate.set()
        await asyncio.gather(*list(self.engine.planning_tasks.values()), return_exceptions=True)
        await self.client.close()
        self.modules.stop()
        self.teardown_fixture()

    async def post(self, action, **values):
        return await asyncio.wait_for(self.client.post("/ava-agent/action", json={**self.scope, "action": action, **values}), 0.5)

    async def read_scene(self):
        query = "&".join(f"{key}={value}" for key, value in self.scope.items())
        response = await asyncio.wait_for(self.client.get("/ava-agent/scene?" + query), 0.5)
        self.assertEqual(200, response.status)
        self.assertEqual("no-store", response.headers["Cache-Control"])
        return await response.json()

    async def test_slow_planning_returns_immediately_and_duplicate_requests_do_not_rerun(self):
        response = await self.post("plan", requestId="request_1")
        self.assertEqual(202, response.status)
        accepted = (await response.json())["scene"]["planning"]
        self.assertEqual("running", accepted["status"])
        self.assertFalse(self.gate.is_set())
        duplicate = await self.post("plan", requestId="request_1")
        self.assertEqual(accepted, (await duplicate.json())["scene"]["planning"])
        another_tab = await self.post("plan", requestId="request_2")
        self.assertEqual("request_1", (await another_tab.json())["scene"]["planning"]["id"])
        self.assertEqual("running", (await self.read_scene())["planning"]["status"])
        self.assertEqual(1, self.engine.plan.await_count)
        self.gate.set()
        await asyncio.gather(*list(self.engine.planning_tasks.values()))
        completed = await self.read_scene()
        self.assertEqual("complete", completed["planning"]["status"])
        self.assertEqual(REF_PROMPT, completed["clips"][0]["prompt"])
        self.assertEqual("awaiting-approval", completed["clips"][0]["status"])
        self.assertNotIn("jobId", completed["clips"][0], "planning must never submit a render")
        duplicate = await self.post("plan", requestId="request_1")
        self.assertEqual("complete", (await duplicate.json())["scene"]["planning"]["status"])
        self.assertEqual(1, self.engine.plan.await_count)

    async def test_running_plan_rejects_edits_uploads_deletions_and_conflicting_jobs_quickly(self):
        await self.post("plan", requestId="request_1")
        for command, values in (("renameScene", {"name": "Changed"}), ("setDuration", {"clipId": self.clip["id"], "duration": 8}),
                                ("deleteScene", {}), ("deleteEpisode", {}), ("deleteProject", {}),
                                ("identify", {"requestId": "other"}), ("plan", {"requestId": "request_1", "comments": "Changed"})):
            with self.subTest(command=command):
                response = await self.post(command, **values)
                self.assertEqual(400, response.status)
        query = "&".join(f"{key}={value}" for key, value in self.scope.items())
        uploaded = await self.client.post("/ava-agent/upload?" + query + "&referenceId=actor")
        self.assertEqual(400, uploaded.status)
        self.assertEqual(5, self.store.scene(self.project["id"], self.scene["id"])["clips"][0]["duration"])

    async def test_background_failure_preserves_saved_drafts_and_completed_takes(self):
        self.clip.update(status="complete", takeId="saved_take", video={"path": "saved.mp4"})
        self.store.save_scene(self.scene)
        before = copy.deepcopy(self.scene["clips"])

        async def broken(scene, base):
            scene["clips"] = []
            raise ValueError("Codex failed while planning")
        self.engine.plan.side_effect = broken
        await self.post("plan", requestId="failed_request")
        await asyncio.gather(*list(self.engine.planning_tasks.values()))
        saved = self.store.scene(self.project["id"], self.scene["id"])
        self.assertEqual("failed", saved["planning"]["status"])
        self.assertIn("Codex failed", saved["planning"]["error"])
        self.assertEqual(before, saved["clips"])

    async def test_identify_prompt_and_revision_all_use_background_tasks(self):
        self.engine.discover = AsyncMock()
        self.engine.plan_prompt = AsyncMock()
        for index, command in enumerate(("identify", "planPrompt", "revisePrompt")):
            values = {"clipId": self.clip["id"], "comments": "Keep the original line."} if command != "identify" else {}
            response = await self.post(command, requestId=f"task_{index}", **values)
            self.assertEqual(202, response.status)
            await asyncio.gather(*list(self.engine.planning_tasks.values()))
            self.assertEqual("complete", (await self.read_scene())["planning"]["status"])
        self.engine.discover.assert_awaited_once()
        self.assertEqual(2, self.engine.plan_prompt.await_count)
        self.assertEqual("Keep the original line.", self.engine.plan_prompt.call_args.args[-1])

    async def test_restart_marks_interrupted_planning_failed_without_resubmitting(self):
        self.scene["planning"] = {"id": "orphan", "status": "running", "startedAt": 1}
        self.store.save_scene(self.scene)
        saved = await self.read_scene()
        self.assertEqual("failed", saved["planning"]["status"])
        self.assertIn("restart", saved["planning"]["error"])
        self.engine.plan.assert_not_awaited()

    async def test_background_planning_keeps_origin_and_episode_checks(self):
        response = await self.client.post("/ava-agent/action", headers={"Origin": "https://unrelated.example"},
                                          json={**self.scope, "action": "plan", "requestId": "bad_origin"})
        self.assertEqual(403, response.status)
        response = await self.post("plan", episodeId="wrong_episode", requestId="bad_episode")
        self.assertEqual(400, response.status)
        self.engine.plan.assert_not_awaited()

    async def test_url_only_helper_connects_and_returns_only_claimed_images(self):
        identity = {"helperId": "pc", "version": "0.9.0", "models": []}
        denied = await self.client.post("/ava-agent/codex/connect", json=identity, headers={"Origin":"https://unrelated.example"})
        self.assertEqual(403, denied.status)
        headers = {}
        connected = await self.client.post("/ava-agent/codex/connect", json=identity)
        self.assertEqual(200, connected.status)
        task = asyncio.create_task(self.engine.bridge.generate("", "system", "script", [self.store.path(self.asset["path"])]))
        try:
            await asyncio.sleep(0)
            claimed = await self.client.post("/ava-agent/codex/next", json=identity, headers=headers)
            job = (await claimed.json())["job"]
            image = await self.client.get(f"/ava-agent/codex/job/{job['id']}/image/0", headers={**headers, "X-AVA-Helper": "pc", "X-AVA-Claim": job["claimId"]})
            self.assertEqual(self.store.path(self.asset["path"]).read_bytes(), await image.read())
            denied = await self.client.get(f"/ava-agent/codex/job/{job['id']}/image/0", headers=headers)
            self.assertEqual(400, denied.status)
            result = await self.client.post(f"/ava-agent/codex/job/{job['id']}/result", headers=headers,
                                            json={"helperId": "pc", "claimId": job["claimId"], "output": "Result"})
            self.assertEqual(200, result.status)
            self.assertEqual("Result", await task)
            disconnected = await self.client.post("/ava-agent/codex/disconnect", json=identity)
            self.assertEqual(200, disconnected.status)
            self.assertFalse(self.engine.bridge.status()["connected"])
            download = await self.client.get("/ava-agent/codex/helper.py")
            self.assertEqual(200, download.status)
            self.assertIn("pc_helper.py", download.headers["Content-Disposition"])
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


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
