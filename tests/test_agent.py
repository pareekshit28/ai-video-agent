"""CPU contract tests for project scenes, ChatGPT plan imports and saved frames."""
import asyncio
import copy
import importlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

PACKAGE = Path(__file__).resolve().parents[1]
namespace = types.ModuleType("ava_tests_package")
namespace.__path__ = [str(PACKAGE)]
sys.modules[namespace.__name__] = namespace
core = importlib.import_module(namespace.__name__ + ".core")
engine_module = importlib.import_module(namespace.__name__ + ".engine")
media = importlib.import_module(namespace.__name__ + ".media")
nodes = importlib.import_module(namespace.__name__ + ".nodes")
storage_lock = importlib.import_module(namespace.__name__ + ".storage_lock")


class Fixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = core.Store(Path(self.temp.name) / "state")
        self.project = self.store.create_project("Film")
        self.scene = self.store.workspace(self.project["id"])
        path = f"projects/{self.project['id']}/actor.png"
        Image.new("RGB", (32, 32), "red").save(self.store.path(path))
        self.ref = {"id": "actor", "name": "Actor", "kind": "character", "description": "A person",
                    "assets": [{"path": path, "name": "actor.png", "kind": "image"}]}
        self.project["library"].append(self.ref)
        self.store.write(f"projects/{self.project['id']}/project.json", self.project)
        self.scene["references"] = [copy.deepcopy(self.ref)]
        self.plan = {"version": 1, "scene": "Arrival", "clips": [
            {"title": "Door", "duration": 5, "references": [{"tag": "Image 1", "name": "Actor", "type": "character"}], "use_last_frame": False,
             "prompt": "Image 1: Actor (character)\n\nStatic locked-off shot. Actor walks into frame and opens the door."},
            {"title": "Greeting", "duration": 4, "references": [{"tag": "Image 1", "name": "Actor", "type": "character"}], "use_last_frame": True,
             "prompt": "Image 1: Actor (character)\n\nStatic locked-off shot. Continue from the opening frame. Actor says hello."}]}

    def tearDown(self):
        self.temp.cleanup()

    def frame(self, take_id, clip=None):
        clip = clip or self.scene["clips"][0]
        path = f"projects/{self.project['id']}/{take_id}.jpg"
        Image.new("RGB", (32, 32), "blue").save(self.store.path(path))
        clip.update(takeId=take_id, status="complete", frame={"path": path, "name": take_id + ".jpg"},
                    extractedFrame={"path": path, "name": take_id + ".jpg"},
                    video={"path": f"projects/{self.project['id']}/{take_id}.mp4", "name": take_id + ".mp4"})

    def bind_actor(self, clip):
        clip["referenceSlots"] = core.bind_slots(self.scene, clip, [{"tag": "Image 1", "referenceId": "actor", "assetPath": self.ref["assets"][0]["path"]}])
        clip["referenceIds"] = ["actor"]
        clip["promptContext"] = core.prompt_context(self.store, self.scene, clip)


