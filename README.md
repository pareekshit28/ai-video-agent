# ComfyUI AI Video Agent

Custom nodes and one **[workflow.json](workflow.json)** for script planning, reference inspection, editable prompts, per-clip review, native FastH3 generation and sequential frame continuity. Qwen-VL runs inside ComfyUI; no separate planner service, web app or API key is required.

## Install on the pod

Run in your existing ComfyUI installation, using the same Python environment that starts ComfyUI:

```bash
cd /workspace/ComfyUI/custom_nodes  # adjust to your ComfyUI folder
git clone --single-branch --branch codex/comfyui-custom-nodes https://github.com/pareekshit28/ai-video-agent.git ComfyUI-AI-Video-Agent
python -m pip install -r ComfyUI-AI-Video-Agent/requirements.txt
```

Restart ComfyUI, then drag **workflow.json** onto the canvas. Use a recent ComfyUI build with native Qwen3-VL text generation, MiniMax H3, Comfy Kitchen attention and sparse-attention support. FFmpeg and FFprobe must be installed for clip saving and final-frame extraction.

## Models

The workflow's **SETUP · direct model downloads & instructions** note contains every direct link, destination folder, and pod-terminal download command. Its node metadata also contains ComfyUI model-download entries. The machine-readable list is [models.json](models.json).

The planner uses the complete **Qwen3-VL-4B Instruct FP8** checkpoint:

- [Download qwen3vl_4b_fp8_scaled.safetensors](https://huggingface.co/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors)
- Save to `ComfyUI/models/text_encoders/`.
- Select its filename in the planning nodes or **AI Video Agent → Qwen & RunPod setup**.

The existing H3 Qwen 32B file remains the render graph's conditioning encoder. It is truncated to 50 layers and lacks a language-generation output head; it cannot replace the complete planning model. See [ComfyUI's MiniMax implementation](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/text_encoders/minimax.py). The native planner uses ComfyUI's ordinary Qwen3-VL loader and generation API. It releases GPU model memory after planning before H3 rendering.

Reuse the H3 files already present on your pod; the workflow includes their links too:

| Folder under `models/` | File |
| --- | --- |
| `diffusion_models/` | `fasth3_omniref_8step_pruned_int8_convrot.safetensors` |
| `text_encoders/` | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` |
| `vae/` | `minimax_h3_video_vae_int8_convrot.safetensors` |
| `vae/` | `minimax_h3_audio_vae_fp32.safetensors` |

Model weights are not stored in this repository or downloaded automatically when a node is queued.

## Use

Open **AI Video Agent** in ComfyUI's sidebar for the complete project flow:

1. Create a project and scene; paste the script.
2. **Identify references** creates slots only. Supply the actual images and voice samples, or copy entries from the project library.
3. **Understand references & plan clips** inspects supplied images and plans 2–15 second H3 clips. The first prompt is ready for editing; later clips keep story outlines until their preceding clip finishes.
4. Edit the prompt, reference choices, duration or continuity. Apply revision comments with Qwen if needed. **Approve prompt & generate this clip** submits only that reviewed clip.
5. The video is saved and verified at 24 FPS, trimmed to the requested duration, and its actual last decoded frame is extracted. Qwen inspects that frame to prepare the following prompt, then pauses for review.

Direct continuations use `MiniMaxH3AddGuide` at frame zero. Cuts use the preceding frame only as story context. You can replace/restore the last frame, stage a new duration while retaining the current take, and regenerate individual clips without deleting previous takes. Lost submission responses stop for recovery; resuming never implicitly creates a replacement render. Projects, references, videos, frames and request audits persist in ComfyUI's output directory under `ai_video_agent` by default. Set `AVA_STORAGE_DIR` to a RunPod volume folder if needed.

The single workflow also exposes standalone canvas nodes:

- **Qwen · Script & Reference Planner** → JSON plan and first prompt. A supplied image batch needs one manifest entry per image, in order. Use `[]` with no images.
- **Qwen · Frame-Aware Prompt / Revision** → target prompt grounded in an optional preceding frame and the supplied context JSON.
- **AI Video Agent · Generate Reviewed Clip** → copy the four saved IDs/key from **Canvas node IDs / review key** under a reviewed clip. Unmute the node and queue it once to submit the native H3 graph as a separate ComfyUI job.
- **AI Video Agent · Reviewed Clip** → saved prompt/duration/steps for advanced graph use.
- **AI Video Agent · Show Text** → displays node output.

The workflow's lower row is muted initially. Enable it only for the specific revision or reviewed render you intend to run. Changing the prompt, settings, duration, reference bytes, prior frame or take invalidates its review key. A planner node's filename applies to that canvas execution; the sidebar's saved model filename configures project planning.

Use **Check installation** to see missing H3/Qwen files and nodes before rendering. `AVA_COMFY_URL` can override the loopback URL when using HTTPS internally or a port other than 8188 for the canvas render node. `AVA_QWEN_MODEL` selects the initial planner filename. `FFMPEG_PATH` and `FFPROBE_PATH` override the media-tool executable paths.

### RunPod proxy request errors

Version 0.3.1 fixes a sidebar error reported as `Unexpected token 'U', "Use the wo"... is not valid JSON`. The browser's public ComfyUI URL can differ from the internal Host header after RunPod proxying. Same-origin browser requests now use browser Fetch Metadata, and rejected requests return JSON errors. The UI also displays plain-text proxy errors without trying to treat them as JSON.

Update the custom-node folder with `git pull --ff-only`, restart ComfyUI, then hard-refresh the browser. If your proxy strips the browser's `Sec-Fetch-Site` header, set `AVA_PUBLIC_ORIGIN` to the exact public ComfyUI origin, for example `https://your-pod-8188.proxy.runpod.net`, and restart. Cross-origin browser requests remain blocked.

### Qwen progress error before any queued workflow

Version 0.3.2 fixes `AttributeError: 'PromptServer' object has no attribute 'last_prompt_id'` during sidebar planning. ComfyUI's token progress callback assumes a queued workflow, but sidebar requests run outside the queue. Sidebar generation now checks cancellation without sending progress through that callback; canvas nodes and progress from other threads retain ComfyUI's normal hook. The original hook is restored on success or failure. Update with `git pull --ff-only` and restart ComfyUI; model files do not need to be downloaded again.

## Validation

```bash
python -m unittest discover -s tests -v
```

Tests exercise native runtime calls with stubbed model weights, reference/image ordering, approval and duration rules, H3 graph wiring, submission recovery, workflow metadata and real FFmpeg finalization. Browser integration exercises the real UI/routes/store with mocked Qwen and Comfy execution. Native Qwen/H3 GPU inference and the automatic ComfyUI model-download dialog still require validation on the target pod. Direct download links and terminal commands are provided in the workflow independently of that dialog.

Sources: [Qwen3-VL model files](https://huggingface.co/Comfy-Org/Qwen3-VL), [ComfyUI Qwen3-VL implementation](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/text_encoders/qwen3vl.py), [native generation API](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_textgen.py), [H3 nodes](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py).
