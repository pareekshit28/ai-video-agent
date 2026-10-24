# ComfyUI AI Video Agent

This ComfyUI custom-node package imports ChatGPT scene plans as JSON, keeps references and rendered media inside projects, and renders reviewed FastH3 clips. No planner model or desktop helper is needed on the pod. The MiniMax H3 text encoder is still required for render conditioning.

## Install

Place this directory under `ComfyUI/custom_nodes/ComfyUI-AI-Video-Agent`, install `requirements.txt` into the ComfyUI Python environment, and restart ComfyUI. Install FFmpeg and FFprobe on the server. Use `AVA_STORAGE_DIR` for a persistent volume if the default ComfyUI output folder is not persistent. The included `workflow.json` contains model links and a reviewed clip canvas node.

## Plan and render

1. In the AI Video Agent sidebar, create a project, then select its initial scene or use **Create new scene**. Each scene contains its own clips, shared reference selections and last-frame continuity. Library items, saved videos and render settings belong to the project.
2. Give ChatGPT your scene and the [scene-planning skill](skills/comfyui-scene-planner/SKILL.md). It identifies the needed character, location and prop image/audio slots without knowing what is already in your library. Attach the skill to a ChatGPT Project and instruct it to use it for every scene.
3. Select the intended scene and paste ChatGPT's JSON into **Import clips**. The top-level `references` defines shared scene slots; each clip provides `duration`, the scene tags it uses, `prompt`, `static_shot` and `use_last_frame`. Select matching items and files once in **Scene reference slots**, then save the scene selections. Importing does not create project-library entries. Unfilled slots are optional and omitted from each clip's H3 prompt and inputs. Edit the clip prose, duration, static-shot checkbox or continuity choice, review the H3 prompt preview and approve the render. Imports append clips only to the selected scene and keep previous takes.
4. The completed video plays in the clip and Saved videos sections. Its extracted last frame stays with that saved clip. A clip with `use_last_frame: true` uses the immediately preceding clip's saved final frame at review and render time. If the preceding clip is regenerated, save and review the following clip again.

Example:

```json
{"version":1,"scene":"Arrival","references":[{"tag":"Image 1","name":"Traveler","type":"character"},{"tag":"Image 2","name":"House entrance","type":"location"}],"clips":[{"title":"At the door","duration":8,"references":["Image 1","Image 2"],"static_shot":false,"use_last_frame":false,"prompt":"Image 1: Traveler (character)\nImage 2: House entrance (location)\n\nThe traveler walks toward the house entrance, reaches the door and knocks twice. Gravel crunches beneath her feet; no dialogue."},{"title":"Answer","duration":5,"references":["Image 1"],"static_shot":true,"use_last_frame":true,"prompt":"Image 1: Traveler (character)\n\nContinue from the opening frame at the door. The traveler remains in place as the door opens and says, \"You're home.\" softly, with synchronized lip movement."}]}
```

Reference slots are descriptive until you fill them from the selected project's library. Shared selections apply automatically to all new clips using those slots. Earlier clips keep their existing data; older JSON with per-clip reference definitions is also accepted for new imports and merged into scene slots. Each clip allows at most nine image and three audio files; duration is 2–10 seconds. The imported header declares the clip's tags, names and types in scene order. The app removes unfilled declarations and assigns contiguous H3 tags, attaching chosen files in the same relative order. ChatGPT generally sets `static_shot: true` for stationary character blocking and `false` when characters move through the scene. The editable checkbox adds a fixed-camera instruction only when checked, independently of last-frame continuity. No static declaration is required or validated in prose. Every GPU render still requires explicit per-clip approval.

Previously completed takes remain playable at their saved durations. To regenerate one, set its next-take duration to 10 seconds or less, choose its static-shot setting and save the prompt for review.

## Shared storage across pods

Different scenes can submit independently. On separate ComfyUI pods, scenes within the same project can render at the same time. The active-job guard applies only to the scene being submitted. One scene still permits only one active or unresolved job.

Update this package on every pod, restart ComfyUI, and point each pod's `AVA_STORAGE_DIR` at the same shared directory. Jobs record their submitting worker; other pods display the shared status without polling their own queues for those jobs or offering pause/recovery controls. Use the submitting pod to manage an active job. An older job without recorded ownership requires **Resume existing job / saving** on its original pod; the agent checks local queue/history or saved output before claiming it.

Worker identity uses `AVA_WORKER_ID`, then `RUNPOD_POD_ID` when present, otherwise the machine hostname. If needed, set a distinct, stable `AVA_WORKER_ID` for each pod before starting ComfyUI, such as `render-pod-a` and `render-pod-b`. Keep it unchanged across ComfyUI restarts and never share an identity between live pods. Shared storage must support OS file locks; project and scene writes coordinate through the `.locks` directory, and the OS releases held locks if a process exits.

The app runs CPU-only contract and browser fixture tests locally. Rendering on a RunPod GPU must be verified on the target pod.
