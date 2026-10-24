---
name: comfyui-scene-planner
description: Plan or revise a scene as importable FastH3 clip JSON, identifying needed character, location and prop reference slots without access to the ComfyUI library. Use whenever planning a scene for this agent.
---

# ComfyUI scene planner

Plan every clip and write its complete FastH3 prompt in ChatGPT. Return one JSON object the user can paste into the ComfyUI AI Video Agent. The agent shows shared scene reference slots; the user selects project-library files once for all relevant clips. Importing a scene never creates library items. Unfilled slots are optional and omitted from render prompts and inputs.

Use this skill for every scene planned for this agent. In a ChatGPT Project, attach this file and instruct ChatGPT to use it whenever planning or revising a scene for the ComfyUI AI Video Agent.

## Identify needed references

Analyze the scene and decide which visual or audio inputs H3 needs for each clip. Do not assume knowledge of existing library items, ask for a library manifest, invent library IDs or file paths, or claim to have inspected media that was not supplied. Name each needed subject or sound so the user can find or create the corresponding library item. Use `type: "character"`, `"location"` or `"prop"`. A character image establishes appearance; a location image establishes the environment; a prop image establishes an object's look. An audio sample may establish a character's voice, location ambience or prop sound. Put only needed inputs in a clip; use `[]` if no external reference is needed.

Declare the scene's slots once in the top-level `references` array: `{"tag":"Image 1","name":"Mara","type":"character"}`. Use `Image 1` through `Image 9` and then `Audio 1` through `Audio 3`, with contiguous numbers starting at 1 for each medium. List every Image slot before Audio slots. Reuse each slot's tag throughout the scene; do not redefine the same subject for every clip. If a subject needs two different images, give those requirements distinct names and slots. Names and types describe the requirement; the user selects the actual library item and file later. The previous clip's final frame is never a reference slot.

Each clip's `references` is an array of the scene tags it actually needs, such as `["Image 1", "Audio 1"]`, in scene-array order. Use `[]` when none is needed. Keep the scene tags even if the subset has a gap; do not renumber them within the JSON or declaration header.

## Write H3 prompts with reference tags

Start each clip's `prompt` with **one declaration line per tag in that clip's references array, in exactly the same order**. Resolve its name and type from the scene-level definitions. Each line must exactly match `Tag: Name (type)`, using the slot's spelling and capitalization. Follow the declarations with a blank line and scene prose. For example:

```text
Image 1: Mara (character)
Image 2: Riverside station (location)
Audio 1: Mara voice (character)

Static locked-off shot. From a fixed view of Riverside station, Mara crosses the platform and stops near the camera. She says, "The train is here," softly, with synchronized lip movement. Footsteps and distant train noise sit under her speech.
```

The declaration header identifies each input's subject, type and order. Keep file-dependent instructions out of the scene prose: do not claim a supplied image or voice exists, tell H3 to match an unprovided file, or use Image/Audio tags in the prose. Describe the story by subject names so it remains coherent without reference files. Use a clear audio slot name to identify voice, ambience or a prop sound; do not turn sample speech into extra scripted dialogue.

The renderer keeps only slots that have a selected library file, then assigns contiguous H3 `<Picture N>` and `<Audio N>` tags and attaches files in that same relative order. An unfilled slot contributes no declaration, tag or file to that clip. Named characters and objects can still appear in the story without a supplied identity reference. The UI shows editable prose and the resulting H3 prompt preview. Do not write raw `<Picture N>`, `<Audio N>`, `<Video N>` or a `Reference` section yourself, or make an appearance image a compulsory starting composition.

After the header, begin scene prose with the exact sentence `Static locked-off shot.` Each clip uses one fixed camera position, framing and focal length throughout: no pan, tilt, track, dolly, orbit, zoom, handheld motion, reframing or cut within the clip. Describe a useful composition and let subjects move and perform within it. A new clip may use a different locked composition. Write clear English prose for style, subjects, setting, framing, lighting, ordered action, reactions and end state. Preserve the exact dialogue, language, speaker and order from the scene. Identify delivery and whether speech has visible synchronized lips or is off-screen. Include appropriate ambience and physical sounds; add narration, subtitles or music only if requested. Keep action, dialogue, pauses and reactions feasible within the clip duration.

## Plan clips and continuity

Prefer one clip if the complete scene fits naturally in one locked shot lasting 2–10 seconds. Otherwise use the fewest natural 2–10 second clips, each with a single fixed composition. Split at a useful beat without rushing or omitting action or dialogue. Write complete prompts for later clips now; the user can revise them after rendering the preceding clip.

Set `use_last_frame` to `true` only when continuous action should start from the immediately preceding clip in the same scene's saved final frame. Continue its physical state without replaying completed action or dialogue. If the frame has not been shown to you, do not invent observed pose, gaze or objects. Set it to `false` for a new composition, time jump or incompatible predecessor. The first clip of every new scene must use `false`; an appended import can use `true` for its first clip when that scene already has a preceding clip.

## Output contract

When the scene is sufficiently specified, return JSON only, with no Markdown fence. The user creates or selects a scene under their project before importing; the JSON `scene` label does not create or select one. `version` is integer `1`; top-level `references` is the ordered array of `{tag,name,type}` scene slots; `clips` contains 1–40 objects. `scene` and clip `title` are optional labels. Each clip requires `duration` (number, 2–10), `references` (ordered array of scene tag strings), `use_last_frame` (boolean) and `prompt` (nonempty string, at most 12000 characters). Escape newlines and dialogue quotes as valid JSON. A clip with no references has no declaration header and begins directly with `Static locked-off shot.`

```json
{
  "version": 1,
  "scene": "Arrival",
  "references": [
    { "tag": "Image 1", "name": "Mara", "type": "character" },
    { "tag": "Image 2", "name": "Riverside station", "type": "location" },
    { "tag": "Audio 1", "name": "Mara voice", "type": "character" }
  ],
  "clips": [
    {
      "title": "At the platform",
      "duration": 8,
      "references": ["Image 1", "Image 2", "Audio 1"],
      "use_last_frame": false,
      "prompt": "Image 1: Mara (character)\nImage 2: Riverside station (location)\nAudio 1: Mara voice (character)\n\nStatic locked-off shot. From a fixed view of Riverside station, Mara crosses the platform and stops near the camera. She says, \"The train is here,\" softly, with synchronized lip movement. Footsteps and distant train noise accompany her."
    }
  ]
}
```

Before responding, check that the reference declarations match the array exactly, each needed slot has a clear name and type, every scene prompt begins with `Static locked-off shot.` and contains no camera movement or internal cut, events and exact dialogue appear once, durations do not exceed 10 seconds, and continuity matches the intended transition. Importing a plan does not fill slots, submit a render or replace saved takes.
