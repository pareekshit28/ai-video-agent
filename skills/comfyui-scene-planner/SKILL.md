---
name: comfyui-scene-planner
description: Plan or revise a scene as importable clip JSON for the ComfyUI AI Video Agent, including H3 prompts, natural durations, project reference selection and last-frame continuity decisions. Use whenever the user plans a scene for this agent.
---

# ComfyUI scene planner

Return a complete scene plan as one valid JSON object that the user can paste into the ComfyUI AI Video Agent. Plan and write prompts here in ChatGPT; the ComfyUI agent imports and renders them after the user's per-clip approval.

Use this skill for every scene planned for this agent. In a ChatGPT Project, attach this file and add the instruction: "Use the attached ComfyUI scene planner skill whenever planning or revising a scene for my ComfyUI AI Video Agent."

## Inputs and references

Read the scene/script, creative direction and the current project's exported reference manifest. Inspect supplied images and any actual last-frame image. If a script depends on reference assets that have not been supplied, identify the needed character, location or prop references first and request them before the final plan. A scene that needs no assets can use an empty references list.

Select only library entries in the supplied project's manifest. Copy their exact IDs into each clip's `references` array; unique exact names are accepted by the importer, but IDs avoid ambiguity. Use those entries' names in the prose prompt. Select only what that clip needs. Each clip supports at most 9 image files and 3 voice files, counted across all selected entries. A voice reference supplies timbre, not new dialogue or visual appearance. Metadata and filenames alone do not reveal an image's contents; do not claim to have seen or heard unavailable media.

If the manifest is unavailable, ask for it when references are needed. Do not invent IDs, file paths, asset URLs, numbered media tags, or a `Reference` block. The renderer binds real `<Picture N>` and `<Audio N>` inputs. Last-frame continuity uses the preceding clip's saved frame as a separate frame-zero guide; do not include it in `references`.

## Clip planning

Preserve every required event and the exact dialogue, language, speaker and order. Estimate natural delivery plus pauses, reactions and action. Use one clip if the scene fits naturally within 15 seconds; otherwise use the fewest natural 2–15 second clips. Speech and action can overlap when plausible. Split at natural beats or sentence boundaries. Never rush dialogue, omit action or add filler to reduce clip count. Necessary internal cuts can occur within one clip.

Write every clip's complete generation prompt now, including later clips. Prompts are editable and can be revised after an actual frame is available. Use descriptive English prose for style, subjects, setting, framing, lighting, ordered action, reactions and end state. Keep dialogue and visible text in their original language. Identify each speaker, delivery and lip sync or off-screen speech. Include appropriate ambience and physical sound; add narration, subtitles or music only when requested. No section headings, dialogue tags or shot numbering are required.

Choose framing, camera movement and cuts to suit the story and user direction. There is no static-shot requirement or fixed-camera default. Keep camera motion, transitions, action and dialogue feasible within the duration.

## Last-frame decision

Set `use_last_frame` independently for each clip:

- `true` for continuous action that should start from the immediately preceding clip's saved final frame. Continue the physical state without replaying completed dialogue or actions. When a real frame is supplied, adapt to its visible pose, gaze, objects and lighting. When it is not available yet, describe continuing from the supplied opening frame without inventing its observed contents.
- `false` for a new scene, intentional shot reset, incompatible composition, time jump, or whenever the previous composition should not anchor the start. Appearance references still apply.

The first clip in a project has no predecessor, so set continuity to `false`. The first clip of an appended scene can use continuity when it follows the project's last clip. Later clips can use continuity after their immediate predecessor renders. The app uses that predecessor's current saved frame, including a replacement take, at review/render time. It never searches other clips or a library for a newer frame. If the predecessor's frame is unsuitable, set continuity to `false` or revise the plan. Do not assume that a still frame proves dialogue was spoken.

## Output contract

When inputs are sufficient, return JSON only, without Markdown fences or surrounding commentary. Escape dialogue quotes and newlines correctly. `version` must be integer `1`; `clips` must contain 1–40 objects. `scene` and each clip's `title` are optional labels. Required clip fields are `duration` (number, 2–15 seconds), `references` (array of distinct library ID strings), `use_last_frame` (boolean), and `prompt` (nonempty string, at most 12000 characters).

Example without external appearance or voice references:

```json
{
  "version": 1,
  "scene": "The arrival",
  "clips": [
    {
      "title": "Approaching the house",
      "duration": 8,
      "references": [],
      "use_last_frame": false,
      "prompt": "Cinematic live action in warm late-afternoon light. A gentle tracking shot follows a traveler along a gravel path toward a small house. She slows at the door, raises her hand and knocks twice. Footsteps crunch and the knocks echo softly. No dialogue."
    },
    {
      "title": "An answer",
      "duration": 5,
      "references": [],
      "use_last_frame": true,
      "prompt": "Continue from the supplied opening frame at the door without repeating the approach or knocks. The traveler lowers her hand as the door opens. The camera eases closer to her relieved expression. She says, \"You're home.\" softly, with synchronized lip movement. A hinge creaks over quiet outdoor ambience."
    }
  ]
}
```

Check that every referenced ID exists in the current manifest, media counts fit, every clip has a complete prompt, all required story beats and exact dialogue appear once, durations allow natural performance, and continuity decisions fit the intended transitions. Importing appends clips and never submits a render or replaces saved takes.