class CoreTests(Fixture, unittest.TestCase):
    def test_import_is_atomic_and_append_only(self):
        clips = core.import_plan(self.store, self.scene, self.plan)
        self.assertEqual(2, len(clips))
        self.assertEqual([], clips[0]["referenceIds"])
        self.assertEqual("Image 1", clips[0]["referenceSlots"][0]["tag"])
        self.assertEqual("", self.scene["referenceSlots"][0]["referenceId"])
        self.assertEqual(clips[0]["referenceSlots"][0]["slotId"], clips[1]["referenceSlots"][0]["slotId"])
        before = copy.deepcopy(self.scene["clips"])
        bad = copy.deepcopy(self.plan)
        bad["clips"][1]["references"][0]["tag"] = "Image 2"
        with self.assertRaisesRegex(ValueError, "numbered in order"):
            core.import_plan(self.store, self.scene, bad)
        self.assertEqual(before, self.scene["clips"])
        core.import_plan(self.store, self.scene, self.plan)
        self.assertEqual(4, len(self.scene["clips"]))

    def test_import_does_not_need_project_library(self):
        other = self.store.create_project("Other")
        workspace = self.store.workspace(other["id"])
        imported = core.import_plan(self.store, workspace, self.plan)
        self.assertEqual("Actor", imported[0]["referenceSlots"][0]["name"])
        core.ensure_ready(self.store, workspace, imported[0])
        self.assertNotIn("<Picture", core.final_prompt(workspace, imported[0]))
        self.assertEqual([], self.store.project(other["id"])["library"])

    def test_global_slots_apply_to_all_relevant_clips_without_library_writes(self):
        plan = {"version": 1, "references": [{"tag": "Image 1", "name": "Actor", "type": "character"}],
                "clips": [{"duration": 5, "use_last_frame": False, "references": ["Image 1"],
                           "prompt": "Image 1: Actor (character)\n\nStatic locked-off shot. Actor opens the door."},
                          {"duration": 4, "use_last_frame": False,
                           "prompt": "Image 1: Actor (character)\n\nStatic locked-off shot. Actor waves."}]}
        before = copy.deepcopy(self.store.project(self.project["id"])["library"])
        first, second = core.import_plan(self.store, self.scene, plan)
        self.assertEqual(1, len(self.scene["referenceSlots"]))
        slot = self.scene["referenceSlots"][0]
        self.scene["referenceSlots"] = core.bind_scene_slots(self.scene, [
            {"id": slot["id"], "referenceId": "actor", "assetPath": self.ref["assets"][0]["path"]}])
        for clip in (first, second):
            self.assertEqual("actor", core.resolved_slots(self.scene, clip)[0][1]["id"])
            self.assertIn("<Picture 1>: Actor", core.final_prompt(self.scene, clip))
            self.assertNotIn("referenceId", clip["referenceSlots"][0])
        appended = core.import_plan(self.store, self.scene, plan)
        self.assertEqual(1, len(self.scene["referenceSlots"]))
        self.assertIn("<Picture 1>: Actor", core.final_prompt(self.scene, appended[0]))
        self.assertEqual(before, self.store.project(self.project["id"])["library"])

    def test_per_clip_imports_reuse_subject_slots_when_local_tags_differ(self):
        plan = copy.deepcopy(self.plan)
        plan["clips"][1].update(use_last_frame=False, references=[
            {"tag": "Image 1", "name": "Hall", "type": "location"},
            {"tag": "Image 2", "name": "Actor", "type": "character"}],
            prompt="Image 1: Hall (location)\nImage 2: Actor (character)\n\nStatic locked-off shot. Actor waves in the hallway.")
        first, second = core.import_plan(self.store, self.scene, plan)
        self.assertEqual(2, len(self.scene["referenceSlots"]))
        self.assertEqual(first["referenceSlots"][0]["slotId"], second["referenceSlots"][1]["slotId"])
        self.bind_actor(first)
        self.assertIn("<Picture 1>: Actor", core.final_prompt(self.scene, second))
        self.assertNotIn("<Picture 2>", core.final_prompt(self.scene, second))

    def test_unfilled_slots_are_omitted_and_h3_inputs_are_compacted(self):
        voice_path = f"projects/{self.project['id']}/voice.wav"
        self.store.path(voice_path).write_bytes(b"voice fixture")
        self.scene["references"][0]["assets"].append({"path": voice_path, "name": "voice.wav", "kind": "audio"})
        refs = [{"tag": "Image 1", "name": "Missing location", "type": "location"},
                {"tag": "Image 2", "name": "Actor", "type": "character"},
                {"tag": "Audio 1", "name": "Missing ambience", "type": "location"},
                {"tag": "Audio 2", "name": "Actor voice", "type": "character"}]
        prompt = "\n".join(f"{s['tag']}: {s['name']} ({s['type']})" for s in refs) + "\n\nStatic locked-off shot. Actor says hello."
        clip = core.import_plan(self.store, self.scene, {"version": 1, "references": refs,
            "clips": [{"duration": 4, "use_last_frame": False, "prompt": prompt}]})[0]
        self.scene["referenceSlots"] = core.bind_scene_slots(self.scene, [
            {"id": s["id"], "referenceId": "actor" if s["name"].startswith("Actor") else "",
             "assetPath": voice_path if s["tag"] == "Audio 2" else self.ref["assets"][0]["path"] if s["tag"] == "Image 2" else ""}
            for s in self.scene["referenceSlots"]])
        clip["promptContext"] = core.prompt_context(self.store, self.scene, clip)
        core.ensure_ready(self.store, self.scene, clip)
        graph = core.build_h3(self.store, self.scene, clip, Path(self.temp.name) / "input", "partial")
        actual = graph["138"]["inputs"]["value"]
        self.assertIn("<Picture 1>: Actor", actual)
        self.assertIn("<Audio 1>: Actor voice", actual)
        for missing in ("Missing location", "Missing ambience", "<Picture 2>", "<Audio 2>", "Image 2"):
            self.assertNotIn(missing, actual)
        inputs = graph["136"]["inputs"]
        self.assertEqual(["ava_image_0", 0], inputs["ref_images.ref_image_0"])
        self.assertEqual(["ava_audio_0", 0], inputs["ref_audios.ref_audio_0"])
        self.assertNotIn("ref_images.ref_image_1", inputs)
        self.assertNotIn("ref_audios.ref_audio_1", inputs)

    def test_clip_subset_uses_global_order_and_excludes_unused_bound_references(self):
        refs = [{"tag": "Image 1", "name": "Actor", "type": "character"},
                {"tag": "Image 2", "name": "Hall", "type": "location"}]
        plan = {"version": 1, "references": refs, "clips": [{"duration": 4, "use_last_frame": False,
            "references": [], "prompt": "Static locked-off shot. The hallway is empty."}]}
        clip = core.import_plan(self.store, self.scene, plan)[0]
        self.assertEqual([], core.resolved_slots(self.scene, clip))
        bad = copy.deepcopy(plan)
        bad["clips"][0]["references"] = ["Image 2", "Image 1"]
        with self.assertRaisesRegex(ValueError, "scene reference order"):
            core.import_plan(self.store, self.scene, bad)

    def test_existing_clip_bindings_stay_in_their_previous_format(self):
        clip = {"id": "old", "referenceIds": ["actor"], "referenceSlots": [
            {"tag": "Image 1", "name": "Actor", "type": "character", "referenceId": "actor", "assetPath": self.ref["assets"][0]["path"]}],
            "prompt": self.plan["clips"][0]["prompt"], "status": "complete", "duration": 5, "versions": []}
        self.scene["clips"] = [clip]
        self.store.save_scene(self.scene)
        restored = self.store.workspace(self.project["id"])
        self.assertEqual([], restored["referenceSlots"])
        self.assertEqual(clip["referenceSlots"], restored["clips"][0]["referenceSlots"])
        self.assertIn("<Picture 1>: Actor", core.final_prompt(restored, restored["clips"][0]))

    def test_continuity_uses_immediately_previous_clip_and_invalidates_review(self):
        first, second = core.import_plan(self.store, self.scene, self.plan)
        self.bind_actor(first)
        self.bind_actor(second)
        with self.assertRaisesRegex(ValueError, "immediately preceding clip"):
            core.ensure_ready(self.store, self.scene, second)
        self.frame("take_one", first)
        second["promptContext"] = core.prompt_context(self.store, self.scene, second)
        core.ensure_ready(self.store, self.scene, second)
        old_key = core.approval_key(self.store, self.scene, second)
        self.frame("take_two", first)
        self.assertEqual("take_two", core.previous_frame(self.scene, second)["takeId"])
        with self.assertRaisesRegex(ValueError, "previous clip frame changed"):
            core.ensure_ready(self.store, self.scene, second)
        second["promptContext"] = core.prompt_context(self.store, self.scene, second)
        self.assertNotEqual(old_key, core.approval_key(self.store, self.scene, second))
        other = {"id": "later", "title": "Later", "status": "complete", "versions": [], "referenceIds": []}
        self.scene["clips"].append(other)
        self.frame("unrelated_newer_take", other)
        self.assertEqual("take_two", core.previous_frame(self.scene, second)["takeId"])
        core.ensure_ready(self.store, self.scene, second)
        graph = core.build_h3(self.store, self.scene, second, Path(self.temp.name) / "input", "new_take")
        self.assertEqual(["ava_frame_guide", 0], graph["126"]["inputs"]["conditioning"])
        self.assertIn("Opening Frame", graph["138"]["inputs"]["value"])
        self.assertIn("one static locked-off shot", graph["138"]["inputs"]["value"])

    def test_retake_keeps_old_video_and_frame_with_clip(self):
        first = core.import_plan(self.store, self.scene, self.plan)[0]
        self.frame("take_one", first)
        core.archive_take(first)
        self.frame("take_two", first)
        self.assertEqual(1, len(first["versions"]))
        self.assertEqual("take_one", first["versions"][0]["takeId"])
        self.assertEqual("take_one.jpg", first["versions"][0]["frame"]["name"])
        self.assertEqual(["actor"], [r["id"] for r in self.store.project(self.project["id"])["library"]])

    def test_old_last_frame_library_entries_are_removed_without_deleting_media(self):
        self.frame("old", self.scene["clips"][0] if self.scene["clips"] else core.import_plan(self.store, self.scene, self.plan)[0])
        saved = self.store.project(self.project["id"])
        path = self.scene["clips"][0]["frame"]["path"]
        saved["library"].append({"id": "frame_old", "kind": "last-frame", "assets": [{"path": path}]})
        self.store.write(f"projects/{self.project['id']}/project.json", saved)
        self.assertEqual(["actor"], [r["id"] for r in self.store.project(self.project["id"])["library"]])
        self.assertTrue(self.store.path(path).is_file())

    def test_first_scene_clip_cannot_request_continuity(self):
        plan = copy.deepcopy(self.plan)
        plan["clips"][0]["use_last_frame"] = True
        with self.assertRaisesRegex(ValueError, "first scene clip"):
            core.import_plan(self.store, self.scene, plan)

    def test_scenes_are_independent_and_share_only_project_library(self):
        second = self.store.create_scene(self.project["id"], "Departure")
        self.assertEqual([self.scene["id"], second["id"]], [s["id"] for s in self.store.scenes(self.project["id"])])
        self.assertEqual([], second["clips"])
        core.import_plan(self.store, second, self.plan)
        self.store.save_scene(second)
        self.assertEqual([], self.store.workspace(self.project["id"])["clips"])
        self.assertEqual(2, len(self.store.workspace(self.project["id"], second["id"])["clips"]))
        self.assertEqual(["actor"], [r["id"] for r in self.store.project(self.project["id"])["library"]])
        other = self.store.create_project("Other")
        with self.assertRaisesRegex(ValueError, "Scene does not belong"):
            self.store.workspace(other["id"], second["id"])

    def test_project_owns_references_and_render_settings(self):
        second = self.store.create_scene(self.project["id"], "Departure")
        for scene in (self.scene, second):
            saved = self.store.read(self.store.scene_dir(self.project["id"], scene["id"]) + "/scene.json")
            self.assertNotIn("references", saved)
            self.assertNotIn("settings", saved)
        updated = self.store.project(self.project["id"])
        updated["settings"]["steps"] = 12
        self.store.write(f"projects/{self.project['id']}/project.json", updated)
        self.assertEqual(12, self.store.workspace(self.project["id"])["settings"]["steps"])
        self.assertEqual(12, self.store.workspace(self.project["id"], second["id"])["settings"]["steps"])
        self.assertEqual(["actor"], [r["id"] for r in self.store.workspace(self.project["id"], second["id"])["references"]])

    def test_existing_scene_settings_move_to_project(self):
        project = self.store.project(self.project["id"])
        project.pop("settings")
        self.store.write(f"projects/{self.project['id']}/project.json", project)
        path = self.store.scene_dir(self.project["id"], self.scene["id"]) + "/scene.json"
        saved = self.store.read(path)
        saved["settings"] = {**core.DEFAULTS, "steps": 16}
        self.store.write(path, saved)
        self.assertEqual(16, self.store.project(self.project["id"])["settings"]["steps"])

    def test_canvas_reviewed_clip_resolves_its_scene(self):
        second = self.store.create_scene(self.project["id"], "Departure")
        second["references"] = [copy.deepcopy(self.ref)]
        clip = core.import_plan(self.store, second, self.plan)[0]
        clip["referenceSlots"] = core.bind_slots(second, clip, [
            {"tag": "Image 1", "referenceId": "actor", "assetPath": self.ref["assets"][0]["path"]}])
        clip["referenceIds"] = ["actor"]
        clip["promptContext"] = core.prompt_context(self.store, second, clip)
        self.store.save_scene(second)
        key = core.approval_key(self.store, second, clip)
        with patch.object(nodes, "store", return_value=self.store):
            prompt, seconds, steps = nodes.ReviewedClip().run(self.project["id"], clip["id"], key)
        self.assertIn("Static locked-off shot", prompt)
        self.assertEqual((5, 8), (seconds, steps))

    def test_bad_media_binding_and_duration_rejected(self):
        self.assertEqual(10, core.duration(10))
        for value in (True, 1, 10.1, 15, float("nan")):
            with self.assertRaises(ValueError): core.duration(value)
        bad = copy.deepcopy(self.plan)
        bad["clips"][0]["prompt"] = "Use <Picture 1>"
        with self.assertRaises(ValueError): core.import_plan(self.store, self.scene, bad)

    def test_import_rejects_long_or_moving_shots(self):
        bad = copy.deepcopy(self.plan)
        bad["clips"][0]["duration"] = 11
        with self.assertRaisesRegex(ValueError, "2–10 seconds"):
            core.import_plan(self.store, self.scene, bad)
        bad = copy.deepcopy(self.plan)
        bad["clips"][0]["prompt"] = "Image 1: Actor (character)\n\nA camera follows Actor."
        with self.assertRaisesRegex(ValueError, "Static locked-off shot"):
            core.import_plan(self.store, self.scene, bad)
        bad["clips"][0]["prompt"] = "Image 1: Actor (character)\n\nStatic locked-off shot. A tracking shot follows Actor."
        with self.assertRaisesRegex(ValueError, "camera movement"):
            core.import_plan(self.store, self.scene, bad)

    def test_ordered_slots_bind_exact_files_to_h3(self):
        location_path = f"projects/{self.project['id']}/station.png"
        alternate_actor_path = f"projects/{self.project['id']}/actor_profile.png"
        voice_path = f"projects/{self.project['id']}/voice.wav"
        Image.new("RGB", (32, 32), "green").save(self.store.path(location_path))
        Image.new("RGB", (32, 32), "yellow").save(self.store.path(alternate_actor_path))
        self.store.path(voice_path).write_bytes(b"voice fixture")
        location = {"id": "station", "name": "Station", "kind": "location", "description": "A platform",
                    "assets": [{"path": location_path, "name": "station.png", "kind": "image"}]}
        self.ref["assets"].append({"path": alternate_actor_path, "name": "actor_profile.png", "kind": "image"})
        self.ref["assets"].append({"path": voice_path, "name": "voice.wav", "kind": "audio"})
        self.scene["references"][0] = copy.deepcopy(self.ref)
        self.scene["references"].append(location)
        plan = {"version": 1, "clips": [{"duration": 6, "use_last_frame": False,
            "references": [{"tag": "Image 1", "name": "Actor", "type": "character"},
                           {"tag": "Image 2", "name": "Station", "type": "location"},
                           {"tag": "Audio 1", "name": "Actor voice", "type": "character"}],
            "prompt": "Image 1: Actor (character)\nImage 2: Station (location)\nAudio 1: Actor voice (character)\n\nStatic locked-off shot. Actor crosses Station and speaks in the supplied voice."}]}
        clip = core.import_plan(self.store, self.scene, plan)[0]
        core.ensure_ready(self.store, self.scene, clip)
        with self.assertRaisesRegex(ValueError, "Image 1 requires a character"):
            core.bind_slots(self.scene, clip, [{"tag": "Image 1", "referenceId": "station", "assetPath": location_path},
                                               {"tag": "Image 2"}, {"tag": "Audio 1"}])
        clip["referenceSlots"] = core.bind_slots(self.scene, clip, [
            {"tag": "Image 1", "referenceId": "actor", "assetPath": alternate_actor_path},
            {"tag": "Image 2", "referenceId": "station", "assetPath": location_path},
            {"tag": "Audio 1", "referenceId": "actor", "assetPath": voice_path}])
        clip["referenceIds"] = ["actor", "station"]
        clip["promptContext"] = core.prompt_context(self.store, self.scene, clip)
        core.ensure_ready(self.store, self.scene, clip)
        input_dir = Path(self.temp.name) / "input"
        graph = core.build_h3(self.store, self.scene, clip, input_dir, "ordered")
        prompt = graph["138"]["inputs"]["value"]
        self.assertLess(prompt.index("<Picture 1>: Actor"), prompt.index("<Picture 2>: Station"))
        self.assertLess(prompt.index("<Picture 2>: Station"), prompt.index("<Audio 1>: Actor voice"))
        self.assertEqual(["ava_image_0", 0], graph["136"]["inputs"]["ref_images.ref_image_0"])
        self.assertEqual(["ava_image_1", 0], graph["136"]["inputs"]["ref_images.ref_image_1"])
        self.assertEqual(["ava_audio_0", 0], graph["136"]["inputs"]["ref_audios.ref_audio_0"])
        for node_id, source in (("ava_image_0", alternate_actor_path),
                                ("ava_image_1", location_path), ("ava_audio_0", voice_path)):
            kind = "audio" if "audio" in node_id else "image"
            copied = input_dir / graph[node_id]["inputs"][kind]
            self.assertEqual(self.store.path(source).read_bytes(), copied.read_bytes())

    def test_slot_prompt_order_and_type_must_match_json(self):
        bad = copy.deepcopy(self.plan)
        bad["clips"][0]["prompt"] = "Image 1: Actor (location)\n\nStatic locked-off shot. Actor walks."
        with self.assertRaisesRegex(ValueError, "Prompt reference 1"):
            core.import_plan(self.store, self.scene, bad)
        bad = copy.deepcopy(self.plan)
        bad["clips"][0]["prompt"] += " Image 1 appears again."
        with self.assertRaisesRegex(ValueError, "exactly once"):
            core.import_plan(self.store, self.scene, bad)

    def test_clip_without_references_needs_no_library_selection(self):
        plan = {"version": 1, "clips": [{"duration": 3, "references": [], "use_last_frame": False,
                                         "prompt": "Static locked-off shot. An empty hallway remains still in quiet ambience."}]}
        clip = core.import_plan(self.store, self.scene, plan)[0]
        core.ensure_ready(self.store, self.scene, clip)
        self.assertEqual(([], []), core.media(self.scene, clip))

    def test_legacy_scene_migration_preserves_take(self):
        project = self.store.create_project("Legacy")
        legacy = self.store.workspace(project["id"])
        saved = self.store.project(project["id"])
        saved.pop("workspaceId")
        saved.pop("sceneIds")
        saved["episodes"] = [{"id": "episode_1", "name": "Episode 1"}]
        self.store.write(f"projects/{project['id']}/project.json", saved)
        legacy["clips"] = [{"id": "old", "title": "Saved", "duration": 2, "referenceIds": [], "status": "complete", "versions": [],
                            "takeId": "old_take", "frame": {"path": "projects/unused/frame.jpg"}, "video": {"path": "projects/unused/video.mp4"}}]
        self.store.save_scene(legacy)
        migrated = self.store.workspace(project["id"])
        self.assertEqual("old_take", migrated["clips"][0]["takeId"])
        self.assertEqual([], self.store.project(project["id"])["library"])

    def test_multiple_legacy_scenes_keep_all_clips_and_saved_paths(self):
        project = self.store.create_project("Legacy")
        first = self.store.workspace(project["id"])
        saved = self.store.project(project["id"])
        saved.pop("workspaceId")
        saved.pop("sceneIds")
        self.store.write(f"projects/{project['id']}/project.json", saved)
        first["clips"] = [{"id": "same", "title": "First", "duration": 2, "referenceIds": [], "status": "complete", "versions": [],
                           "takeId": "take_a", "frame": {"path": f"projects/{project['id']}/a.jpg"}, "video": {"path": f"projects/{project['id']}/a.mp4"}}]
        self.store.save_scene(first)
        second = {**copy.deepcopy(first), "id": "another", "clips": [{**copy.deepcopy(first["clips"][0]), "title": "Second", "takeId": "take_b"}]}
        self.store.save_scene(second)
        migrated = self.store.workspace(project["id"])
        self.assertEqual(2, len(migrated["clips"]))
        self.assertEqual(2, len({c["id"] for c in migrated["clips"]}))
        second_clip = next(c for c in migrated["clips"] if c["title"] == "Second")
        self.assertEqual("another", second_clip["storageSceneId"])
        self.assertEqual("same", second_clip["storageClipId"])
        self.assertEqual([migrated["id"]], [s["id"] for s in self.store.scenes(project["id"])])
        self.assertEqual([], self.store.project(project["id"])["library"])


