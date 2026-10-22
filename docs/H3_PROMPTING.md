# Codex prompt writing for FastH3

Version 0.9.0 uses one natural-language prompt per clip. H3 writing guides inform descriptive quality, while the app's actual media bindings determine which reference names and labels can be used. The app does not enforce the guides' section layout.

Reference guides:

- [MiniMax H3 prompt-writing skill](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md)
- [Full-reference format guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)
- [Base video format guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)

Codex plans through the URL-connected desktop helper on Windows or macOS. Prompt guidance does not install a separate rewrite model or change FastH3 weights.

## Clip count and durations

Codex receives the complete script and the supplied reference manifest/images. It chooses how many clips to return and assigns a `duration` in seconds to each. Instructions favor one clip when the scene fits naturally, otherwise the fewest consecutive clips preserving all actions, exact dialogue, pauses and reactions. Each clip must be 2–15 seconds; 12–15 seconds is preferred when useful, with a shorter final clip when appropriate. Speech and action may overlap when physically plausible.

The clip count is the length of Codex's returned `clips` array. Durations are model estimates, not measurements from generated speech. The app validates 1–40 clips, duration limits, unique IDs, supplied references and transitions. It does not independently calculate spoken timing or prove script coverage. Users review the plan and can edit each duration before approval.

Only the first clip receives a final generation prompt during planning. Later clips retain story outlines until their actual preceding saved frame is available.

## One editable prompt

For a prompt revision, Codex returns one text value:

```json
{"prompt":"Static medium shot. Actor opens the door and says the exact scripted line with synchronized lips. The latch clicks over quiet room ambience."}
```

The same plain-text format works with and without selected references. There are no required section headings, shot labels, speaker IDs or dialogue tags. Existing headed prompts remain usable, and older objects containing section strings are flattened without requiring any particular section to exist. A Markdown fence around the entire prompt can be removed; the actual prose and dialogue are preserved.

Guidance asks for concrete style, framing, visible appearance, setting, lighting, observable action and end state. A fixed camera and one continuous shot are defaults for simple action. Dialogue retains the script's exact wording, language and speaking order; visible speakers get lip sync and voiceover is identified as off-screen. Ambience and physical sounds fit naturally into the same text. Music and narration are included only when requested. These are writing instructions, not structural validation gates.

## References and continuity

The host supplies names and stable `<Subject N>` labels for visual reference slots. Names alone are sufficient in the prompt. If Codex uses a Subject label, it must be one of the selected references' supplied labels. Voice-only references guide timbre and delivery without supplying an appearance or new spoken words.

At submission the host prepends the real `Reference` block mapping names and subjects to actual `<Picture N>` and `<Audio N>` input order. Codex must not guess those media indices. The actual previous last frame is separate: a continuous clip receives it through `MiniMaxH3AddGuide` at frame zero, named **Opening Frame** in the bound prompt. For a cut it is story context only. This package does not accept source-video editing inputs or ending-frame constraints.

## Existing scenes, background tasks and validation

Update the nodes, restart ComfyUI and hard-refresh the browser. **Plan prompt** or **Apply comments with Codex** produces a plain prompt for one draft. **Replan / optimize unsubmitted clips** applies the clip-planning policy before takes are submitted. Submitted plans and saved takes stay preserved; use a new scene to replan them. Every render still requires explicit clip approval.

Sidebar discovery, clip planning and prompt revisions run in persisted background tasks while the browser polls status. Reloading reconnects to the same task. Losing a response does not rerun Codex. A failed task preserves saved drafts and takes. If ComfyUI restarts, interrupted planning is reported and requires an explicit retry. Canvas nodes still await normal ComfyUI execution.

Prompt validation checks nonempty text, a 12000-character limit and valid media bindings. It does not require named sections, section order, shot numbering, timestamp syntax, speaker IDs or dialogue tags. One repair attempt can correct invalid response JSON, empty/oversized text or invented media bindings. No render is submitted by this retry. Automated tests stub Codex and queue execution; native GPU inference and semantic script fidelity still require target-pod evaluation.
