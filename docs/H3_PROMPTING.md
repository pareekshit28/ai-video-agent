# FastH3 prompt contract

ChatGPT supplies a complete prompt for every clip in the scene JSON. Its [planning skill](../skills/comfyui-scene-planner/SKILL.md) defines the clip schema, reference handling, duration and continuity decisions. The user can edit any prompt before approving generation.

ChatGPT identifies reference needs without knowing the project library. The top-level JSON `references` array declares the scene's shared slots, each with a `tag` (`Image 1`–`Image 9` or `Audio 1`–`Audio 3`), `name`, and `type` (`character`, `location`, or `prop`). Image slots precede audio slots, and numbering is contiguous within each medium. Each clip lists the scene tags it uses in the same order. The user selects library files once for the scene; importing never adds library items. Unfilled slots are omitted from rendering. A selected file of the wrong type is rejected.

Begin the imported prompt with one declaration per clip tag, in scene order, using exact `Tag: Name (type)` lines. Keep global tags even when a clip uses a subset with gaps. Add a blank line and then describe the scene in natural prose. For example:

```text
Image 1: Mara (character)
Image 2: Station platform (location)
Audio 1: Mara voice (character)

Static locked-off shot. From a fixed view of the station platform, Mara crosses the frame and stops beside the train. She says, "The train is here," softly, with synchronized lip movement. Footsteps and distant train noise accompany her.
```

The host filters those declarations to the clip's supplied scene slots, assigns contiguous `<Picture N>` and `<Audio N>` tags, and binds files to the H3 sockets in that same relative order. For example, if Image 1 is empty and Image 2 is supplied, only Image 2's subject is declared as `<Picture 1>` and its file goes to `ref_image_0`. No missing slot is declared or attached. Each supplied slot contributes exactly one file. The UI edits the prose separately and previews the actual render prompt. Keep file-dependent claims in the generated reference header rather than prose so omitted inputs do not leave instructions to match absent files. A character image preserves identity rather than forcing the first-frame pose; location and prop images preserve their identifying visual details. Audio may supply voice timbre, ambience or a prop sound, never extra dialogue.

A `use_last_frame: true` clip receives the immediately preceding clip's saved final frame through `MiniMaxH3AddGuide` at frame zero, separate from numbered identity images. The prompt begins from that Opening Frame without claiming to have observed it unless ChatGPT was actually shown the image. A new take of the preceding clip changes the review key.

The scene prose begins with `Static locked-off shot.` and describes visible style, subjects, the fixed composition, lighting, actions, dialogue and sound. Preserve exact scripted dialogue and speaking order. Every clip lasts 2–10 seconds and uses one fixed camera position and focal length; use a new clip when the composition must change. The renderer adds an explicit locked-camera constraint to the H3 prompt. Prompt validation checks the declaration order, names and types, the static-shot declaration and common camera-motion contradictions, then the actual media bindings.
