"""Run on your PC: outbound ComfyUI polling + locally signed-in Codex app-server.

Python 3.10+ standard library only. No OpenAI credentials are sent to the pod.
"""
import argparse
from collections import deque
import getpass
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid

VERSION = "0.8.0"
CONFIG_PATH = Path.home() / ".ai-video-agent" / "helper.json"


class HelperError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def base_url(value):
    parsed = urlsplit(value.strip())
    local = parsed.hostname in ("127.0.0.1", "localhost", "::1")
    if (parsed.scheme != "https" and not (local and parsed.scheme == "http")) or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise HelperError("Enter the HTTPS ComfyUI URL from your browser, without login credentials, query parameters or fragments.")
    return value.strip().rstrip("/")


class PodClient:
    def __init__(self, url, token, helper_id=None):
        self.url, self.token = base_url(url), token
        self.helper_id = helper_id or uuid.uuid4().hex
        self.opener = build_opener(NoRedirect())

    def request(self, path, body=None, *, image=False, claim=None):
        headers = {"Authorization": "Bearer " + self.token, "User-Agent": "ComfyUI-Codex-Helper/" + VERSION}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if claim:
            headers.update({"X-AVA-Helper": self.helper_id, "X-AVA-Claim": claim})
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        request = Request(self.url + "/ava-agent/codex/" + path, data=data, headers=headers)
        try:
            with self.opener.open(request, timeout=15) as response:
                limit = 20 * 1024 * 1024 if image else 2 * 1024 * 1024
                raw = response.read(limit + 1)
                if len(raw) > limit:
                    raise HelperError("The pod response exceeded the allowed size")
                return raw if image else json.loads(raw)
        except HTTPError as error:
            if error.code == 401:
                raise HelperError("Pairing token rejected. Create a new token in ComfyUI Settings, then restart with --pair.", 401) from None
            try:
                detail = json.loads(error.read(4096)).get("error", "")
            except (ValueError, AttributeError):
                detail = ""
            raise HelperError(detail or f"ComfyUI returned HTTP {error.code}. Check the pod URL and connection.", error.code) from None
        except (URLError, TimeoutError, OSError, ValueError):
            raise HelperError("Could not reach ComfyUI. Check that the pod is running and its URL is current.") from None

    def identity(self, **values):
        return {"helperId": self.helper_id, **values}


def codex_executable():
    configured = os.getenv("CODEX_CLI_PATH")
    bundled = Path(os.getenv("LOCALAPPDATA", "")) / "Programs/OpenAI/Codex/bin/codex.exe"
    executable = configured or (str(bundled) if bundled.is_file() else shutil.which("codex"))
    if not executable:
        raise HelperError("Install Codex CLI or the Codex desktop app on this PC, then run codex login.")
    return executable


