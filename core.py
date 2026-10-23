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
        project.setdefault("library", [])
        # Older versions indexed extracted frames as library entries. Keep the clip files
        # and take history, but remove those redundant reference entries once.
        if any(r.get("kind") == "last-frame" for r in project["library"]):
            project["library"] = [r for r in project["library"] if r.get("kind") != "last-frame"]
            self.write(f"projects/{identifier(project_id)}/project.json", project)
        return project

    def scene(self, project_id, scene_id):
        scene = self.read(self.scene_dir(project_id, scene_id) + "/scene.json")
        if scene["projectId"] != project_id:
            raise ValueError("Workspace does not belong to this project")
        return scene

    def scene_dir(self, project_id, scene_id):
        return f"projects/{identifier(project_id)}/scenes/{identifier(scene_id)}"

    def save_scene(self, scene):
        scene["updatedAt"] = time.time()
        self.write(self.scene_dir(scene["projectId"], scene["id"]) + "/scene.json", scene)

    def projects(self):
        return sorted([self.project(p.parent.name) for p in self.root.glob("projects/*/project.json")], key=lambda p: p.get("createdAt", 0), reverse=True)

    def scenes(self, project_id):
        project = self.project(project_id)
        if project.get("workspaceId"):
            return [self.scene(project_id, project["workspaceId"])]
        return sorted([self.scene(project_id, p.parent.name) for p in self.path(f"projects/{identifier(project_id)}/scenes").glob("*/scene.json")], key=lambda s: s.get("createdAt", 0))

    def create_project(self, name=None):
        name = next_name("Project", self.projects()) if name is None else name
        project = {"id": uid(), "name": text(name, 120), "createdAt": time.time(), "library": []}
        self.write(f"projects/{project['id']}/project.json", project)
        self.workspace(project["id"])
        return self.project(project["id"])

    def workspace(self, project_id):
        """Flatten legacy episodes/scenes without moving any saved media or takes."""
        project = self.project(project_id)
        if project.get("workspaceId"):
            return self.scene(project_id, project["workspaceId"])
        old = self.scenes(project_id)
        scene = {"id": uid(), "projectId": project_id, "name": project["name"], "script": "",
                 "summary": "", "references": [], "clips": [], "settings": DEFAULTS.copy(),
                 "createdAt": time.time(), "paused": True}
        if len(old) == 1:
            scene = old[0]
        elif old:
            scene["settings"] = old[0]["settings"]
            used = set()
            for saved in old:
                mapping = {}
                for ref in saved["references"]:
                    ref = copy.deepcopy(ref)
                    original = ref["id"]
                    ref["id"] = uid()
                    mapping[original] = ref["id"]
                    scene["references"].append(ref)
                for clip in saved["clips"]:
                    clip = copy.deepcopy(clip)
                    original_clip_id = clip["id"]
                    if clip["id"] in used:
                        clip["id"] = uid()
                    used.add(clip["id"])
                    clip["referenceIds"] = [mapping[r] for r in clip["referenceIds"]]
                    clip["storageSceneId"] = saved["id"]
                    clip["storageClipId"] = original_clip_id
                    scene["clips"].append(clip)
                if not saved.get("paused"):
                    scene["paused"] = False
        scene.pop("planning", None)
        scene.pop("episodeId", None)
        self.save_scene(scene)
        # Promote legacy references into this project's library with stable IDs.
        known = {r["id"] for r in project["library"]}
        for ref in scene["references"]:
            if ref["id"] not in known:
                project["library"].append(copy.deepcopy(ref))
                known.add(ref["id"])
            elif ref.get("assets"):
                existing = next(r for r in project["library"] if r["id"] == ref["id"])
                if not existing.get("assets"):
                    existing["assets"] = copy.deepcopy(ref["assets"])
        project["workspaceId"] = scene["id"]
        project.pop("episodes", None)
        self.write(f"projects/{project_id}/project.json", project)
        return scene

    def trash_project(self, project_id):
        if any(c["status"] in ACTIVE for s in self.scenes(project_id) for c in s["clips"]):
            raise ValueError("Resolve active or uncertain jobs before deleting this project")
        destination = self.path(f".trash/{project_id}-{uid()}")
        destination.parent.mkdir(exist_ok=True)
        shutil.move(str(self.path(f"projects/{identifier(project_id)}")), str(destination))


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


def previous_frame(scene, clip):
    if not continuation(clip):
        return None
    prior = previous(scene, clip)
    if not prior or prior.get("status") != "complete" or not prior.get("frame"):
        return None
    return {"id": prior["id"], "name": prior["title"], "takeId": prior.get("takeId"),
            "assets": [prior["frame"]]}


def prompt_context(store, scene, clip):
    planning_settings = {k: v for k, v in scene["settings"].items() if k not in ("steps", "seed")}
    return fingerprint(store, {"duration": clip.get("nextDuration", clip["duration"]), "settings": planning_settings,
                              "refs": selected(scene, clip), "continuation": continuation(clip),
                              "frame": ({k: v for k, v in frame.items() if k in ("id", "takeId", "assets")} if (frame := previous_frame(scene, clip)) else None)})


def approval_key(store, scene, clip):
    return fingerprint(store, {"context": prompt_context(store, scene, clip), "prompt": clip["prompt"], "settings": scene["settings"], "previousTake": clip.get("takeId")})


