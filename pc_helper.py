"""Run on your PC: outbound ComfyUI polling + locally signed-in Codex app-server.

Python 3.10+ standard library only. No OpenAI credentials are sent to the pod.
"""
import argparse
from collections import deque
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

VERSION = "0.9.0"
CONFIG_PATH = Path.home() / ".ai-video-agent" / "helper.json"


class HelperError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def base_url(value):
    try:
        parsed = urlsplit(value.strip())
        parsed.port
    except ValueError:
        raise HelperError("Enter a valid HTTPS ComfyUI URL.") from None
    local = parsed.hostname in ("127.0.0.1", "localhost", "::1")
    if (parsed.scheme != "https" and not (local and parsed.scheme == "http")) or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise HelperError("Enter the HTTPS ComfyUI URL from your browser, without login credentials, query parameters or fragments.")
    return value.strip().rstrip("/")


class PodClient:
    def __init__(self, url, helper_id=None):
        self.url = base_url(url)
        self.helper_id = helper_id or uuid.uuid4().hex
        self.opener = build_opener(NoRedirect())

    def request(self, path, body=None, *, image=False, claim=None, timeout=15):
        headers = {"User-Agent": "ComfyUI-Codex-Helper/" + VERSION}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if claim:
            headers.update({"X-AVA-Helper": self.helper_id, "X-AVA-Claim": claim})
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        endpoint = "/ava-agent/health" if path == "health" else "/ava-agent/codex/" + path
        request = Request(self.url + endpoint, data=data, headers=headers)
        try:
            with self.opener.open(request, timeout=timeout) as response:
                limit = 20 * 1024 * 1024 if image else 2 * 1024 * 1024
                raw = response.read(limit + 1)
                if len(raw) > limit:
                    raise HelperError("The pod response exceeded the allowed size")
                return raw if image else json.loads(raw)
        except HTTPError as error:
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
    candidates = [bundled, Path("/Applications/Codex.app/Contents/Resources/codex"),
                  Path.home() / "Applications/Codex.app/Contents/Resources/codex",
                  Path("/opt/homebrew/bin/codex"), Path("/usr/local/bin/codex"), Path.home() / ".local/bin/codex"]
    executable = configured or shutil.which("codex") or next((str(path) for path in candidates if path.is_file()), None)
    if not executable:
        raise HelperError("Install Codex CLI or the Codex desktop app on this PC, then run codex login.")
    return executable


class CodexClient:
    def __init__(self, disabled_servers=()):
        # Force the existing ChatGPT login instead of inheriting API-key billing.
        environment = {key: value for key, value in os.environ.items()
                       if key not in ("OPENAI_API_KEY", "CODEX_API_KEY", "ACCESS_TOKEN") and not key.startswith(("_PYI", "PYINSTALLER_"))}
        # Frozen apps must not leak their Python/Tk library paths into Codex or its runtimes.
        for key in ("TCL_LIBRARY", "TK_LIBRARY", "PYTHONHOME", "PYTHONPATH"):
            environment.pop(key, None)
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


class Cancellation:
    def __init__(self, external):
        self.external, self.local = external, threading.Event()

    def is_set(self):
        return self.local.is_set() or self.external.is_set()

    def set(self):
        self.local.set()


def execute_job(pod, job, cancelled=None, emit=None):
    emit = emit or print
    cancelled = cancelled or threading.Event()
    stopped = threading.Event()
    cancellation = Cancellation(cancelled)
    identity = pod.identity(claimId=job["claimId"])

    def heartbeat():
        last_ok = time.monotonic()
        while not stopped.wait(10):
            if cancellation.is_set():
                return
            try:
                pod.request(f"job/{job['id']}/heartbeat", identity)
                last_ok = time.monotonic()
            except HelperError as error:
                if error.status in (400, 401, 404) or time.monotonic() - last_ok > 60:
                    cancellation.set()
                    return

    watcher = threading.Thread(target=heartbeat, daemon=True)
    watcher.start()
    client = None
    try:
        with tempfile.TemporaryDirectory(prefix="comfyui-codex-") as temporary:
            directory, paths = Path(temporary), []
            for index, image in enumerate(job["images"]):
                if cancellation.is_set():
                    raise HelperError("Planning stopped because the desktop helper disconnected or switched pods.")
                if image["index"] != index or image["suffix"] not in (".png", ".jpg", ".jpeg", ".webp"):
                    raise HelperError("The pod supplied an invalid reference-image manifest")
                raw = pod.request(f"job/{job['id']}/image/{index}", image=True, claim=job["claimId"])
                if len(raw) != image["size"] or hashlib.sha256(raw).hexdigest() != image["sha256"]:
                    raise HelperError("A reference image did not match the accepted planning request")
                path = directory / f"reference_{index}{image['suffix']}"
                path.write_bytes(raw)
                paths.append(path)
            client = CodexClient()
            client.cancelled = cancellation
            models = client.initialize()
            try:
                output = client.plan(job, paths, directory, models)
            finally:
                client.close(cancel=False)
                client = None
        result = {**identity, "output": output}
    except HelperError as error:
        result = {**identity, "error": str(error)[:1500]}
    except Exception:
        result = {**identity, "error": "The PC helper could not complete planning. Check its terminal and Codex installation."}
    finally:
        if client is not None:
            client.close(cancel=False)
    # Retrying this delivery is idempotent. Never repeat inference to recover a lost result response.
    deadline = time.monotonic() + 60
    try:
        while True:
            try:
                pod.request(f"job/{job['id']}/result", result, timeout=5 if cancelled.is_set() else 15)
                emit("Planning complete." if "output" in result else "Planning failed: " + result["error"])
                return
            except HelperError as error:
                if cancelled.is_set():
                    return
                if error.status in (400, 401, 404) or time.monotonic() > deadline:
                    raise HelperError("The planning result could not be confirmed by the pod. Check ComfyUI before retrying; the helper will stop to avoid duplicate work.") from None
                cancelled.wait(2)
    finally:
        stopped.set()
        watcher.join(timeout=16)