class EngineTests(Fixture, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.workers, self.servers, self.urls, self.requests = [], [], [], []
        for name in ("pod-a", "pod-b"):
            worker = engine_module.Engine(core.Store(self.store.root), Path(self.temp.name) / name / "input",
                                          Path(self.temp.name) / name / "output", worker_id=name)
            worker.watch = Mock()
            self.workers.append(worker)
            app = web.Application()

            async def submit(request, worker_name=name):
                body = await request.json()
                self.requests.append((worker_name, body))
                return web.json_response({"prompt_id": body["prompt_id"]})

            app.router.add_post("/prompt", submit)
            server = TestServer(app)
            await server.start_server()
            self.servers.append(server)
            self.urls.append(str(server.make_url("")).rstrip("/"))
        template = json.loads((PACKAGE / "templates/h3-api.json").read_text())
        classes = {n["class_type"] for n in template.values()} | {"MiniMaxH3AddGuide", "LoadImage", "LoadAudio"}
        self.modules = patch.dict(sys.modules, {
            "nodes": types.SimpleNamespace(NODE_CLASS_MAPPINGS=dict.fromkeys(classes, object)),
            "execution": types.SimpleNamespace(validate_prompt=AsyncMock(return_value=(True, None, None, {})))})
        self.modules.start()
        core.import_plan(self.store, self.scene, self.plan)
        self.store.save_scene(self.scene)
        self.other_scene = self.store.create_scene(self.project["id"], "Departure")
        core.import_plan(self.store, self.other_scene, self.plan)
        self.store.save_scene(self.other_scene)

    async def asyncTearDown(self):
        self.modules.stop()
        for server in self.servers:
            await server.close()

    async def test_two_pods_render_separate_scenes_in_shared_storage(self):
        first, second = self.workers
        await first.submit(self.scene, self.scene["clips"][0], self.urls[0])
        await second.submit(self.other_scene, self.other_scene["clips"][0], self.urls[1])
        self.assertEqual(2, len(self.requests))
        for index, scene in enumerate((self.scene, self.other_scene)):
            saved = self.store.scene(scene["projectId"], scene["id"])
            self.assertEqual("queued", saved["clips"][0]["status"])
            self.assertEqual(self.workers[index].owner(self.urls[index]), saved["clips"][0]["jobOwner"])
            self.assertTrue(self.workers[index].owns(saved["clips"][0], self.urls[index]))
        before = self.store.read(self.store.scene_dir(self.project["id"], self.other_scene["id"]) + "/scene.json")
        first.http = AsyncMock()
        await first.monitor(self.project["id"], self.other_scene["id"], self.urls[0])
        first.http.assert_not_awaited()
        engine_module.Engine.watch(first, self.project["id"], self.other_scene["id"], self.urls[0])
        self.assertNotIn(self.other_scene["id"], first.tasks)
        self.assertEqual(before, self.store.read(self.store.scene_dir(self.project["id"], self.other_scene["id"]) + "/scene.json"))

    async def test_shared_scene_reservation_allows_only_one_submission_across_pods(self):
        stale = copy.deepcopy(self.scene)
        results = await asyncio.gather(self.workers[0].submit(self.scene, self.scene["clips"][0], self.urls[0]),
                                       self.workers[1].submit(stale, stale["clips"][0], self.urls[1]), return_exceptions=True)
        self.assertEqual(1, len(self.requests))
        errors = [result for result in results if isinstance(result, Exception)]
        self.assertEqual(1, len(errors))
        self.assertIn("in this scene", str(errors[0]))

    async def test_unresolved_job_in_other_scene_does_not_block_submission(self):
        self.scene["clips"][0].update(status="submission-unknown", jobOwner=self.workers[0].owner(self.urls[0]))
        self.store.save_scene(self.scene)
        await self.workers[1].submit(self.other_scene, self.other_scene["clips"][0], self.urls[1])
        self.assertEqual("queued", self.other_scene["clips"][0]["status"])
        self.assertEqual("submission-unknown", self.store.scene(self.project["id"], self.scene["id"])["clips"][0]["status"])

    async def test_legacy_resume_requires_evidence_on_the_current_pod(self):
        worker = self.workers[0]
        clip = self.scene["clips"][0]
        clip.update(status="queued", jobId="existing", takeId="take", submittedSettings=core.DEFAULTS.copy())
        worker.http = AsyncMock(side_effect=[{}, {"queue_running": [], "queue_pending": []}])
        with self.assertRaisesRegex(ValueError, "not found on this pod"):
            await worker.claim_legacy_job(self.scene, clip, self.urls[0])
        self.assertNotIn("jobOwner", clip)
        worker.http = AsyncMock(return_value={"existing": {"outputs": {}}})
        await worker.claim_legacy_job(self.scene, clip, self.urls[0])
        self.assertTrue(worker.owns(clip, self.urls[0]))
        restarted = engine_module.Engine(self.store, self.temp.name, self.temp.name, worker_id="pod-a")
        self.assertTrue(restarted.owns(clip, self.urls[0]))
        self.assertFalse(restarted.owns(clip, self.urls[1]))

    async def test_foreign_job_cannot_be_checked_on_the_wrong_pod(self):
        clip = self.scene["clips"][0]
        clip["jobOwner"] = self.workers[0].owner(self.urls[0])
        self.workers[1].http = AsyncMock()
        with self.assertRaisesRegex(ValueError, "belongs to pod pod-a"):
            await self.workers[1].check(self.scene, clip, self.urls[1])
        self.workers[1].http.assert_not_awaited()

    async def test_worker_identity_prefers_explicit_id_then_pod_id(self):
        with patch.dict(engine_module.os.environ, {"AVA_WORKER_ID": "worker-a", "RUNPOD_POD_ID": "pod-id"}):
            worker = engine_module.Engine(self.store, self.temp.name, self.temp.name)
            self.assertEqual("worker-a", worker.worker_id)
        with patch.dict(engine_module.os.environ, {"AVA_WORKER_ID": "", "RUNPOD_POD_ID": "pod-id"}):
            worker = engine_module.Engine(self.store, self.temp.name, self.temp.name)
            self.assertEqual("pod-id", worker.worker_id)


class StorageLockTests(Fixture, unittest.IsolatedAsyncioTestCase):
    async def test_another_process_waits_for_the_shared_file_lock(self):
        script = """
import asyncio, importlib.util, os, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('storage_lock', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
async def run():
    try:
        async with module.StorageLock(Path(sys.argv[2]), timeout=0.15):
            print('acquired', flush=True)
            if len(sys.argv) > 3:
                os._exit(0)
    except ValueError:
        print('busy')
asyncio.run(run())
"""
        path = self.store.path(".locks/test.lock")

        async def probe(crash=False):
            process = await asyncio.create_subprocess_exec(sys.executable, "-c", script, str(PACKAGE / "storage_lock.py"), str(path), *(["crash"] if crash else []),
                                                           stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            output, error = await asyncio.wait_for(process.communicate(), 10)
            self.assertEqual(0, process.returncode, error.decode())
            return output.decode().strip()

        async with storage_lock.StorageLock(path):
            self.assertEqual("busy", await probe())
        self.assertEqual("acquired", await probe())
        self.assertEqual("acquired", await probe(crash=True))
        self.assertEqual("acquired", await probe())


class RouteTests(Fixture, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        route_table = web.RouteTableDef()
        folders = types.SimpleNamespace(get_input_directory=lambda: self.temp.name, get_output_directory=lambda: self.temp.name,
                                        get_filename_list=lambda kind: [])
        server = types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=route_table)))
        spec = importlib.util.spec_from_file_location(namespace.__name__ + ".routes", PACKAGE / "routes.py")
        self.routes = importlib.util.module_from_spec(spec)
        self.modules = patch.dict(sys.modules, {"folder_paths": folders, "server": server, spec.name: self.routes})
        self.modules.start()
        spec.loader.exec_module(self.routes)
        self.eng = engine_module.Engine(self.store, self.temp.name, self.temp.name)
        self.eng.watch = lambda *args: None
        self.routes._engine = self.eng
        app = web.Application()
        app.add_routes(route_table)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.modules.stop()

    async def post(self, command, **values):
        return await self.client.post("/ava-agent/action", json={"projectId": self.project["id"], "action": command, **values})

    async def test_import_retry_is_idempotent_and_state_has_scenes(self):
        library_before = copy.deepcopy(self.store.project(self.project["id"])["library"])
        first = await self.post("importPlan", plan=self.plan, requestId="one")
        self.assertEqual(200, first.status)
        second = await self.post("importPlan", plan=self.plan, requestId="one")
        self.assertEqual(200, second.status)
        state = await (await self.client.get("/ava-agent/state?projectId=" + self.project["id"])).json()
        self.assertEqual(2, len(state["workspace"]["clips"]))
        self.assertNotIn("episodes", state)
        self.assertEqual([self.scene["id"]], [s["id"] for s in state["scenes"]])
        self.assertNotIn("planner", state)
        self.assertEqual(library_before, state["project"]["library"])
        self.assertEqual(1, len(state["workspace"]["referenceSlots"]))
        self.assertEqual(200, (await self.client.get("/ava-agent/scene-planning-skill")).status)

    async def test_foreign_job_is_visible_without_starting_local_monitoring(self):
        clip = core.import_plan(self.store, self.scene, self.plan)[0]
        clip.update(status="queued", jobId="foreign", takeId="foreign_take", submittedSettings=core.DEFAULTS.copy(),
                    jobOwner={"workerId": "other-pod", "comfyUrl": "http://127.0.0.1:8188"})
        self.scene["paused"] = False
        self.store.save_scene(self.scene)
        self.eng.watch = Mock()
        before = self.store.read(self.store.scene_dir(self.project["id"], self.scene["id"]) + "/scene.json")
        state = await (await self.client.get("/ava-agent/state", params={"projectId": self.project["id"]})).json()
        self.assertFalse(state["workspace"]["clips"][0]["canManageJob"])
        self.eng.watch.assert_not_called()
        for command in ("pause", "resume", "recover", "acknowledgeMissingJob"):
            response = await self.post(command, clipId=clip["id"], jobId="foreign", confirmed=True)
            self.assertEqual(400, response.status, command)
            self.assertIn("belongs to pod other-pod", (await response.json())["error"])
        self.assertEqual(before, self.store.read(self.store.scene_dir(self.project["id"], self.scene["id"]) + "/scene.json"))

    async def test_local_job_monitoring_restores_after_restart(self):
        clip = core.import_plan(self.store, self.scene, self.plan)[0]
        base = str(self.client.make_url("")).rstrip("/")
        clip.update(status="queued", jobId="local", jobOwner=self.eng.owner(base))
        self.scene["paused"] = False
        self.store.save_scene(self.scene)
        self.eng.watch = Mock()
        state = await (await self.client.get("/ava-agent/state", params={"projectId": self.project["id"]})).json()
        self.assertTrue(state["workspace"]["clips"][0]["canManageJob"])
        self.eng.watch.assert_called_once_with(self.project["id"], self.scene["id"], base)

    async def test_resuming_an_untracked_job_claims_only_a_known_local_job(self):
        clip = core.import_plan(self.store, self.scene, self.plan)[0]
        clip.update(status="queued", jobId="local", takeId="take", submittedSettings=core.DEFAULTS.copy())
        self.store.save_scene(self.scene)
        self.eng.http = AsyncMock(side_effect=[{}, {"queue_running": [], "queue_pending": []}])
        response = await self.post("resume", clipId=clip["id"])
        self.assertEqual(400, response.status)
        self.eng.http = AsyncMock(return_value={"local": {"outputs": {}}})
        response = await self.post("resume", clipId=clip["id"])
        self.assertEqual(200, response.status)
        self.assertTrue(self.eng.owns((await response.json())["workspace"]["clips"][0], str(self.client.make_url("")).rstrip("/")))

    async def test_scene_reference_save_updates_all_clip_prompts_and_review_keys(self):
        plan = copy.deepcopy(self.plan)
        plan["clips"][1]["use_last_frame"] = False
        await self.post("importPlan", plan=plan, requestId="one")
        initial = self.store.workspace(self.project["id"])
        old_keys = [core.approval_key(self.store, initial, c) for c in initial["clips"]]
        response = await self.post("saveSceneReferences", referenceSlots=[{
            "id": initial["referenceSlots"][0]["id"], "referenceId": "actor", "assetPath": self.ref["assets"][0]["path"]}])
        self.assertEqual(200, response.status)
        workspace = (await response.json())["workspace"]
        for index, clip in enumerate(workspace["clips"]):
            self.assertIn("<Picture 1>: Actor", clip["renderPrompt"])
            self.assertNotIn("Image 1:", clip["promptBody"])
            self.assertTrue(clip["reviewKey"])
            self.assertNotEqual(old_keys[index], clip["reviewKey"])
        exported = await (await self.post("exportGraph", clipId=workspace["clips"][0]["id"])).json()
        self.assertEqual(workspace["clips"][0]["renderPrompt"], exported["graph"]["138"]["inputs"]["value"])
        saved = await self.post("saveClip", clipId=workspace["clips"][0]["id"],
            promptBody="Static locked-off shot. Actor waves.", duration=5, use_last_frame=False)
        self.assertEqual(200, saved.status)
        removed = await self.post("saveSceneReferences", referenceSlots=[{"id": workspace["referenceSlots"][0]["id"], "referenceId": "", "assetPath": ""}])
        self.assertEqual(200, removed.status)
        for clip in (await removed.json())["workspace"]["clips"]:
            self.assertNotIn("<Picture", clip["renderPrompt"])
            self.assertEqual(["Actor"], clip["omittedReferences"])

    async def test_create_scene_selects_clip_scope_and_keeps_project_videos(self):
        created = await (await self.post("createScene", name="Departure")).json()
        scene_id = created["scene"]["id"]
        response = await self.post("importPlan", sceneId=scene_id, plan=self.plan, requestId="one")
        self.assertEqual(200, response.status)
        default = await (await self.client.get("/ava-agent/state", params={"projectId": self.project["id"]})).json()
        selected = await (await self.client.get("/ava-agent/state", params={"projectId": self.project["id"], "sceneId": scene_id})).json()
        self.assertEqual([], default["workspace"]["clips"])
        self.assertEqual(2, len(selected["workspace"]["clips"]))
        self.assertEqual(["Scene 1", "Departure"], [s["name"] for s in selected["scenes"]])
        saved_scene = self.store.workspace(self.project["id"], scene_id)
        clip = saved_scene["clips"][0]
        self.frame("scene_take", clip)
        self.store.save_scene(saved_scene)
        videos = await (await self.client.get("/ava-agent/state", params={"projectId": self.project["id"]})).json()
        self.assertEqual("Departure", videos["videos"][0]["sceneName"])
        other = self.store.create_project("Other")
        denied = await self.client.post("/ava-agent/action", json={"action": "saveSettings", "projectId": other["id"], "sceneId": scene_id, "settings": core.DEFAULTS})
        self.assertEqual(400, denied.status)

    async def test_settings_apply_across_scenes_and_scene_response_only_has_clips(self):
        created = await (await self.post("createScene", name="Departure")).json()
        scene_id = created["scene"]["id"]
        response = await self.post("saveSettings", sceneId=scene_id, settings={**core.DEFAULTS, "steps": 12})
        self.assertEqual(200, response.status)
        state = await (await self.client.get("/ava-agent/state", params={"projectId": self.project["id"]})).json()
        self.assertEqual(12, state["project"]["settings"]["steps"])
        self.assertEqual(12, self.store.workspace(self.project["id"])["settings"]["steps"])
        self.assertEqual(12, self.store.workspace(self.project["id"], scene_id)["settings"]["steps"])
        self.assertEqual(["actor"], [r["id"] for r in state["project"]["library"]])
        for field in ("references", "settings", "script", "summary", "imports"):
            self.assertNotIn(field, state["workspace"])

    async def test_library_reference_in_another_scene_cannot_be_removed(self):
        second = self.store.create_scene(self.project["id"], "Departure")
        clip = core.import_plan(self.store, second, self.plan)[0]
        clip["referenceIds"] = [self.ref["id"]]
        self.store.save_scene(second)
        response = await self.post("removeLibrary", referenceId=self.ref["id"])
        self.assertEqual(400, response.status)

    async def test_save_approve_is_review_bound(self):
        await self.post("importPlan", plan=self.plan, requestId="one")
        saved = self.store.workspace(self.project["id"])
        clip = saved["clips"][0]
        response = await self.post("saveClip", clipId=clip["id"], prompt=clip["prompt"],
                                   referenceSlots=[{"tag": "Image 1", "referenceId": "actor", "assetPath": self.ref["assets"][0]["path"]}],
                                   use_last_frame=False, duration=5)
        self.assertEqual(200, response.status)
        review = (await response.json())["workspace"]["clips"][0]["reviewKey"]
        rejected = await self.post("approveGenerate", clipId=clip["id"], reviewKey="wrong")
        self.assertEqual(400, rejected.status)
        self.assertTrue(review)

    async def test_slot_selection_rejects_other_project_item(self):
        await self.post("importPlan", plan=self.plan, requestId="one")
        clip = self.store.workspace(self.project["id"])["clips"][0]
        other = self.store.create_project("Other")
        other_project = self.store.project(other["id"])
        other_project["library"].append({"id": "other_actor", "name": "Actor", "kind": "character", "description": "Other project",
                                         "assets": [{"path": f"projects/{other['id']}/actor.png", "name": "actor.png", "kind": "image"}]})
        self.store.write(f"projects/{other['id']}/project.json", other_project)
        response = await self.post("saveClip", clipId=clip["id"], prompt=clip["prompt"],
                                   referenceSlots=[{"tag": "Image 1", "referenceId": "other_actor", "assetPath": f"projects/{other['id']}/actor.png"}],
                                   use_last_frame=False, duration=5)
        self.assertEqual(400, response.status)
        self.assertEqual("", self.store.workspace(self.project["id"])["referenceSlots"][0]["referenceId"])

    async def test_project_media_cannot_cross_into_another_project(self):
        other = self.store.create_project("Other")
        denied = await self.client.get("/ava-agent/media", params={"projectId": other["id"], "path": self.ref["assets"][0]["path"]})
        self.assertEqual(400, denied.status)
        allowed = await self.client.get("/ava-agent/media", params={"projectId": self.project["id"], "path": self.ref["assets"][0]["path"]})
        self.assertEqual(200, allowed.status)

    async def test_render_completion_keeps_last_frame_on_clip(self):
        clip = core.import_plan(self.store, self.scene, self.plan)[0]
        source = f"projects/{self.project['id']}/source.mp4"
        media.command(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x128:rate=24:duration=2.3", "-c:v", "libx264", str(self.store.path(source))])
        clip.update(source={"path": source}, duration=2, takeId="take", status="saving", submittedSettings=core.DEFAULTS.copy())
        await self.eng.check(self.scene, clip, "http://unused")
        self.assertEqual("complete", clip["status"])
        self.assertTrue(self.store.path(clip["frame"]["path"]).is_file())
        self.assertEqual(["actor"], [r["id"] for r in self.store.project(self.project["id"])["library"]])

    async def test_state_exposes_preceding_clip_frame_without_library_entry(self):
        first, second = core.import_plan(self.store, self.scene, self.plan)
        self.frame("previous_take", first)
        self.store.save_scene(self.scene)
        response = await self.client.get("/ava-agent/state?projectId=" + self.project["id"])
        state = await response.json()
        self.assertEqual("previous_take", state["workspace"]["clips"][1]["previousFrame"]["takeId"])
        self.assertEqual(["actor"], [r["id"] for r in state["project"]["library"]])


class MediaTests(Fixture, unittest.TestCase):
    def test_real_finalization_keeps_last_frame_with_clip(self):
        clip = core.import_plan(self.store, self.scene, self.plan)[0]
        source = f"projects/{self.project['id']}/source.mp4"
        media.command(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x128:rate=24:duration=2.3", "-c:v", "libx264", str(self.store.path(source))])
        clip.update(source={"path": source}, duration=2, takeId="take", submittedSettings=core.DEFAULTS.copy())
        clip.update(media.finalize(self.store, self.scene, clip))
        self.assertTrue(self.store.path(clip["frame"]["path"]).is_file())
        self.assertAlmostEqual(2, clip["actualDuration"], places=2)
        self.assertEqual(["actor"], [r["id"] for r in self.store.project(self.project["id"])["library"]])


if __name__ == "__main__":
    unittest.main()
