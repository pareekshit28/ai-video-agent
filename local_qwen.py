"""Run a complete Qwen-VL checkpoint through ComfyUI's own CLIP runtime."""
import gc
from pathlib import Path
import threading

from PIL import Image, ImageOps

DEFAULT_MODEL = "qwen3vl_4b_fp8_scaled.safetensors"
MODEL_URL = "https://huggingface.co/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/" + DEFAULT_MODEL
_lock = threading.Lock()


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
    with _lock:
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
