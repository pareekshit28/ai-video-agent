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

The workspace has three sections: **Agent** for scripts, scene references, prompt review and rendering; **Library** for reusable project references, saved videos and previous takes with download links; and **Settings** for the Qwen model, installation checks and scene render settings. Unsaved inputs stay in place when switching sections. **Open workspace** expands the same UI into a larger window.

1. Select or create a project at the top, choose an episode, then create a scene and paste its script.
2. **Identify references** creates slots only. Supply the actual images and voice samples, or copy entries from the project library.
3. **Understand references & plan clips** inspects supplied images and plans the fewest practical 2–15 second H3 clips, combining actions and dialogue when natural. The first prompt is ready for editing; later clips keep story outlines until their preceding clip finishes.
4. Edit the prompt, reference choices, duration or continuity. Apply revision comments with Qwen if needed. **Approve prompt & generate this clip** submits only that reviewed clip.
5. The video is saved and verified at 24 FPS, trimmed to the requested duration, and its actual last decoded frame is extracted. Qwen inspects that frame to prepare the following prompt, then pauses for review.

Direct continuations use `MiniMaxH3AddGuide` at frame zero. Cuts use the preceding frame only as story context. You can replace/restore the last frame, stage a new duration while retaining the current take, and regenerate individual clips without deleting previous takes. Lost submission responses stop for recovery; resuming never implicitly creates a replacement render. Projects, references, videos, frames and request audits persist in ComfyUI's output directory under `ai_video_agent` by default. Set `AVA_STORAGE_DIR` to a RunPod volume folder if needed.

### H3 prompt style and fewer clips

Version 0.7.3 asks Qwen for **one complete natural-language prompt string**. Section headings, shot labels, speaker IDs and dialogue tags are optional. The app no longer rejects prompts for missing H3 sections, section order or special shot/dialogue syntax. It checks that text is nonempty, at most 12000 characters and uses only real media bindings. Older section objects are still flattened into text for compatibility. Descriptive guidance preserves scripted dialogue, named references and frame continuity without enforcing a prose layout.

Qwen chooses the clip count and each clip's duration from the script and supplied references. It aims to use the fewest clips that preserve actions, exact dialogue and natural pacing, using 2–15 seconds per clip and favoring 12–15 seconds when useful. These are model estimates of speech, pauses and action; the app validates the returned limits, IDs and transitions rather than measuring speech duration. Durations remain editable before approval.

Clip planning, reference discovery and prompt revisions run as background tasks: the request returns immediately and the workspace checks status with short reads. It shows elapsed time and reconnects to the same task after reload or a lost response, without rerunning Qwen. Wait for planning to finish before editing the scene; a failed run preserves its saved drafts and takes. A ComfyUI restart marks unfinished planning as interrupted and requires an explicit retry.

Use **Replan / optimize unsubmitted clips** to apply the fewer-clip policy before any takes are submitted. Existing rendered plans stay preserved; use a new scene to replan them. **Plan prompt** or **Apply comments with Qwen** applies the new H3 format to one draft. See [H3 prompting notes and official sources](docs/H3_PROMPTING.md) for reference binding, examples and validation limits.

### Projects, episodes and scenes

The **Project → Episode → Scene** selectors sit above every workspace section and the render monitor. Each project owns its episodes, shared reference/video library and Qwen model selection. Episodes contain separate scenes; each scene retains its own script, references, render settings, clips and takes.

Version 0.6.0 adds **Create new project**, **Create new episode** and **Create new scene** beside their selectors. Projects and episodes ask for names and are selected immediately after creation. Scenes are created immediately with names such as **Scene 1** and selected automatically. A project must be selected to create an episode, and an episode must be selected to create a scene. These requirements are checked by both the UI and API. Creating an episode starts with no scenes.

