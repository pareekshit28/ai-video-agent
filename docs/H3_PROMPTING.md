# FastH3 prompt contract

ChatGPT supplies a complete prompt for every clip in the scene JSON. Its [planning skill](../skills/comfyui-scene-planner/SKILL.md) defines the clip schema, reference handling, duration and continuity decisions. The user can edit any prompt before approving generation.

ChatGPT identifies reference needs without knowing the project library. Each JSON reference slot has a `tag` (`Image 1`–`Image 9` or `Audio 1`–`Audio 3`), `name`, and `type` (`character`, `location`, or `prop`). Image slots precede audio slots, and numbering is contiguous within each medium. The user fills a slot with one file from a library item of the declared type. A missing or mismatched slot blocks generation.

Begin the editable prompt with one declaration per slot, in JSON order, using exact `Tag: Name (type)` lines. Add a blank line and then describe the scene in natural prose. For example:

```text
Image 1: Mara (character)
Image 2: Station platform (location)
Audio 1: Mara voice (character)

A slow tracking shot follows Mara across the station platform. Keep her appearance and the platform layout consistent with the supplied images. She says, "The train is here," softly in her supplied voice timbre, with synchronized lip movement. Footsteps and distant train noise accompany her.
```

The host turns those declaration lines into a `Reference` block with `<Picture 1>`, `<Picture 2>`, and `<Audio 1>` in the same order, and binds the selected files to the matching H3 input sockets. Each slot supplies exactly one file. ChatGPT should describe what each input is for, without inventing raw H3 tags, asset paths or a `Reference` block. A character image preserves identity, not a required first-frame pose; location and prop images preserve their identifying visual details. An audio sample may supply voice timbre, ambience or an object sound, not extra dialogue.

A `use_last_frame: true` clip receives the immediately preceding clip's saved final frame through `MiniMaxH3AddGuide` at frame zero, separate from numbered identity images. The prompt begins from that Opening Frame without claiming to have observed it unless ChatGPT was actually shown the image. A new take of the preceding clip changes the review key.

The scene prose describes visible style, subjects, setting, framing, lighting, actions, dialogue and sound. Preserve exact scripted dialogue and speaking order. Camera movement and cuts are chosen for the scene; there is no static-shot default. Prompt validation checks the declaration order, names and types, then checks the prose and actual media bindings.
