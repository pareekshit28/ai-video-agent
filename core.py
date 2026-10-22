"""Persistence, validation and workflow construction. No Comfy imports or GPU needed."""
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import time
import uuid
from . import h3_prompt

ACTIVE = {"submitting", "submission-unknown", "queued", "rendering", "saving", "recoverable"}
RATIOS = {"16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1}
DEFAULTS = {"provider": "h3", "aspectRatio": "16:9", "megapixels": 2,
            "steps": 8, "seed": -1, "refImageSize": "match"}
ID = re.compile(r"^[a-zA-Z0-9_-]{1,80}$")
TAGS = re.compile(r"<(?:Picture|Audio|Video)\s*\d+>", re.I)
DEFAULT_EPISODE = "episode_1"


def uid():
    return uuid.uuid4().hex


def next_name(prefix, existing):
    names = {item["name"] for item in existing}
    index = 1
    while f"{prefix} {index}" in names:
        index += 1
    return f"{prefix} {index}"


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ValueError("Invalid ID")
    return value


def text(value, maximum=32000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"Enter text between 1 and {maximum} characters")
    return value.strip()


def ensure_not_planning(scene):
    if scene.get("planning", {}).get("status") == "running":
        raise ValueError("Codex is still planning this scene. Wait for it to finish before editing or deleting it.")


def duration(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Duration must be a number")
    if not 2 <= value <= 15:
        raise ValueError("H3 clips must be 2–15 seconds.")
    return value


def settings(value):
    result = {**DEFAULTS, **{k: v for k, v in value.items() if k in DEFAULTS}}
    if result["provider"] != "h3" or result["aspectRatio"] not in RATIOS:
        raise ValueError("Only H3 generation is supported. Use a valid aspect ratio.")
    if not isinstance(result["megapixels"], (int, float)) or not 0.25 <= result["megapixels"] <= 4:
        raise ValueError("Megapixels must be 0.25–4")
    if type(result["steps"]) is not int or not 1 <= result["steps"] <= 100:
        raise ValueError("Steps must be 1–100")
    if type(result["seed"]) is not int or not -1 <= result["seed"] <= 9007199254740991:
        raise ValueError("Seed must be -1 or a nonnegative safe integer")
    if result["refImageSize"] not in ("max", "match"):
        raise ValueError("Invalid generation settings")
    return result


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, relative):
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError("Path is outside AI Video Agent storage")
        return path

    def write(self, relative, value):
        path = self.path(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + "." + uid() + ".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, path)

    def read(self, relative):
        return json.loads(self.path(relative).read_text(encoding="utf-8"))

    def project(self, project_id):
        project = self.read(f"projects/{identifier(project_id)}/project.json")
        # Virtual migration preserves every existing scene ID and media path.
        project.setdefault("episodes", [{"id": DEFAULT_EPISODE, "name": "Episode 1", "createdAt": project.get("createdAt", 0)}])
        return project

    def episode(self, project_id, episode_id):
        episode_id = identifier(episode_id)
        episode = next((e for e in self.project(project_id)["episodes"] if e["id"] == episode_id), None)
        if episode is None:
            raise ValueError("Episode does not belong to this project")
        return episode

    def scene(self, project_id, scene_id, episode_id=None):
        scene = self.read(self.scene_dir(project_id, scene_id) + "/scene.json")
        scene.setdefault("episodeId", DEFAULT_EPISODE)
        if episode_id is not None:
            self.episode(project_id, episode_id)
            if scene["episodeId"] != episode_id:
                raise ValueError("Scene does not belong to the selected episode")
        return scene

    def scene_dir(self, project_id, scene_id):
        return f"projects/{identifier(project_id)}/scenes/{identifier(scene_id)}"

    def save_scene(self, scene):
        scene["updatedAt"] = time.time()
        self.write(self.scene_dir(scene["projectId"], scene["id"]) + "/scene.json", scene)

    def projects(self):
        return sorted([self.project(p.parent.name) for p in self.root.glob("projects/*/project.json")], key=lambda p: p.get("createdAt", 0), reverse=True)

    def scenes(self, project_id, episode_id=None):
        self.project(project_id)
        if episode_id is not None:
            self.episode(project_id, episode_id)
        scenes = [self.scene(project_id, p.parent.name) for p in self.path(f"projects/{identifier(project_id)}/scenes").glob("*/scene.json")]
        return sorted([s for s in scenes if episode_id is None or s["episodeId"] == episode_id], key=lambda s: s.get("createdAt", 0))

    def create_project(self, name=None):
        name = next_name("Project", self.projects()) if name is None else name
        project = {"id": uid(), "name": text(name, 120), "createdAt": time.time(), "library": []}
        project["episodes"] = [{"id": DEFAULT_EPISODE, "name": "Episode 1", "createdAt": project["createdAt"]}]
        self.write(f"projects/{project['id']}/project.json", project)
        return project

    def create_episode(self, project_id, name=None):
        project = self.project(project_id)
        name = next_name("Episode", project["episodes"]) if name is None else name
        episode = {"id": uid(), "name": text(name, 150), "createdAt": time.time()}
        project["episodes"].append(episode)
        self.write(f"projects/{project_id}/project.json", project)
        return episode

    def create_scene(self, project_id, name=None, script="", episode_id=None):
        self.project(project_id)
        if not episode_id:
            raise ValueError("Select an episode before creating a scene")
        self.episode(project_id, episode_id)
        auto_name = name is None
        name = next_name("Scene", self.scenes(project_id, episode_id)) if auto_name else name
        scene = {"id": uid(), "projectId": project_id, "episodeId": episode_id, "name": text(name, 150), "script": script,
                 "summary": "", "references": [], "clips": [], "settings": DEFAULTS.copy(),
                 "createdAt": time.time(), "paused": True, "reviewAfterEachClip": True, "autoName": auto_name}
        self.save_scene(scene)
        return scene

    def trash_project(self, project_id):
        for scene in self.scenes(project_id):
            ensure_not_planning(scene)
        if any(c["status"] in ACTIVE for s in self.scenes(project_id) for c in s["clips"]):
            raise ValueError("Resolve active or uncertain jobs before deleting this project")
        destination = self.path(f".trash/{project_id}-{uid()}")
        destination.parent.mkdir(exist_ok=True)
        shutil.move(str(self.path(f"projects/{project_id}")), str(destination))

    def trash_scene(self, project_id, scene_id, episode_id):
        scene = self.scene(project_id, scene_id, episode_id)
        ensure_not_planning(scene)
        if any(c["status"] in ACTIVE for c in scene["clips"]):
            raise ValueError("Resolve active or uncertain jobs before deleting this scene")
        source = self.path(self.scene_dir(project_id, scene_id))
        destination = self.path(f".trash/scenes/{scene_id}-{uid()}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(destination))

    def trash_episode(self, project_id, episode_id):
        project = self.project(project_id)
        episode = self.episode(project_id, episode_id)
        scenes = self.scenes(project_id, episode_id)
        for scene in scenes:
            ensure_not_planning(scene)
        if any(c["status"] in ACTIVE for scene in scenes for c in scene["clips"]):
            raise ValueError("Resolve active or uncertain jobs before deleting this episode")
        relative = f".trash/episodes/{episode_id}-{uid()}"
        self.write(relative + "/episode.json", {"projectId": project_id, "episode": episode, "sceneIds": [s["id"] for s in scenes]})
        moved = []
        try:
            for scene in scenes:
                source = self.path(self.scene_dir(project_id, scene["id"]))
                destination = self.path(relative + "/" + scene["id"])
                shutil.move(str(source), str(destination))
                moved.append((source, destination))
            project["episodes"] = [e for e in project["episodes"] if e["id"] != episode_id]
            self.write(f"projects/{project_id}/project.json", project)
        except Exception:
            for source, destination in reversed(moved):
                shutil.move(str(destination), str(source))
            raise


def selected(scene, clip):
    return [r for ref_id in clip["referenceIds"] for r in scene["references"] if r["id"] == ref_id and r.get("assets")]


def media(scene, clip):
    refs = selected(scene, clip)
    return ([{**a, "referenceName": r["name"], "referenceId": r["id"], "referenceKind": r["kind"]} for r in refs for a in r["assets"] if a["kind"] == "image"],
            [{**a, "referenceName": r["name"], "referenceId": r["id"]} for r in refs for a in r["assets"] if a["kind"] == "audio"])


def previous(scene, clip):
    index = next(i for i, c in enumerate(scene["clips"]) if c["id"] == clip["id"])
    return scene["clips"][index - 1] if index else None


def continuation(clip):
    return clip.get("continuityMode", "auto") == "on" or (clip.get("continuityMode", "auto") == "auto" and clip.get("transition") == "continue")


def fingerprint(store, value):
    """Include media bytes, so replacing an image in place invalidates approval."""
    def content(v):
        if isinstance(v, dict):
            return {k: content(x) for k, x in v.items()} | ({"sha256": hashlib.sha256(store.path(v["path"]).read_bytes()).hexdigest()} if "path" in v else {})
        if isinstance(v, list):
            return [content(x) for x in v]
        return v
    return hashlib.sha256(json.dumps(content(value), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def prompt_context(store, scene, clip):
    prior = previous(scene, clip)
    planning_settings = {k: v for k, v in scene["settings"].items() if k not in ("steps", "seed")}
    return fingerprint(store, {"script": scene["script"], "outline": clip.get("outline"),
                              "duration": clip.get("nextDuration", clip["duration"]), "settings": planning_settings,
                              "refs": selected(scene, clip), "continuation": continuation(clip),
                              "prior": {"frame": prior.get("frame"), "takeId": prior.get("takeId"), "prompt": prior.get("submittedPrompt"), "duration": prior.get("actualDuration")} if prior else None})


def approval_key(store, scene, clip):
    return fingerprint(store, {"context": prompt_context(store, scene, clip), "prompt": clip["prompt"], "settings": scene["settings"], "previousTake": clip.get("takeId")})


def ensure_ready(store, scene, clip):
    settings(scene["settings"])
    duration(clip.get("nextDuration", clip["duration"]))
    prior = previous(scene, clip)
    if prior and (prior["status"] != "complete" or not prior.get("frame")):
        raise ValueError("Finish the preceding clip and save its final frame first")
    if clip.get("promptContext") != prompt_context(store, scene, clip):
        raise ValueError("References, duration, settings or previous frame changed. Plan this prompt again before review.")
    if not clip.get("prompt", "").strip():
        raise ValueError("Prepare and review a prompt first")


def validate_references(result):
    refs = result.get("references")
    if not isinstance(refs, list) or len(refs) > 40:
        raise ValueError("Codex must return up to 40 reference slots")
    seen = set()
    clean = []
    for ref in refs:
        rid = identifier(ref["id"])
        if rid in seen or ref["kind"] not in ("character", "location", "prop"):
            raise ValueError("Codex returned duplicate or invalid references")
        seen.add(rid)
        clean.append({"id": rid, "name": text(ref["name"], 120), "kind": ref["kind"], "description": text(ref["description"], 1000), "assets": []})
    return clean


def validate_plan(scene, result):
    clips = result.get("clips")
    if not isinstance(clips, list) or not 1 <= len(clips) <= 40:
        raise ValueError("Codex must return 1–40 clips")
    supplied = {r["id"] for r in scene["references"] if r.get("assets")}
    seen = set()
    clean = []
    for i, clip in enumerate(clips):
        cid = identifier(clip["id"])
        ids = clip["referenceIds"]
        if not isinstance(ids, list) or len(set(ids)) != len(ids) or not set(ids) <= supplied or cid in seen:
            raise ValueError("Codex selected missing or duplicate reference/clip IDs")
        seen.add(cid)
        transition = clip["transition"]
        if (i == 0 and transition != "first") or (i > 0 and transition not in ("continue", "cut", "scene-change", "time-jump")):
            raise ValueError("Codex returned an invalid transition")
        prompt = text(clip["prompt"], 12000)
        if TAGS.search(prompt):
            raise ValueError("Codex must use names; numbered media tags are bound to real uploads later")
        clean.append({"id": cid, "title": text(clip["title"], 150), "duration": duration(clip["duration"]),
                      "referenceIds": ids, "transition": transition, "continuityMode": "auto", "outline": prompt,
                      "prompt": prompt if i == 0 else "", "status": "awaiting-approval", "versions": []})
    return clean


def final_prompt(scene, clip):
    if TAGS.search(clip["prompt"]):
        raise ValueError("Use reference names in the editable prompt; input tags are assigned automatically")
    images, audios = media(scene, clip)
    labels = h3_prompt.subject_labels(scene)
    roles = {"character": "Preserve the character's visual identity, clothing and proportions; this is not a required starting-frame composition.",
             "location": "Preserve the environment's architecture, layout and identifying setting details; this is not a forced starting frame.",
             "prop": "Preserve the prop's shape, material and identifying details."}
    bindings = [f"<Picture {i+1}>: {a['referenceName']}, {labels[a['referenceId']]}. {roles[a['referenceKind']]}" for i, a in enumerate(images)]
    bindings += [f"<Audio {i+1}>: {a['referenceName']}'s supplied voice timbre, not the sample's spoken words." for i, a in enumerate(audios)]
    if continuation(clip) and previous(scene, clip) and previous(scene, clip).get("frame"):
        bindings.append("Opening Frame: the supplied frame-zero guide anchors the opening composition and state. Continue the preceding action without resetting it. This guide is separate from the numbered reference images.")
    return "Reference\n" + ("\n".join(bindings) or "No supplied appearance or voice reference inputs.") + "\n\n" + clip["prompt"]


def build_h3(store, scene, clip, input_dir, take_id):
    graph = json.loads((Path(__file__).parent / "templates/h3-api.json").read_text(encoding="utf-8"))
    opts = scene["settings"]
    graph["138"]["inputs"]["value"] = final_prompt(scene, clip)
    graph["132"]["inputs"]["value"] = duration(clip.get("nextDuration", clip["duration"]))
    graph["115"]["inputs"].update(aspect_ratio={"16:9": "16:9 (Widescreen)", "9:16": "9:16 (Portrait)", "1:1": "1:1 (Square)"}[opts["aspectRatio"]], megapixels=opts["megapixels"])
    graph["124"]["inputs"]["steps"] = opts["steps"]
    graph["129"]["inputs"]["noise_seed"] = int.from_bytes(os.urandom(4), "big") if opts["seed"] == -1 else opts["seed"]
    graph["136"]["inputs"]["ref_image_size"] = opts["refImageSize"]
    graph["92"]["inputs"]["filename_prefix"] = f"ai_video_agent/raw/{scene['id']}/{clip['id']}-{take_id}"
    images, audios = media(scene, clip)
    if len(images) > 9 or len(audios) > 3:
        raise ValueError("H3 accepts at most 9 image and 3 voice inputs per clip")
    directory = Path(input_dir) / "ai_video_agent" / scene["id"] / take_id
    directory.mkdir(parents=True, exist_ok=True)

    def load(asset, node_id, kind):
        source = store.path(asset["path"])
        destination = directory / (node_id + source.suffix)
        shutil.copyfile(source, destination)
        graph[node_id] = {"class_type": "LoadImage" if kind == "image" else "LoadAudio", "inputs": {kind: destination.relative_to(input_dir).as_posix()}}

    for kind, files in (("image", images), ("audio", audios)):
        for i, asset in enumerate(files):
            node_id = f"ava_{kind}_{i}"
            load(asset, node_id, kind)
            graph["136"]["inputs"][f"ref_{kind}s.ref_{kind}_{i}"] = [node_id, 0]
    if continuation(clip):
        prior = previous(scene, clip)
        if not prior or not prior.get("frame"):
            raise ValueError("Continuation requires a saved previous frame")
        load(prior["frame"], "ava_first_frame", "image")
        graph["ava_frame_guide"] = {"class_type": "MiniMaxH3AddGuide", "inputs": {"positive": ["136", 0], "latent": ["136", 1], "vae": ["119", 0], "image": ["ava_first_frame", 0], "frame_idx": 0}}
        graph["126"]["inputs"]["conditioning"] = ["ava_frame_guide", 0]
    return graph


def archive_take(clip):
    versions = clip.setdefault("versions", [])
    if clip.get("takeId"):
        versions.append({k: copy.deepcopy(v) for k, v in clip.items() if k != "versions"})
    for key in ("jobId", "takeId", "source", "video", "frame", "extractedFrame", "error", "actualDuration", "submittedPrompt", "submittedSettings", "submittedReferences", "approvedKey", "timing"):
        clip.pop(key, None)
    clip["duration"] = clip.pop("nextDuration", clip["duration"])


def invalidate_following(scene, clip):
    index = scene["clips"].index(clip)
    for following in scene["clips"][index + 1:]:
        following.pop("approvedKey", None)
        following.pop("promptContext", None)
        if following["status"] == "complete":
            following["continuityOutdated"] = True