Use **Settings → Names & deletion** to rename or delete the selected project, episode or scene. A scene can be renamed before it has a script. Explicit scene renames are preserved during Qwen reference discovery. Deletion moves saved data into `ai_video_agent/.trash` for recovery; deleting an episode includes its scenes and preserves the project library. Active or uncertain render jobs must be resolved before deleting their scene, episode or project. Deleting the last episode keeps the project and its library; create an episode before adding another scene. Cancelling a name/deletion dialog preserves unsaved edits.

Switching projects restores that project's last selected episode and scene. Switching episodes restores the last selected scene in that episode; selections survive browser reloads. Scene requests, edits and uploads validate the selected episode. The pod's GPU queue remains shared, and an existing render continues when switching projects.

All episodes share the selected project's library. Saved videos include their episode and scene names. Qwen settings are saved per project; older pod-wide Qwen settings provide the initial default until a project chooses its own model. Installation files and the physical GPU remain shared by the ComfyUI installation.

Existing projects and scenes appear under **Episode 1** automatically. This compatibility mapping keeps original scene IDs, take histories and media paths intact. **Open workspace** is hidden while the expanded workspace is open and returns after closing it, including with Escape.

### Render status and timing

Version 0.4.0 adds a render monitor visible in every section, plus timing on each clip. It shows **In queue → Rendering → Saving video → Complete**, queue position, sampler steps, elapsed time, estimated finish and the actual completion timestamp. Status polls every five seconds; clocks tick every second without replacing unsaved edits or restarting a playing video.

Elapsed time includes queue waiting. Full-video ETA uses the median of up to ten completed takes from the same project with matching clip duration, steps, resolution, aspect ratio and reference size. On the first matching render, the UI learns the sampler's speed and labels its estimate **Sampling**; decoding and saving still follow, so a full-video finish time is unavailable until comparable timing exists. Model loading, cache hits and GPU contention can change runtime. An exceeded estimate is shown as taking longer, never as a false zero-second countdown.

Submission, execution, saving and completion timestamps persist with each take and survive reloads. Completion is recorded only after video verification and final-frame extraction succeed. Regeneration archives the original take's clock and starts a new one. Older takes without timing show that completion time was not recorded. Displayed dates use the browser's local timezone. Render settings remain editable in **Settings** and apply to the next approved take.

The single workflow also exposes standalone canvas nodes:

- **Qwen · Script & Reference Planner** → JSON plan and first prompt. A supplied image batch needs one manifest entry per image, in order. Use `[]` with no images.
- **Qwen · Frame-Aware Prompt / Revision** → target prompt grounded in an optional preceding frame and the supplied context JSON.
- **AI Video Agent · Generate Reviewed Clip** → copy the four saved IDs/key from **Canvas node IDs / review key** under a reviewed clip. Unmute the node and queue it once to submit the native H3 graph as a separate ComfyUI job.
- **AI Video Agent · Reviewed Clip** → saved prompt/duration/steps for advanced graph use.
- **AI Video Agent · Show Text** → displays node output.

The workflow's lower row is muted initially. Enable it only for the specific revision or reviewed render you intend to run. Changing the prompt, settings, duration, reference bytes, prior frame or take invalidates its review key. A planner node's filename applies to that canvas execution; the sidebar's saved model filename configures project planning.

Use **Check installation** to see missing H3/Qwen files and nodes before rendering. `AVA_COMFY_URL` can override the loopback URL when using HTTPS internally or a port other than 8188 for the canvas render node. `AVA_QWEN_MODEL` selects the initial planner filename. `FFMPEG_PATH` and `FFPROBE_PATH` override the media-tool executable paths.

### RunPod proxy request errors

For **Fetch timeout** during **Understand references & plan clips**, update to version 0.7.2 or later, restart ComfyUI and hard-refresh the browser. Planning no longer holds a single HTTP request open throughout Qwen inference. Temporary status-read failures reconnect automatically; if the connection stays unavailable, the workspace reports that the task may still be running and asks you to refresh. It does not automatically resubmit a planning request or a render.

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
