"""Plain H3 prompt guidance and checks for the host's actual media bindings."""
import re

VERSION = "h3-plain-2026-10-22.3"
# These names only preserve ordering when flattening older section-object output.
BASE_FIELDS = ("integrated_multimodal_description", "overall_soundscape", "non_diegetic_music")
REF_FIELDS = ("subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music")
SUBJECT = re.compile(r"<Subject\s+(\d+)>")
ASSET = re.compile(r"<(?:Picture|Audio|Video)\s*\d+>", re.I)

RULES = """H3 PROMPT GUIDANCE (apply to final prompts, not reference discovery or later-clip outlines):
Return each final prompt as ONE complete natural-language text string in the requested JSON response.
Write descriptive prose covering the visible style, subjects, setting, composition, lighting, action,
reactions and end state, with sound and speech naturally included in the same prompt. There are no
required section headings, shot labels, speaker IDs or dialogue tags. Escape newlines correctly in JSON.
Later-clip outlines remain strings. Write descriptions in English; preserve the original language and
exact wording of dialogue, lyrics and visible text. Preserve the script's events and speaking order.
Identify who speaks, their delivery and whether their synchronized lips are visible or the voice is
off-screen. Keep visible characters' lips closed for voiceover. Never invent dialogue, narration or
subtitles. Include ambience and physical sounds; include music only when requested by the script or
comments. Fit action, natural speech, pauses and reactions into the clip's requested duration.

Use the actual supplied images as authority for appearance and setting. Refer to selected characters,
places and props by their supplied names. If using Subject labels, use only supplied subjectLabel
values. A voice sample supplies timbre and delivery, not its recorded words or a person's appearance.
Never invent Picture/Audio/Video indices or a Reference block; the host binds real media at render time.
Prefer one continuous shot and a fixed camera for simple action. Describe any requested camera move
or necessary cut clearly in ordinary prose, keeping actions and cuts achievable within the duration.

For a continuation, inspect the actual previous-frame attachment and begin from Opening Frame at
zero seconds. Preserve observed framing, pose, lighting and prop state, then continue the next action
without replaying prior beats or lines. This is a frame-zero guide, separate from numbered identity
references. For a deliberate cut/time jump, use the previous frame only as story context. Do not invent
unseen prior events, ending-frame constraints or source-video editing inputs. Each final prompt must
stand alone with the selected references and starting state. Keep saved takes unchanged, and wait for
the actual prior frame before writing a later clip's final generation prompt.
"""


def subject_labels(scene):
    return {ref["id"]: f"<Subject {index + 1}>" for index, ref in enumerate(scene["references"])
            if any(a["kind"] == "image" for a in ref.get("assets", []))}


def context(references, frame_guide=False):
    return {"version": VERSION, "mode": "ref2va" if references else "t2va", "frameGuide": bool(frame_guide),
            "promptFormat": "one natural-language text string; no required headings or tags",
            "assetBinding": "Host assigns actual Picture/Audio indices in Reference; never guess them."}


def normalize(prompt, references, duration=None):
    """Keep prose intact; flatten older objects without requiring any section."""
    if isinstance(prompt, dict):
        if any(not isinstance(value, str) for value in prompt.values()):
            raise ValueError("H3 prompt must contain text strings")
        legacy_order = REF_FIELDS if references else BASE_FIELDS
        keys = [key for key in legacy_order if key in prompt] + [key for key in prompt if key not in legacy_order]
        prompt = "\n".join(key + ": " + prompt[key].strip() for key in keys if prompt[key].strip())
    if not isinstance(prompt, str):
        raise ValueError("H3 prompt must be text")
    prompt = prompt.strip()
    # Remove only a fence around the entire prompt; preserve the actual content.
    fence = re.fullmatch(r"```(?:text|plaintext|markdown|yaml)?[ \t]*\r?\n(.*?)\r?\n```", prompt, re.S | re.I)
    if fence:
        prompt = fence[1].strip()
    return validate(prompt, references, duration)


def validate(prompt, references, duration=None):
    """Check nonempty text and real media bindings, without enforcing a prose layout."""
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 12000:
        raise ValueError("H3 prompt must be nonempty and at most 12000 characters")
    if ASSET.search(prompt) or re.search(r"(?mi)^\s*Reference\s*:?\s*$", prompt):
        raise ValueError("Leave media indices and Reference to the host")
    allowed = {r.get("subjectLabel") for r in references if r.get("subjectLabel")}
    if any(match.group(0) not in allowed for match in SUBJECT.finditer(prompt)):
        raise ValueError("Use only the selected references' supplied Subject labels")
    return prompt
