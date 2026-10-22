"""Canvas nodes for standalone Codex use and reviewed saved-clip output."""
import json
from pathlib import Path

from . import core, planner


async def ask_canvas(state, instruction, payload, images=(), model_file=None):
    # The paired PC helper claims each request once; H3 GPU state is untouched.
    if isinstance(model_file, str) and model_file.endswith(".safetensors"):
        model_file = None  # A saved pre-Codex node widget is not a Codex model choice.
    return await planner.ask(state, instruction, payload, images, model_file=model_file)


def store():
    import os
    import folder_paths
    return core.Store(os.getenv("AVA_STORAGE_DIR", str(Path(folder_paths.get_output_directory()) / "ai_video_agent")))


class CodexPlan:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"script": ("STRING", {"multiline": True, "default": "Paste the scene script here"}),
                             "planner_model": ("STRING", {"default": "", "tooltip": "Blank uses your PC's default Codex model"}),
                             "reference_manifest": ("STRING", {"multiline": True, "default": "[]"}),
                             "operation": (["identify references", "plan clips"],)},
                "optional": {"reference_images": ("IMAGE",)}}

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("plan_json", "first_clip_prompt")
    FUNCTION = "run"
    CATEGORY = "AI Video Agent/Codex"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    async def run(self, script, planner_model, reference_manifest, operation, reference_images=None):
        state = store()
        if operation == "identify references":
            result = await ask_canvas(state, planner.DISCOVER, {"script": core.text(script)}, model_file=planner_model)
            core.validate_references(result)
            return json.dumps(result, ensure_ascii=False, indent=2), ""
        refs = core.validate_references({"references": json.loads(reference_manifest)})
        paths = []
        if reference_images is not None:
            from PIL import Image
            import numpy as np
            if len(refs) != len(reference_images):
                raise ValueError("Canvas planning expects one manifest entry per reference image, in the same order")
            for i, tensor in enumerate(reference_images):
                relative = "node_inputs/" + core.uid() + ".jpg"
                target = state.path(relative)
                target.parent.mkdir(exist_ok=True)
                Image.fromarray(np.clip(tensor.cpu().numpy() * 255, 0, 255).astype(np.uint8)).save(target)
                refs[i]["assets"] = [{"path": relative, "name": refs[i]["name"], "kind": "image"}]
                paths.append(target)
        elif refs:
            raise ValueError("Supply reference_images or use an empty manifest; never invent reference files")
        scene = {"script": script, "references": refs, "settings": core.DEFAULTS.copy()}
        manifest, _ = planner.reference_context(state, scene)
        result = await ask_canvas(state, planner.PLAN, {"script": script, "settings": scene["settings"], "suppliedReferences": manifest}, paths, model_file=planner_model)
        clips = core.validate_plan(scene, result)
        scene["clips"] = clips
        return json.dumps({"references": refs, "clips": clips}, ensure_ascii=False, indent=2), core.final_prompt(scene, clips[0])


class CodexPrompt:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"context_json": ("STRING", {"multiline": True, "default": '{"script":"", "target":{"duration":15,"continuation":false}}'}),
                             "planner_model": ("STRING", {"default": "", "tooltip": "Blank uses your PC's default Codex model"}),
                             "comments": ("STRING", {"multiline": True, "default": ""})},
                "optional": {"previous_frame": ("IMAGE",)}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "run"
    CATEGORY = "AI Video Agent/Codex"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    async def run(self, context_json, planner_model, comments, previous_frame=None):
        state = store()
        payload = json.loads(context_json)
        paths = []
        if previous_frame is not None:
            import numpy as np
            from PIL import Image
            target = state.path("node_inputs/" + core.uid() + ".jpg")
            target.parent.mkdir(exist_ok=True)
            Image.fromarray(np.clip(previous_frame[0].cpu().numpy() * 255, 0, 255).astype(np.uint8)).save(target)
            paths.append(target)
            payload["previousFrameAttachment"] = 1
        payload["comments"] = comments
        result = await ask_canvas(state, planner.PROMPT, payload, paths, model_file=planner_model)
        return (core.text(result["prompt"], 12000),)


class ReviewedClip:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"project_id": ("STRING", {"default": ""}), "scene_id": ("STRING", {"default": ""}), "clip_id": ("STRING", {"default": ""}),
                             "review_key": ("STRING", {"default": "", "tooltip": "Copy the current review key from the workspace after saving your reviewed draft"})}}

    RETURN_TYPES = ("STRING", "FLOAT", "INT")
    RETURN_NAMES = ("bound_prompt", "duration", "steps")
    FUNCTION = "run"
    CATEGORY = "AI Video Agent"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def run(self, project_id, scene_id, clip_id, review_key):
        state = store()
        scene = state.scene(project_id, scene_id)
        clip = next(c for c in scene["clips"] if c["id"] == clip_id)
        core.ensure_ready(state, scene, clip)
        if not review_key or review_key != core.approval_key(state, scene, clip):
            raise ValueError("Save and review this clip in the AI Video Agent workspace, then copy its review key")
        return core.final_prompt(scene, clip), clip.get("nextDuration", clip["duration"]), scene["settings"]["steps"]


class ShowText:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"text": ("STRING", {"forceInput": True})}}

    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "AI Video Agent"

    def run(self, text):
        return {"ui": {"text": [text]}}


class QueueReviewedClip(ReviewedClip):
    """A reviewed canvas execution queues the native video graph as a separate job."""
    RETURN_TYPES = ()
    RETURN_NAMES = ()
    OUTPUT_NODE = True

    async def run(self, project_id, scene_id, clip_id, review_key):
        import os
        import aiohttp
        # Validate locally before making the same transactional API call as the workspace.
        super().run(project_id, scene_id, clip_id, review_key)
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=180)) as session:
            result = await planner.request_json(session, "POST", os.getenv("AVA_COMFY_URL", "http://127.0.0.1:8188").rstrip("/") + "/ava-agent/action", json={
                "action": "approveGenerate", "projectId": project_id, "sceneId": scene_id, "clipId": clip_id, "reviewKey": review_key})
        clip = next(c for c in result["scene"]["clips"] if c["id"] == clip_id)
        return {"ui": {"text": [f"{clip['status']} · job {clip.get('jobId')}. Monitor in the AI Video Agent workspace."]}}


NODE_CLASS_MAPPINGS = {"AVACodexPlan": CodexPlan, "AVACodexPrompt": CodexPrompt, "AVAReviewedClip": ReviewedClip, "AVAQueueReviewedClip": QueueReviewedClip, "AVAShowText": ShowText,
                       "AVAQwenPlan": CodexPlan, "AVAQwenPrompt": CodexPrompt}
NODE_DISPLAY_NAME_MAPPINGS = {"AVACodexPlan": "Codex · Script & Reference Planner", "AVACodexPrompt": "Codex · Frame-Aware Prompt / Revision",
                              "AVAReviewedClip": "AI Video Agent · Reviewed Clip", "AVAQueueReviewedClip": "AI Video Agent · Generate Reviewed Clip", "AVAShowText": "AI Video Agent · Show Text"}
