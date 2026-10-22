"""URL-only desktop connections, pod switching, ownership and recovery; no GPU needed."""
import asyncio
from collections import deque
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

from test_agent import Fixture, PACKAGE, codex_bridge

spec = importlib.util.spec_from_file_location("ava_pc_helper_tests", PACKAGE / "pc_helper.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
MODELS = [{"id": "codex-test", "name": "Codex test", "default": True, "images": True}]


class BridgeTests(Fixture, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.setup_fixture()
        self.bridge = codex_bridge.CodexBridge(self.store)
        self.bridge.touch("pc", MODELS, helper.VERSION)
        self.tasks = []

    async def asyncTearDown(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.teardown_fixture()

    async def enqueue(self, images=()):
        task = asyncio.create_task(self.bridge.generate("", "system", '{"script":"Hello"}', images))
        self.tasks.append(task)
        await asyncio.sleep(0)
        return task

    def claim(self, helper_id="pc"):
        return self.bridge.claim(helper_id, MODELS, helper.VERSION)

    async def test_disconnect_fails_owned_work_and_reports_offline(self):
        task = await self.enqueue()
        self.claim()
        self.bridge.disconnect("pc")
        self.assertFalse(self.bridge.status()["connected"])
        with self.assertRaisesRegex(ValueError, "disconnected or switched pods"):
            await task

    async def test_old_connection_credentials_are_discarded_on_upgrade(self):
        self.store.write("codex/bridge.json", {"tokenHash": "obsolete", "pairedAt": 1, "lastSeen": time.time(), "models": MODELS})
        upgraded = codex_bridge.CodexBridge(self.store)
        self.assertNotIn("tokenHash", upgraded.settings())
        self.assertNotIn("paired", upgraded.status())
        self.assertFalse(upgraded.status()["connected"])
        self.assertEqual(2, upgraded.status()["protocolVersion"])

    async def test_claim_is_exclusive_and_lost_claim_response_recovers_same_job(self):
        task = await self.enqueue()
        first = self.claim()
        self.assertEqual(first, self.claim())
        self.assertIsNone(self.claim("another_pc"))
        self.assertNotIn("token", first)
        self.bridge.complete(first["id"], "pc", first["claimId"], '{"prompt":"Actor opens a door."}')
        self.assertEqual('{"prompt":"Actor opens a door."}', await task)
        self.assertIsNone(self.claim())

    async def test_results_are_idempotent_and_cannot_be_changed_or_sent_by_other_helper(self):
        task = await self.enqueue()
        job = self.claim()
        with self.assertRaisesRegex(ValueError, "does not own"):
            self.bridge.complete(job["id"], "foreign", job["claimId"], "wrong")
        self.bridge.complete(job["id"], "pc", job["claimId"], "result")
        self.bridge.complete(job["id"], "pc", job["claimId"], "result")
        with self.assertRaisesRegex(ValueError, "already recorded"):
            self.bridge.complete(job["id"], "pc", job["claimId"], "changed")
        self.assertEqual("result", await task)

    async def test_images_preserve_order_and_only_claimed_request_files_can_be_read(self):
        image = self.store.path(self.asset["path"])
        task = await self.enqueue([image, image])
        job = self.claim()
        self.assertEqual([0, 1], [i["index"] for i in job["images"]])
        self.assertTrue(all("path" not in i for i in job["images"]))
        self.assertEqual(image, self.bridge.image(job["id"], 0, "pc", job["claimId"]))
        with self.assertRaises(ValueError):
            self.bridge.image(job["id"], 2, "pc", job["claimId"])
        with self.assertRaises(ValueError):
            self.bridge.image(job["id"], 0, "foreign", job["claimId"])
        self.bridge.complete(job["id"], "pc", job["claimId"], "ok")
        await task

    async def test_expired_claim_fails_without_reassignment_or_accepting_late_result(self):
        task = await self.enqueue()
        job = self.claim()
        saved = self.store.read(self.bridge.path(job["id"]))
        saved["leaseUntil"] = time.time() - 1
        self.bridge.save(saved)
        self.assertIsNone(self.claim("new_pc"))
        with self.assertRaisesRegex(ValueError, "already recorded"):
            self.bridge.complete(job["id"], "pc", job["claimId"], "late result")
        with self.assertRaisesRegex(ValueError, "not reassigned"):
            await task

    async def test_heartbeat_renews_claim_and_reports_online_without_exposing_paths(self):
        task = await self.enqueue()
        job = self.claim()
        self.bridge.heartbeat(job["id"], "pc", job["claimId"])
        saved = self.store.read(self.bridge.path(job["id"]))
        self.assertGreater(saved["leaseUntil"], time.time() + 80)
        self.assertTrue(self.bridge.status()["connected"])
        self.assertEqual(MODELS, self.bridge.status()["models"])
        self.assertNotIn("root", self.bridge.status())
        self.bridge.complete(job["id"], "pc", job["claimId"], "ok")
        await task

    async def test_server_restart_cancels_orphaned_jobs(self):
        task = await self.enqueue()
        restarted = codex_bridge.CodexBridge(self.store)
        self.assertIsNone(restarted.claim("pc", MODELS, helper.VERSION))
        with self.assertRaisesRegex(ValueError, "ComfyUI restarted"):
            await task

    async def test_offline_helper_and_files_outside_store_are_rejected(self):
        self.store.write("codex/bridge.json", {"lastSeen": 1})
        with self.assertRaisesRegex(ValueError, "offline"):
            await self.bridge.generate("", "system", "script")
        self.bridge.touch("pc", MODELS, helper.VERSION)
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "private.png"
            image.write_bytes(b"private")
            with self.assertRaisesRegex(ValueError, "saved reference images"):
                await self.bridge.generate("", "system", "script", [image])


class HelperTests(unittest.TestCase):
    def test_codex_turn_uses_default_model_image_order_and_readonly_ephemeral_thread(self):
        client = object.__new__(helper.CodexClient)
        client.call = MagicMock(side_effect=[{"thread": {"id": "thread"}}, {}])
        client.events = deque([
            {"method": "item/completed", "params": {"threadId": "thread", "item": {"id": "answer", "type": "agentMessage", "phase": "final_answer", "text": json.dumps({"json": '{"prompt":"A quiet room."}'})}}},
            {"method": "turn/completed", "params": {"threadId": "thread", "turn": {"status": "completed"}}}])
        result = client.plan({"model": "", "system": "Preserve the script", "content": "Story"},
                             [Path("first.png"), Path("prior-frame.png")], Path.cwd(), MODELS)
        self.assertEqual({"prompt": "A quiet room."}, json.loads(result))
        params = client.call.call_args_list[0].args[1]
        self.assertEqual("codex-test", params["model"])
        self.assertEqual("read-only", params["sandbox"])
        self.assertEqual("never", params["approvalPolicy"])
        self.assertTrue(params["ephemeral"])
        inputs = client.call.call_args_list[1].args[1]["input"]
        self.assertEqual(["first.png", "prior-frame.png"], [value["path"] for value in inputs if value["type"] == "localImage"])

    def test_helper_requires_chatgpt_signin_without_api_key_fallback(self):
        client = object.__new__(helper.CodexClient)
        client.call = MagicMock(side_effect=[{}, {"account": {"type": "apiKey"}}])
        client.send = MagicMock()
        with self.assertRaisesRegex(helper.HelperError, "Sign in with ChatGPT"):
            client.initialize()

    def test_remote_url_requires_https_and_excludes_credentials_and_tokens(self):
        self.assertEqual("https://pod.proxy.runpod.net", helper.base_url("https://pod.proxy.runpod.net/"))
        self.assertEqual("http://127.0.0.1:8199", helper.base_url("http://127.0.0.1:8199"))
        for url in ("http://remote.example", "https://user:password@pod.example", "https://pod.example?token=secret", "file:///tmp/x", "https://[", "https://pod.example:invalid"):
            with self.subTest(url=url), self.assertRaises(helper.HelperError):
                helper.base_url(url)

    def test_helper_retries_result_delivery_without_repeating_codex_inference(self):
        pod = MagicMock(helper_id="pc")
        pod.identity.side_effect = lambda **values: {"helperId": "pc", **values}
        calls = []
        def request(path, body=None, **kwargs):
            calls.append((path, body))
            if len(calls) == 1:
                raise helper.HelperError("Lost result response")
            return {"ok": True}
        pod.request.side_effect = request
        client = MagicMock()
        client.initialize.return_value = MODELS
        client.plan.return_value = '{"prompt":"Actor opens a door."}'
        with patch.object(helper, "CodexClient", return_value=client):
            helper.execute_job(pod, {"id": "request", "claimId": "claim", "images": []})
        client.plan.assert_called_once()
        self.assertEqual(2, len(calls))
        self.assertEqual(calls[0], calls[1])
        client.close.assert_called_once()

    def test_helper_rejects_changed_image_without_calling_codex(self):
        pod = MagicMock(helper_id="pc")
        pod.identity.return_value = {"helperId": "pc", "claimId": "claim"}
        pod.request.side_effect = [b"changed", {"ok": True}]
        job = {"id": "request", "claimId": "claim", "images": [{"index": 0, "suffix": ".png", "size": 3, "sha256": hashlib.sha256(b"old").hexdigest()}]}
        with patch.object(helper, "CodexClient") as client:
            helper.execute_job(pod, job)
        client.assert_not_called()
        self.assertIn("did not match", pod.request.call_args.args[1]["error"])

    def test_saved_settings_keep_only_url_and_preference(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(helper, "CONFIG_PATH", Path(directory)/"helper.json"):
            helper.CONFIG_PATH.write_text('{"url":"https://old.example","token":"obsolete"}')
            self.assertNotIn("token", helper.load_settings())
            helper.save_settings("https://new.example/", False)
            self.assertEqual({"url":"https://new.example", "connectOnOpen":False}, json.loads(helper.CONFIG_PATH.read_text()))

    def test_controller_switches_pods_serially_and_ignores_stale_updates(self):
        first, second = threading.Event(), threading.Event()
        calls, events = [], []
        def run(url, stopped, emit):
            calls.append(("start", url))
            if url == "https://first.example":
                first.set()
            else:
                second.set()
            stopped.wait(3)
            emit("activity", "Old request stopped")
            calls.append(("stop", url))
        with patch.object(helper, "run_helper", side_effect=run):
            controller = helper.HelperController(lambda *event: events.append(event))
            try:
                controller.connect("https://first.example")
                self.assertTrue(first.wait(2))
                controller.connect("https://first.example")
                controller.connect("https://second.example")
                self.assertTrue(second.wait(2))
                self.assertEqual([("start","https://first.example"),("stop","https://first.example"),("start","https://second.example")], calls)
                self.assertFalse(any(state=="activity" and url=="https://first.example" for state,message,url in events))
            finally:
                controller.close()
                controller.thread.join(3)
            self.assertFalse(controller.thread.is_alive())

    def test_connection_uses_only_url_and_no_authorization_header(self):
        pod = helper.PodClient("https://pod.example")
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok":true}'
        pod.opener.open = MagicMock(return_value=response)
        pod.request("connect", pod.identity(models=MODELS,version=helper.VERSION))
        request = pod.opener.open.call_args.args[0]
        self.assertIsNone(request.get_header("Authorization"))
        self.assertEqual("https://pod.example/ava-agent/codex/connect", request.full_url)


if __name__ == "__main__":
    unittest.main()