def ensure_ready(store, scene, clip):
    settings(scene["settings"])
    duration(clip.get("nextDuration", clip["duration"]))
    if continuation(clip) and not previous_frame(scene, clip):
        raise ValueError("Complete the immediately preceding clip and save its last frame, or turn continuity off.")
    if clip.get("promptContext") != prompt_context(store, scene, clip):
        raise ValueError("References, duration, settings or previous clip frame changed. Save and review this prompt again.")
    if set(clip["referenceIds"]) != {r["id"] for r in selected(scene, clip)}:
        raise ValueError("A selected reference is missing its project library files")
    h3_prompt.validate(clip.get("prompt"), [{**r, "subjectLabel": h3_prompt.subject_labels(scene).get(r["id"])} for r in selected(scene, clip)])


def import_plan(store, scene, result):
    """Validate the whole import before appending anything; saved takes are immutable."""
    if not isinstance(result, dict) or result.get("version") != 1 or type(result.get("version")) is not int:
        raise ValueError("Scene JSON must be an object with version: 1")
    source = result.get("clips")
    if not isinstance(source, list) or not 1 <= len(source) <= 40:
        raise ValueError("Scene JSON must contain 1–40 clips")
    project = store.project(scene["projectId"])
    available = {r["id"]: r for r in project["library"] if r["kind"] != "last-frame" and r.get("assets")}
    names = {}
    for ref in available.values():
        names.setdefault(ref["name"], []).append(ref["id"])
    references = copy.deepcopy(scene["references"])
    ids = {r["id"] for r in references}
    clean, batch = [], uid()
    for index, value in enumerate(source):
        if not isinstance(value, dict):
            raise ValueError("Each clip must be a JSON object")
        seconds = duration(value.get("duration"))
        if type(value.get("use_last_frame")) is not bool:
            raise ValueError("Each clip needs use_last_frame: true or false")
        if value["use_last_frame"] and not scene["clips"] and index == 0:
            raise ValueError("The first project clip has no preceding clip for continuity")
        requested = value.get("references")
        if not isinstance(requested, list) or any(not isinstance(r, str) for r in requested):
            raise ValueError("references must be a list of this project's library IDs or unique names")
        selected_ids = []
        for name in requested:
            rid = name if name in available else names.get(name, [None])[0] if len(names.get(name, [])) == 1 else None
            if rid is None:
                raise ValueError(f"Missing or ambiguous project reference: {name}. Copy exact IDs from the library manifest.")
            if rid in selected_ids:
                raise ValueError("A clip cannot select a reference twice")
            selected_ids.append(rid)
            if rid not in ids:
                references.append(copy.deepcopy(available[rid]))
                ids.add(rid)
        refs = [available[r] for r in selected_ids]
        if sum(a["kind"] == "image" for r in refs for a in r["assets"]) > 9 or sum(a["kind"] == "audio" for r in refs for a in r["assets"]) > 3:
            raise ValueError("H3 accepts at most 9 image and 3 voice inputs per clip")
        prompt = text(value.get("prompt"), 12000)
        # Names keep the JSON independent of the host's numbered input bindings.
        h3_prompt.validate(prompt, [])
        clean.append({"id": uid(), "title": text(value.get("title", f"Clip {index + 1}"), 150), "duration": seconds,
            "referenceIds": selected_ids, "transition": "continue" if value["use_last_frame"] else "cut",
            "continuityMode": "on" if value["use_last_frame"] else "off", "outline": prompt, "prompt": prompt,
            "status": "awaiting-approval", "versions": [], "batchId": batch,
            "sceneName": text(result.get("scene", "Imported scene"), 150)})
    candidate = {**scene, "references": references, "clips": [*scene["clips"], *clean]}
    for clip in clean:
        clip["promptContext"] = prompt_context(store, candidate, clip)
    scene.update(references=references, clips=candidate["clips"])
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
    if continuation(clip):
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
        frame = previous_frame(scene, clip)
        if not frame:
            raise ValueError("Continuation requires the completed preceding clip's saved last frame")
        load(frame["assets"][0], "ava_first_frame", "image")
        graph["ava_frame_guide"] = {"class_type": "MiniMaxH3AddGuide", "inputs": {"positive": ["136", 0], "latent": ["136", 1], "vae": ["119", 0], "image": ["ava_first_frame", 0], "frame_idx": 0}}
        graph["126"]["inputs"]["conditioning"] = ["ava_frame_guide", 0]
    return graph


def archive_take(clip):
    versions = clip.setdefault("versions", [])
    if clip.get("takeId"):
        versions.append({k: copy.deepcopy(v) for k, v in clip.items() if k != "versions"})
    for key in ("jobId", "takeId", "source", "video", "frame", "extractedFrame", "error", "actualDuration", "submittedPrompt", "submittedSettings", "submittedReferences", "submittedFrame", "storageSceneId", "storageClipId", "approvedKey", "timing"):
        clip.pop(key, None)
    clip["duration"] = clip.pop("nextDuration", clip["duration"])


def invalidate_following(scene, clip):
    index = scene["clips"].index(clip)
    for following in scene["clips"][index + 1:]:
        following.pop("approvedKey", None)
        following.pop("promptContext", None)
        following.pop("frameAnalysis", None)
        if following["status"] == "complete":
            following["continuityOutdated"] = True