def load_settings():
    try:
        saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return {"url": saved.get("url", ""), "connectOnOpen": saved.get("connectOnOpen", True)}
    except (OSError, ValueError, AttributeError):
        return {"url": "", "connectOnOpen": True}


def save_settings(url, connect_on_open=True):
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps({"url": base_url(url), "connectOnOpen": bool(connect_on_open)}), encoding="utf-8")


def run_helper(url, stopped, emit, check=False):
    """One fixed pod per run: switching never sends an old result to a new URL."""
    emit("checking", "Checking your local Codex installation…")
    client = CodexClient()
    client.cancelled = Cancellation(stopped)
    try:
        models = client.initialize()
    finally:
        client.close(cancel=False)
    if stopped.is_set():
        return
    pod = PodClient(url)
    hello = pod.identity(models=models, version=VERSION)
    connected = False
    try:
        while not stopped.is_set():
            try:
                health = pod.request("health", timeout=5)
                if health.get("helper", {}).get("protocolVersion") != 2:
                    raise HelperError("Update the ComfyUI AI Video Agent custom nodes to version 0.9 or later, then restart ComfyUI.", 409)
                pod.request("connect", hello, timeout=5)
                connected = True
                emit("connected", f"Connected · {len(models)} Codex models available. Ready for planning.")
                if check:
                    return
                while not stopped.is_set():
                    job = pod.request("next", hello, timeout=5).get("job")
                    if stopped.is_set():
                        return
                    if job:
                        emit("planning", "Codex is inspecting references and preparing your prompt…")
                        # Delivery failures leave this loop entirely; do not claim/repeat inference.
                        try:
                            execute_job(pod, job, stopped, lambda message: emit("activity", message))
                        except HelperError as error:
                            raise HelperError(str(error), 409) from None
                        if not stopped.is_set():
                            emit("connected", "Connected · Ready for the next planning request.")
                    else:
                        stopped.wait(2)
            except HelperError as error:
                if error.status in (400, 401, 403, 409):
                    raise
                emit("reconnecting", str(error) + " Retrying automatically…")
                stopped.wait(3)
    finally:
        if connected:
            try:
                pod.request("disconnect", pod.identity(), timeout=5)
            except HelperError:
                pass


class HelperController:
    """Serial worker keeps UI responsive and drains one pod before moving to another."""
    def __init__(self, emit):
        self.emit = emit
        self.condition = threading.Condition()
        self.target, self.generation, self.closed = None, 0, False
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._work, daemon=True)
        self.thread.start()

    def connect(self, url):
        url = base_url(url)
        with self.condition:
            if self.target == url and not self.stopped.is_set():
                return
            self.generation += 1
            self.target = url
            self.stopped.set()
            self.emit("connecting", "Connecting to " + url + "…", url)
            self.condition.notify_all()

    def disconnect(self):
        with self.condition:
            self.generation += 1
            self.target = None
            self.stopped.set()
            self.emit("disconnected", "Disconnected. Enter a ComfyUI URL to connect.", "")
            self.condition.notify_all()

    def close(self):
        self.disconnect()
        with self.condition:
            self.closed = True
            self.condition.notify_all()

    def _work(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda: self.target is not None or self.closed)
                if self.closed:
                    return
                url, generation = self.target, self.generation
                self.stopped = threading.Event()
                stopped = self.stopped
            def update(state, message):
                with self.condition:
                    if generation == self.generation:
                        self.emit(state, message, url)
            try:
                run_helper(url, stopped, update)
            except HelperError as error:
                if not stopped.is_set():
                    update("error", str(error))
            except Exception:
                if not stopped.is_set():
                    update("error", "The helper could not start. Check that Codex is installed and signed in with ChatGPT.")
            finally:
                with self.condition:
                    if generation == self.generation:
                        self.target = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help="Your HTTPS ComfyUI browser URL")
    parser.add_argument("--check", action="store_true", help="Check Codex and the pod connection, then exit")
    args = parser.parse_args()
    url = base_url(args.url or load_settings()["url"] or input("ComfyUI HTTPS URL: "))
    save_settings(url)
    run_helper(url, threading.Event(), lambda state, message: print(message, flush=True), args.check)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Helper stopped.")
    except HelperError as error:
        print(str(error))
        raise SystemExit(1)
