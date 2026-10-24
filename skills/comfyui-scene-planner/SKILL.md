---
name: comfyui-scene-planner
description: Plan or revise a scene as importable FastH3 clip JSON, identifying needed character, location and prop reference slots without access to the ComfyUI library. Use whenever planning a scene for this agent.
---

# ComfyUI scene planner

Plan every clip and write its complete FastH3 prompt in ChatGPT. Return one JSON object the user can paste into the ComfyUI AI Video Agent. The agent shows reference slots, and the user fills them with files from the selected project's library before approving each render.

Use this skill for every scene planned for this agent. In a ChatGPT Project, attach this file and instruct ChatGPT to use it whenever planning or revising a scene for the ComfyUI AI Video Agent.

## Identify needed references

Analyze the scene and decide which visual or audio inputs H3 needs for each clip. Do not assume knowledge of existing library items, ask for a library manifest, invent library IDs or file paths, or claim to have inspected media that was not supplied. Name each needed subject or sound so the user can find or create the corresponding library item. Use `type: "character"`, `"location"` or `"prop"`. A character image establishes appearance; a location image establishes the environment; a prop image establishes an object's look. An audio sample may establish a character's voice, location ambience or prop sound. Put only needed inputs in a clip; use `[]` if no external reference is needed.

Each entry in `references` is one file slot: `{"tag":"Image 1","name":"Mara","type":"character"}`. Use `Image 1` through `Image 9` and then `Audio 1` through `Audio 3`, with contiguous numbers starting at 1 for each medium. List every Image slot before Audio slots. If a subject needs two supplied images, give it two slots. Names and types describe the requirement; the user selects the actual project-library item and file later. The previous clip's final frame is never a reference slot.

## Write H3 prompts with reference tags

Start each clip's `prompt` with **one declaration line per reference, in exactly the same order as the JSON array**. Each line must exactly match `Tag: Name (type)`, using the slot's spelling and capitalization. Follow the declarations with a blank line and scene prose. For example:

```text
Image 1: Mara (character)
Image 2: Riverside station (location)
Audio 1: Mara voice (character)

Static locked-off shot. From a fixed view of Riverside station, Mara crosses the platform and stops near the camera. Preserve her facial features and clothing, and the station's layout and signage. She says, "The train is here," softly in her supplied voice timbre, with synchronized lip movement. Footsteps and distant train noise sit under her speech.
```

The declaration header establishes each image or audio tag's subject, type and order. In the prose, use those names to describe how the references affect appearance, setting, object details or sound. The renderer turns the header into H3 `<Picture N>` and `<Audio N>` bindings in the same order and attaches exactly one selected library file to each slot. Do not write raw `<Picture N>`, `<Audio N>`, `<Video N>` or a `Reference` section yourself. Do not make an appearance image a compulsory starting composition. For audio, state whether it supplies voice timbre, ambience or a physical sound; do not treat words in an audio sample as new scripted dialogue.

After the header, begin scene prose with the exact sentence `Static locked-off shot.` Each clip uses one fixed camera position, framing and focal length throughout: no pan, tilt, track, dolly, orbit, zoom, handheld motion, reframing or cut within the clip. Describe a useful composition and let subjects move and perform within it. A new clip may use a different locked composition. Write clear English prose for style, subjects, setting, framing, lighting, ordered action, reactions and end state. Preserve the exact dialogue, language, speaker and order from the scene. Identify delivery and whether speech has visible synchronized lips or is off-screen. Include appropriate ambience and physical sounds; add narration, subtitles or music only if requested. Keep action, dialogue, pauses and reactions feasible within the clip duration.

## Plan clips and continuity

Prefer one clip if the complete scene fits naturally in one locked shot lasting 2–10 seconds. Otherwise use the fewest natural 2–10 second clips, each with a single fixed composition. Split at a useful beat without rushing or omitting action or dialogue. Write complete prompts for later clips now; the user can revise them after rendering the preceding clip.

Set `use_last_frame` to `true` only when continuous action should start from the immediately preceding clip in the same scene's saved final frame. Continue its physical state without replaying completed action or dialogue. If the frame has not been shown to you, do not invent observed pose, gaze or objects. Set it to `false` for a new composition, time jump or incompatible predecessor. The first clip of every new scene must use `false`; an appended import can use `true` for its first clip when that scene already has a preceding clip.

## Output contract

When the scene is sufficiently specified, return JSON only, with no Markdown fence. The user creates or selects a scene under their project before importing; the JSON `scene` label does not create or select one. `version` is integer `1`; `clips` contains 1–40 objects. `scene` and `title` are optional labels. Each clip requires `duration` (number, 2–10), `references` (ordered array of `{tag,name,type}` slots), `use_last_frame` (boolean) and `prompt` (nonempty string, at most 12000 characters). Escape newlines and dialogue quotes as valid JSON. A clip with no references has no declaration header and begins directly with `Static locked-off shot.`

```json
{
  "version": 1,
  "scene": "Arrival",
  "clips": [
    {
      "title": "At the platform",
      "duration": 8,
      "references": [
        { "tag": "Image 1", "name": "Mara", "type": "character" },
        { "tag": "Image 2", "name": "Riverside station", "type": "location" },
        { "tag": "Audio 1", "name": "Mara voice", "type": "character" }
      ],
      "use_last_frame": false,
      "prompt": "Image 1: Mara (character)\nImage 2: Riverside station (location)\nAudio 1: Mara voice (character)\n\nStatic locked-off shot. From a fixed view of Riverside station, Mara crosses the platform and stops near the camera. Preserve her appearance and the station's layout. She says, \"The train is here,\" softly in her supplied voice timbre, with synchronized lip movement. Footsteps and distant train noise accompany her."
    }
  ]
}
```

Before responding, check that the reference declarations match the array exactly, each needed slot has a clear name and type, every scene prompt begins with `Static locked-off shot.` and contains no camera movement or internal cut, events and exact dialogue appear once, durations do not exceed 10 seconds, and continuity matches the intended transition. Importing a plan does not fill slots, submit a render or replace saved takes.
