"""Canvas access to reviewed project clips; prompts are imported from ChatGPT."""
from pathlib import Path

from . import core


def store():
    import os
    import folder_paths
    return core.Store(os.getenv("AVA_STORAGE_DIR", str(Path(folder_paths.get_output_directory()) / "ai_video_agent")))


class ReviewedClip:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"project_id": ("STRING", {"default": ""}), "clip_id": ("STRING", {"default": ""}),
                             "review_key": ("STRING", {"default": "", "tooltip": "Copy the current review key from the workspace after saving your reviewed draft"})}}

    RETURN_TYPES = ("STRING", "FLOAT", "INT")
    RETURN_NAMES = ("bound_prompt", "duration", "steps")
    FUNCTION = "run"
    CATEGORY = "AI Video Agent"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def run(self, project_id, clip_id, review_key):
        state = store()
        scene = state.workspace(project_id)
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

    async def run(self, project_id, clip_id, review_key):
        import os
        import aiohttp
        # Validate locally before making the same transactional API call as the workspace.
        super().run(project_id, clip_id, review_key)
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=180)) as session:
            async with session.post(os.getenv("AVA_COMFY_URL", "http://127.0.0.1:8188").rstrip("/") + "/ava-agent/action", json={
                "action": "approveGenerate", "projectId": project_id, "clipId": clip_id, "reviewKey": review_key}, allow_redirects=False) as response:
                result = await response.json()
                if response.status != 200:
                    raise ValueError(result.get("error", "Could not queue this clip"))
        clip = next(c for c in result["workspace"]["clips"] if c["id"] == clip_id)
        return {"ui": {"text": [f"{clip['status']} · job {clip.get('jobId')}. Monitor in the AI Video Agent workspace."]}}


NODE_CLASS_MAPPINGS = {"AVAReviewedClip": ReviewedClip, "AVAQueueReviewedClip": QueueReviewedClip, "AVAShowText": ShowText}
NODE_DISPLAY_NAME_MAPPINGS = {"AVAReviewedClip": "AI Video Agent · Reviewed Clip", "AVAQueueReviewedClip": "AI Video Agent · Generate Reviewed Clip", "AVAShowText": "AI Video Agent · Show Text"}
