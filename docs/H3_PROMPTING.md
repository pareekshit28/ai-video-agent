# Qwen prompt writing for FastH3

Version 0.7.0 adapts MiniMax's H3 prompt-writing guides to this package's actual image, voice and frame-guide inputs. Guidance checked on 22 October 2026:

- [MiniMax H3 prompt-writing skill](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md)
- [Full-reference format guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)
- [Base video format guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)

This is an instruction and validation update for the existing complete Qwen3-VL planner. It does not install MiniMax's separate context-rewrite model or change the FastH3 weights.

## Fewer clips

Qwen now starts by asking whether the complete scene fits naturally into one clip. Otherwise it groups consecutive beats into as few clips as practical, using up to the existing 15-second limit. It budgets speech, pauses, reactions and physical actions, allowing speech and action to overlap when plausible. It can include an internal camera cut within one clip; each sentence or minor action does not need a separate clip.

The policy preserves the full script and natural delivery. Longer speech or necessary continuity/reference changes can still require more clips. Clip count is a planning preference, not a promise that every script fits into one clip. Durations remain editable from 2–15 seconds.

## Editable prompt format

With selected reference files, the generated prompt uses six sections in order:

```text
subject_definitions:
summary:
retention_analysis:
detailed_description:
overall_soundscape:
non_diegetic_music:
```

Without reference files, it uses `integrated_multimodal_description`, `overall_soundscape` and `non_diegetic_music`. Descriptions are English; dialogue and visible text retain their original language. For reference prompts, the visual style precedes the first shot. Base descriptions introduce style inside the first shot.

Shots use `[Shot 1]` without an opening timestamp. An actual subsequent cut can start `[Shot 2] At 00:08.000, ...`. Cut times must increase and fall inside the clip. Qwen describes framing, action, state changes and relevant camera movement. Simple actions favor one continuous shot and the existing locked-camera default.

Spoken lines use stable speaker IDs and language-tagged dialogue, for example this original illustrative line:

```text
Asha (S1) says quietly with synchronized lips: <d>[Hindi] मैं तैयार हूँ।</d>
```

Only words supplied by the script or an explicit revision belong inside dialogue tags. Voiceover is identified as off-screen, with the visible character's lips closed. Ambience and physical sounds have their own section; dialogue is not duplicated there. Music stays `N/A` unless requested.

## Binding references and continuity

The app supplies a stable `<Subject N>` label for each visual reference slot. Qwen defines the selected subjects and their preserved characteristics. Voice-only slots have a name and vocal role, without an invented appearance. At submission the app prepends a `Reference` block mapping those names and subjects to the actual `<Picture N>` and `<Audio N>` input order. Those two media categories are numbered independently. Qwen must not guess file indices.

An identity image supplies appearance; a location supplies setting; a prop supplies its identifying features. A voice sample supplies timbre rather than its recorded words. The actual previous last frame is separate: continuous clips receive it through `MiniMaxH3AddGuide` at frame zero, named **Opening Frame** in the prompt. For a cut it is story context only. This package does not accept source-video editing/reuse or an ending-frame constraint.

## Existing scenes and validation

Update the nodes, restart ComfyUI and hard-refresh the browser. For a scene with no submitted takes, **Replan / optimize unsubmitted clips** applies the new clip policy. Review its replacement plan before rendering. Plans with submitted takes stay preserved; copy the script/references into a new scene to plan fewer clips.

For one existing draft, **Plan prompt** or **Apply comments with Qwen** produces the new format without replanning the scene. Later prompts still wait for the preceding clip's actual saved frame. Manual prompts and saved takes remain usable; the update does not silently rewrite them. Every render still requires explicit clip approval.

As of version 0.7.2, Qwen is asked for **one complete prompt string**: `{"prompt":"subject_definitions: ...\nsummary: ...\n..."}` for a reference-based revision. All H3 headings belong inside that string. Planning returns `{"clips":[...]}` with each clip's `prompt` as a string; later clips retain outlines until their actual prior frame is available. Section objects returned by older responses remain accepted for compatibility. Complete text accepts Markdown headings, title case, spaces/hyphens and reordered sections. Normalization only changes headings, section order and an enclosing Markdown fence; it does not invent missing content or rewrite dialogue.

Sidebar planning runs in a persisted background task while the browser polls its status. Reloading reconnects to that task; losing a response does not restart Qwen. Failed planning preserves saved drafts and takes. If ComfyUI itself restarts, the interrupted task is reported as failed and must be retried explicitly. This applies to discovery, clip planning and individual prompt revisions; standalone canvas nodes still await their normal ComfyUI execution.

Generated drafts are checked for complete, unique sections, selected subject labels, shot timing and dialogue syntax. Missing, duplicate or unexpected section keys are reported by name. One formatting repair is attempted with the required fields before reporting an error; no render is submitted by this retry. These checks do not prove semantic script fidelity or GPU output quality. Automated tests use stubbed Qwen output and queue execution; evaluate the new prompting behavior on the pod before relying on its visual results.
