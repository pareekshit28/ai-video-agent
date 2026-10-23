# FastH3 prompt contract

ChatGPT supplies a complete prompt for every clip in the scene JSON. Its [planning skill](../skills/comfyui-scene-planner/SKILL.md) defines the clip schema, reference handling, duration and continuity decisions. The user can edit any prompt before approving generation.

The host prepends a Reference block that binds only actual selected project assets to `<Picture N>` and `<Audio N>` inputs. Prompts use reference names and do not invent media indices. Voice references provide timbre only. A `use_last_frame: true` clip receives the immediately preceding clip's saved final frame through `MiniMaxH3AddGuide` at frame zero, separate from numbered identity images. The prompt begins from that Opening Frame without claiming to have observed it unless ChatGPT was actually shown the image. A new take of the preceding clip changes the review key.

The prompt describes visible style, subjects, setting, framing, lighting, actions, dialogue and sound in natural prose. Preserve exact scripted dialogue and speaking order. Camera movement and cuts are chosen for the scene; there is no static-shot default. Prompt validation checks nonempty text, size and host-managed media bindings without enforcing headings or shot labels.
