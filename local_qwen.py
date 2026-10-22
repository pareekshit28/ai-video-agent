"""Run a complete Qwen-VL checkpoint through ComfyUI's own CLIP runtime."""
import gc
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
import threading

from PIL import Image, ImageOps

DEFAULT_MODEL = "qwen3vl_4b_fp8_scaled.safetensors"
MODEL_URL = "https://huggingface.co/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/" + DEFAULT_MODEL
_lock = threading.Lock()
_sidebar_progress = ContextVar("ava_sidebar_progress", default=False)


@contextmanager
def generation_progress():
    """Keep unqueued planning out of Comfy's queued-prompt progress hook."""
    import comfy.utils as utils
    import comfy.model_management as mm
    from comfy_execution.utils import get_executing_context

    if get_executing_context() is not None:
        # asyncio.to_thread preserves the canvas node's execution context.
        yield
        return

    original = utils.PROGRESS_BAR_HOOK
    token = _sidebar_progress.set(True)

    def hook(*args, **kwargs):
        if _sidebar_progress.get():
            # The normal hook also checks interruption on every token. Retain
            # cancellation, without reading stale/missing server prompt IDs.
            mm.throw_exception_if_processing_interrupted()
        elif original is not None:
            # Other threads (including H3 renders) keep their normal progress.
            original(*args, **kwargs)

    utils.set_progress_bar_global_hook(hook)
    try:
        yield
    finally:
        _sidebar_progress.reset(token)
        # Do not undo a newer hook installed by another extension.
        if utils.PROGRESS_BAR_HOOK is hook:
            utils.set_progress_bar_global_hook(original)


def validate_model_name(model):
    if not isinstance(model, str) or not model.strip() or "qwen3vl" not in model.lower() or not model.endswith(".safetensors"):
        raise ValueError("Choose a complete Qwen3-VL safetensors model from ComfyUI/models/text_encoders")
    if "minimax" in model.lower():
        raise ValueError("H3's truncated Qwen text encoder cannot generate plans or prompts. Select a complete Qwen-VL instruction model.")
    if Path(model).is_absolute() or ".." in Path(model.replace("\\", "/")).parts:
        raise ValueError("Choose a model filename relative to models/text_encoders")
    return model.strip()


def image_tensor(path):
    import numpy as np
    import torch
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((1024, 1024))
        return torch.from_numpy(np.array(image).astype(np.float32) / 255.0).unsqueeze(0)


def generate(model, system, content, images=(), max_tokens=8192):
    """Called in a worker thread; no Ollama process, API key or model download."""
    import folder_paths
    import nodes
    import comfy.model_management as mm
    model = validate_model_name(model)
    if model not in folder_paths.get_filename_list("text_encoders"):
        raise ValueError(f"Download {model} into ComfyUI/models/text_encoders. The direct link is in workflow.json.")
    # Comfy's Qwen3-VL detection is based on tensor keys; stable_diffusion selects
    # its ordinary Qwen3VLTEModel rather than a diffusion-specific template.
    with _lock, generation_progress():
        clip = None
        try:
            mm.unload_all_models()
            mm.soft_empty_cache()
            clip = nodes.CLIPLoader().load_clip(model, type="stable_diffusion", device="default")[0]
            tensors = [image_tensor(path) for path in images]
            vision = "<|vision_start|><|image_pad|><|vision_end|>" * len(tensors)
            chat = ("<|im_start|>system\n" + system + "<|im_end|>\n<|im_start|>user\n" + vision + content + "<|im_end|>\n<|im_start|>assistant\n")
            tokens = clip.tokenize(chat, images=tensors, skip_template=True, min_length=1)
            ids = clip.generate(tokens, do_sample=False, max_length=max_tokens, temperature=1.0,
                                top_k=50, top_p=1.0, min_p=0.0, repetition_penalty=1.0, seed=0)
            return clip.decode(ids)
        finally:
            mm.unload_all_models()
            clip = None
            gc.collect()
            mm.soft_empty_cache()
