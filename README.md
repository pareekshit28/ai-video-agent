# ComfyUI AI Video Agent

This ComfyUI custom-node package imports ChatGPT scene plans as JSON, keeps references and rendered media inside projects, and renders reviewed FastH3 clips. No planner model or desktop helper is needed on the pod. The MiniMax H3 text encoder is still required for render conditioning.

## Install

Place this directory under `ComfyUI/custom_nodes/ComfyUI-AI-Video-Agent`, install `requirements.txt` into the ComfyUI Python environment, and restart ComfyUI. Install FFmpeg and FFprobe on the server. Use `AVA_STORAGE_DIR` for a persistent volume if the default ComfyUI output folder is not persistent. The included `workflow.json` contains model links and a reviewed clip canvas node.

## Plan and render

1. In the AI Video Agent sidebar, create a project. Projects have separate reference and video libraries. Existing episode/scene data is preserved and presented in one project workspace on first access.
2. Add character, location or prop entries in Library, then upload the real images or voice samples. Download the reference manifest and [scene-planning skill](skills/comfyui-scene-planner/SKILL.md) from the agent. Give those and your script to ChatGPT. Attach the skill to a ChatGPT Project and instruct it to use it for every scene.
3. Paste ChatGPT's JSON into **Import a scene**. Each clip must provide `duration`, `references`, `prompt` and `use_last_frame`. Imports append new clips; previous takes stay saved. Edit a clip's prompt, duration, references or continuity choice, save, review and approve the render.
4. The completed video plays in the clip and Saved videos sections. Its extracted last frame stays with that saved clip. A clip with `use_last_frame: true` uses the immediately preceding clip's saved final frame at review and render time. If the preceding clip is regenerated, save and review the following clip again.

Example:

```json
{"version":1,"scene":"Arrival","clips":[{"title":"At the door","duration":8,"references":[],"use_last_frame":false,"prompt":"A moving camera follows a traveler toward a house. She reaches the door and knocks twice. Gravel crunches beneath her feet; no dialogue."},{"title":"Answer","duration":5,"references":[],"use_last_frame":true,"prompt":"Continue from the supplied opening frame at the door. The door opens and the traveler says, \"You're home.\" softly, with synchronized lip movement."}]}
```

Reference entries must exist in the selected project's library and contain files. Use exact IDs from the manifest. Each clip allows at most nine image files and three voice files; duration is 2–15 seconds. ChatGPT should choose camera movement and cuts to fit the scene. The app assigns numbered H3 media inputs at render time. Every GPU render still requires explicit per-clip approval.

The app runs CPU-only contract and browser fixture tests locally. Rendering on a RunPod GPU must be verified on the target pod.
