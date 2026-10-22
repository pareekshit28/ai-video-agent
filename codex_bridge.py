"""Persisted planning queue consumed by the user's outbound PC helper."""
import asyncio
import hashlib
from pathlib import Path
import secrets
import time
from . import core

LEASE_SECONDS = 90
ONLINE_SECONDS = 45
JOB_SECONDS = 900
_bridges = {}


def get_bridge(store):
    key = str(store.root)
    if key not in _bridges:
        _bridges[key] = CodexBridge(store)
    return _bridges[key]


class CodexBridge:
    def __init__(self, store):
        self.store = store
        self.pending = set()
        # Version 0.9 connects by URL. Discard obsolete pairing credentials.
        saved = self.settings()
        self.store.write("codex/bridge.json", {k: v for k, v in saved.items()
                                              if k in ("helperId", "helperVersion", "models")} | {"lastSeen": 0})
        for job in self.jobs():
            if job["status"] in ("queued", "running"):
                self.fail(job, "ComfyUI restarted during this planning request. Explicitly retry from the workspace.")

    def settings(self):
        return self.store.read("codex/bridge.json") if self.store.path("codex/bridge.json").exists() else {}

    def status(self):
        saved = self.settings()
        return {"protocolVersion": 2, "connected": time.time() - saved.get("lastSeen", 0) < ONLINE_SECONDS,
                "lastSeen": saved.get("lastSeen"), "helperVersion": saved.get("helperVersion"), "models": saved.get("models", [])}

    def disconnect(self, helper_id):
        for job_id in list(self.pending):
            job = self.store.read(self.path(job_id))
            if job.get("helperId") == helper_id and job["status"] == "running":
                self.fail(job, "The desktop helper disconnected or switched pods. Reconnect and explicitly retry planning.")
        saved = self.settings()
        if saved.get("helperId") == helper_id:
            saved["lastSeen"] = 0
            self.store.write("codex/bridge.json", saved)

    def path(self, job_id):
        return f"codex/jobs/{core.identifier(job_id)}.json"

    def jobs(self):
        return [self.store.read(str(p.relative_to(self.store.root))) for p in self.store.path("codex/jobs").glob("*.json")]

    def save(self, job):
        self.store.write(self.path(job["id"]), job)

    def fail(self, job, error):
        job.update(status="failed", error=error, finishedAt=time.time())
        self.save(job)
        self.pending.discard(job["id"])

    def expire(self, job):
        now = time.time()
        if job["status"] in ("queued", "running") and now >= job["deadline"]:
            self.fail(job, "Codex planning exceeded 15 minutes. Check the PC helper and explicitly retry.")
        elif job["status"] == "running" and now >= job["leaseUntil"]:
            self.fail(job, "The PC helper disconnected during planning. Reconnect it and explicitly retry; the request was not reassigned.")
        elif job["status"] == "queued" and now - self.settings().get("lastSeen", 0) > LEASE_SECONDS:
            self.fail(job, "The PC helper went offline before accepting the request. Reconnect it and explicitly retry planning.")
        return job

    def touch(self, helper_id, models=None, version=None):
        helper_id = core.identifier(helper_id)
        saved = self.settings()
        saved.update(helperId=helper_id, lastSeen=time.time())
        if models is not None:
            if not isinstance(models, list) or len(models) > 200:
                raise ValueError("Invalid Codex model catalog")
            saved["models"] = [{"id": core.text(m["id"], 160), "name": core.text(m.get("name") or m["id"], 160),
                                "default": m.get("default") is True, "images": m.get("images") is True} for m in models]
        if version is not None:
            saved["helperVersion"] = core.text(version, 40)
        self.store.write("codex/bridge.json", saved)

    def claim(self, helper_id, models, version):
        self.touch(helper_id, models, version)
        jobs = sorted([self.expire(self.store.read(self.path(job_id))) for job_id in list(self.pending)], key=lambda j: j["createdAt"])
        job = next((j for j in jobs if j["status"] == "running" and j["helperId"] == helper_id), None)
        if job is None:
            job = next((j for j in jobs if j["status"] == "queued"), None)
            if job is None:
                return None
            job.update(status="running", helperId=helper_id, claimId=secrets.token_urlsafe(24), leaseUntil=time.time() + LEASE_SECONDS)
            self.save(job)
        return {key: job[key] for key in ("id", "model", "system", "content", "claimId")} | {
            "images": [{"index": i, "sha256": item["sha256"], "size": item["size"], "suffix": Path(item["path"]).suffix.lower()}
                       for i, item in enumerate(job["images"])]}

    def owned(self, job_id, helper_id, claim_id, finished=False):
        job = self.expire(self.store.read(self.path(job_id)))
        if job.get("helperId") != helper_id or not claim_id or not secrets.compare_digest(job.get("claimId", ""), claim_id):
            raise ValueError("This helper does not own the planning request")
        if job["status"] != "running" and not (finished and job["status"] in ("complete", "failed")):
            raise ValueError("This planning request is no longer active")
        return job

    def heartbeat(self, job_id, helper_id, claim_id):
        job = self.owned(job_id, helper_id, claim_id)
        job["leaseUntil"] = time.time() + LEASE_SECONDS
        self.save(job)
        self.touch(helper_id)

    def image(self, job_id, index, helper_id, claim_id):
        job = self.owned(job_id, helper_id, claim_id)
        if not 0 <= index < len(job["images"]):
            raise ValueError("Invalid image index")
        item = job["images"][index]
        path = self.store.path(item["path"])
        if hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
            raise ValueError("Reference image changed; explicitly retry planning")
        return path

    def complete(self, job_id, helper_id, claim_id, output=None, error=None):
        job = self.owned(job_id, helper_id, claim_id, finished=True)
        result = {"status": "failed", "error": core.text(error, 1500)} if error is not None else {
            "status": "complete", "output": core.text(output, 160000)}
        if job["status"] in ("complete", "failed"):
            if any(job.get(k) != value for k, value in result.items()):
                raise ValueError("The result for this planning request was already recorded")
            return
        job.update(**result, finishedAt=time.time())
        self.save(job)
        self.pending.discard(job["id"])
        self.touch(helper_id)

    async def generate(self, model, system, content, images=()):
        status = self.status()
        if not status["connected"]:
            raise ValueError("The Codex desktop helper is offline. Open it, enter this ComfyUI URL and connect, then retry planning.")
        descriptors = []
        for image in images:
            path = Path(image).resolve()
            if not path.is_relative_to(self.store.root) or path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
                raise ValueError("Only this request's saved reference images can be sent to the PC helper")
            size = path.stat().st_size
            if not 0 < size <= 20 * 1024 * 1024:
                raise ValueError("Reference images must be 1 byte to 20 MiB")
            descriptors.append({"path": str(path.relative_to(self.store.root)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "size": size})
        job = {"id": core.uid(), "model": model, "system": system, "content": content, "images": descriptors,
               "status": "queued", "createdAt": time.time(), "deadline": time.time() + JOB_SECONDS}
        self.save(job)
        self.pending.add(job["id"])
        try:
            while True:
                job = self.expire(self.store.read(self.path(job["id"])))
                if job["status"] == "complete":
                    return job["output"]
                if job["status"] == "failed":
                    raise ValueError(job["error"])
                await asyncio.sleep(0.25)
        except asyncio.CancelledError:
            job.update(status="cancelled", finishedAt=time.time())
            self.save(job)
            self.pending.discard(job["id"])
            raise