class CodexClient:
    def __init__(self, disabled_servers=()):
        # Force the existing ChatGPT login instead of inheriting API-key billing.
        environment = {key: value for key, value in os.environ.items()
                       if key not in ("OPENAI_API_KEY", "CODEX_API_KEY", "ACCESS_TOKEN")}
        arguments = [codex_executable(), "app-server", "--listen", "stdio://", "-c", 'model_provider="openai"',
                     "-c", "features.shell_tool=false", "-c", "features.apps=false", "-c", 'web_search="disabled"',
                     "-c", "mcp_servers={}"]
        self.disabled_servers = tuple(disabled_servers)
        if self.disabled_servers:
            entries = ",".join(json.dumps(name) + '={command="disabled-by-video-agent",enabled=false}' for name in self.disabled_servers)
            arguments.extend(["-c", "mcp_servers={" + entries + "}"])
        self.process = subprocess.Popen(arguments, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        text=True, encoding="utf-8", bufsize=1, env=environment,
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.messages, self.events = queue.Queue(), deque()
        self.sequence = 0
        self.cancelled = threading.Event()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            for line in self.process.stdout:
                if len(line) > 4 * 1024 * 1024:
                    break
                self.messages.put(json.loads(line))
        except (ValueError, OSError):
            pass
        finally:
            self.messages.put(None)

    def send(self, value):
        self.process.stdin.write(json.dumps(value, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def receive(self, deadline):
        while time.monotonic() < deadline:
            if self.cancelled.is_set():
                raise HelperError("The planning request was cancelled or its connection expired.")
            try:
                message = self.messages.get(timeout=0.5)
            except queue.Empty:
                continue
            if message is None:
                raise HelperError("Codex exited. Check your Codex installation and ChatGPT sign-in.")
            if "id" in message and "method" in message:
                # The helper never grants shell, file-write, connector or permission requests.
                self.send({"id": message["id"], "error": {"code": -32000, "message": "Only text planning is authorized; tools and permissions are unavailable."}})
                continue
            return message
        raise HelperError("Codex planning timed out. Check its connection, usage and selected model.")

    def call(self, method, params=None, timeout=30):
        self.sequence += 1
        call_id = self.sequence
        self.send({"id": call_id, "method": method, "params": params or {}})
        deadline = time.monotonic() + timeout
        while True:
            message = self.receive(deadline)
            if message.get("id") == call_id:
                if "error" in message:
                    raise HelperError(f"Codex rejected {method}. Check the installed version, model access and account policy.")
                return message["result"]
            self.events.append(message)

    def initialize(self):
        self.call("initialize", {"clientInfo": {"name": "comfyui_video_agent", "title": "ComfyUI Video Agent PC Helper", "version": VERSION},
                                 "capabilities": {"experimentalApi": True}})
        self.send({"method": "initialized"})
        if (self.call("account/read").get("account") or {}).get("type") != "chatgpt":
            raise HelperError("Sign in with ChatGPT on this PC using codex login. This helper does not use an OpenAI API key.")
        config = self.call("config/read").get("config", {})
        active_servers = [name for name, value in (config.get("mcp_servers") or {}).items() if value.get("enabled", True)]
        if active_servers:
            if self.disabled_servers:
                raise HelperError("Codex policy did not allow disabling MCP integrations for this planning worker.")
            # Empty-table overrides merge with user config. Disable each named server explicitly.
            cancellation = self.cancelled
            self.close(cancel=False)
            self.__init__(active_servers)
            self.cancelled = cancellation
            return self.initialize()
        models, cursor = [], None
        while True:
            page = self.call("model/list", {"cursor": cursor, "limit": 100})
            models.extend({"id": m["model"], "name": m.get("displayName") or m["model"], "default": bool(m.get("isDefault")),
                           "images": "image" in m.get("inputModalities", [])} for m in page.get("data", []) if not m.get("hidden"))
            cursor = page.get("nextCursor")
            if not cursor or len(models) >= 200:
                return models[:200]

    def plan(self, job, images, cwd, models):
        chosen = job.get("model") or next((m["id"] for m in models if m["default"]), None)
        selected = next((m for m in models if m["id"] == chosen), None)
        if selected is None:
            raise HelperError("Choose an available model in ComfyUI Settings; the PC's Codex model catalog changed.")
        if images and not selected["images"]:
            raise HelperError("The selected Codex model does not accept images. Choose an image-capable model in Settings.")
        instructions = job["system"] + '\nReturn the requested JSON serialized as a string in the sole field "json". Do not use tools, inspect other files, modify files, generate media, submit jobs or call external services.'
        thread = self.call("thread/start", {"model": chosen, "cwd": str(cwd), "sandbox": "read-only", "approvalPolicy": "never",
                                            "ephemeral": True, "developerInstructions": instructions})["thread"]["id"]
        schema = {"type": "object", "properties": {"json": {"type": "string"}}, "required": ["json"], "additionalProperties": False}
        self.call("turn/start", {"threadId": thread, "input": [{"type": "text", "text": job["content"]}] +
                                [{"type": "localImage", "path": str(path)} for path in images], "outputSchema": schema})
        deadline, texts = time.monotonic() + 720, {}
        while True:
            message = self.events.popleft() if self.events else self.receive(deadline)
            if message.get("params", {}).get("threadId") != thread:
                continue
            params = message["params"]
            if message.get("method") == "item/completed":
                item = params.get("item", {})
                if item.get("type") == "agentMessage" and item.get("phase") != "commentary":
                    texts[item["id"]] = item["text"]
            if message.get("method") == "turn/completed":
                if params.get("turn", {}).get("status") != "completed":
                    raise HelperError("Codex did not finish successfully. Check Codex usage, connection and model access.")
                try:
                    result = json.loads(json.loads("\n".join(texts.values()))["json"])
                    output = json.dumps(result, ensure_ascii=False)
                    if not isinstance(result, dict) or len(output) > 160000:
                        raise ValueError()
                    return output
                except (ValueError, KeyError, TypeError):
                    raise HelperError("Codex returned an invalid planning response. Saved drafts and takes were retained.") from None

    def close(self, cancel=True):
        if cancel:
            self.cancelled.set()
        if self.process.poll() is None:
            # EOF lets app-server close its child runtimes and release Windows cwd handles.
            try:
                self.process.stdin.close()
            except OSError:
                pass
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                else:
                    self.process.kill()
                self.process.wait(timeout=3)
        self.reader.join(timeout=1)
        for stream in (self.process.stdin, self.process.stdout):
            if stream:
                stream.close()


def execute_job(pod, job):
    stopped, disconnected = threading.Event(), threading.Event()
    identity = pod.identity(claimId=job["claimId"])

    def heartbeat():
        last_ok = time.monotonic()
        while not stopped.wait(10):
            try:
                pod.request(f"job/{job['id']}/heartbeat", identity)
                last_ok = time.monotonic()
            except HelperError as error:
                if error.status in (400, 401, 404) or time.monotonic() - last_ok > 60:
                    disconnected.set()
                    return

    watcher = threading.Thread(target=heartbeat, daemon=True)
    watcher.start()
    client = None
    try:
        with tempfile.TemporaryDirectory(prefix="comfyui-codex-") as temporary:
            directory, paths = Path(temporary), []
            for index, image in enumerate(job["images"]):
                if image["index"] != index or image["suffix"] not in (".png", ".jpg", ".jpeg", ".webp"):
                    raise HelperError("The pod supplied an invalid reference-image manifest")
                raw = pod.request(f"job/{job['id']}/image/{index}", image=True, claim=job["claimId"])
                if len(raw) != image["size"] or hashlib.sha256(raw).hexdigest() != image["sha256"]:
                    raise HelperError("A reference image did not match the accepted planning request")
                path = directory / f"reference_{index}{image['suffix']}"
                path.write_bytes(raw)
                paths.append(path)
            client = CodexClient()
            client.cancelled = disconnected
            models = client.initialize()
            try:
                output = client.plan(job, paths, directory, models)
            finally:
                client.close()
                client = None
        result = {**identity, "output": output}
    except HelperError as error:
        result = {**identity, "error": str(error)[:1500]}
    except Exception:
        result = {**identity, "error": "The PC helper could not complete planning. Check its terminal and Codex installation."}
    finally:
        if client is not None:
            client.close()
    # Retrying this delivery is idempotent. Never repeat inference to recover a lost result response.
    deadline = time.monotonic() + 60
    try:
        while True:
            try:
                pod.request(f"job/{job['id']}/result", result)
                print("Planning complete." if "output" in result else "Planning failed: " + result["error"], flush=True)
                return
            except HelperError as error:
                if error.status in (400, 401, 404) or time.monotonic() > deadline:
                    raise HelperError("The planning result could not be confirmed by the pod. Check ComfyUI before retrying; the helper will stop to avoid duplicate work.") from None
                time.sleep(2)
    finally:
        stopped.set()
        watcher.join(timeout=16)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help="Your HTTPS ComfyUI browser URL")
    parser.add_argument("--pair", action="store_true", help="Enter a new pairing token")
    parser.add_argument("--check", action="store_true", help="Check Codex and the pod connection, then exit")
    args = parser.parse_args()
    saved = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
    url = base_url(args.url or saved.get("url") or input("ComfyUI HTTPS URL: "))
    token = saved.get("token") if not args.pair and saved.get("url") == url else None
    token = token or getpass.getpass("Pairing token from ComfyUI Settings: ").strip()
    if not token:
        raise HelperError("A pairing token is required")
    client = CodexClient()
    try:
        models = client.initialize()
    finally:
        client.close()
    pod = PodClient(url, token)
    hello = pod.identity(models=models, version=VERSION)
    pod.request("connect", hello)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps({"url": url, "token": token}), encoding="utf-8")
    if os.name != "nt":
        CONFIG_PATH.chmod(0o600)
    print("Connected to ComfyUI with your PC's ChatGPT-signed-in Codex. No OpenAI credentials were sent to the pod.", flush=True)
    if args.check:
        return
    print("Keep this helper running while planning. Press Ctrl+C to stop.", flush=True)
    while True:
        try:
            job = pod.request("next", hello).get("job")
        except HelperError as error:
            if error.status == 401:
                raise
            print(str(error) + " Reconnecting…", flush=True)
            time.sleep(5)
            continue
        if job:
            print("Planning request " + job["id"] + "…", flush=True)
            execute_job(pod, job)
        else:
            time.sleep(2)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Helper stopped.")
    except HelperError as error:
        print(str(error))
        raise SystemExit(1)
