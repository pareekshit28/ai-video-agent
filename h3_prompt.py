"""H3 prompt-writing contract, adapted to this node pack's actual media binding."""
import re

VERSION = "h3-official-2026-10-22.1"
BASE_FIELDS = ("integrated_multimodal_description", "overall_soundscape", "non_diegetic_music")
REF_FIELDS = ("subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music")
FIELDS = re.compile(r"(?m)^\s*(" + "|".join(dict.fromkeys(BASE_FIELDS + REF_FIELDS)) + r")\s*:\s*")
FIELD_NAMES = "|".join(field.replace("_", r"[ _-]+") for field in dict.fromkeys(BASE_FIELDS + REF_FIELDS))
FORMATTED_FIELDS = re.compile(
    r"(?mi)^[ \t]*(?:#{1,6}[ \t]+)?(?:"
    r"(?P<mark>\*\*|__|`)(?P<marked>" + FIELD_NAMES + r")[ \t]*"
    r"(?::(?P=mark)|(?P=mark)[ \t]*(?::|(?=\r?$)))"
    r"|(?P<plain>" + FIELD_NAMES + r")[ \t]*(?::|(?=\r?$)))")
SUBJECT = re.compile(r"<Subject\s+(\d+)>")
ASSET = re.compile(r"<(?:Picture|Audio|Video)\s*\d+>", re.I)
SHOT = re.compile(r"\[Shot\s+(\d+)\]")
CUT = re.compile(r"^\s*At\s+(\d{2}):([0-5]\d)\.(\d{3}),")

RULES = """H3 PROMPT CONTRACT (apply to final prompts, not reference discovery or later-clip outlines):
The outer response is still the requested JSON object. For each final prompt, return its prompt value
as a JSON object with the section names below as keys and nonempty text as their values. The host
assembles the headings in H3 order; do not put headings or Markdown fences inside the values. Escape
newlines correctly in JSON. Later-clip outlines remain strings. Write descriptions in English; preserve the original language of
dialogue, lyrics and visible text. Use h3Prompting.mode and the reference manifest. For planning,
choose the first prompt's mode from that clip's selected referenceIds, not all available references.

REF2VA: Use these six section keys, once each. The host writes the headings in this order:
subject_definitions: define selected named references, their supplied subjectLabel when present,
and the visible characteristics actually supported by the images. A subjectLabel is a reusable
person/place/prop, not a frame anchor. For voice-only inputs describe the named vocal source without
inventing an appearance or a Subject label. Voice references guide timbre/delivery, never sample words.
summary: one brief paragraph beginning [reference generation], adding + audio reference inside
the brackets only when voice references are selected. Explain the target action and reference roles.
retention_analysis: explain what each selected reference preserves or deliberately changes. Use
fully_preserved, partially_preserved, attribute_transfer or weak_reference for visible references;
use reference for a voice sample. New actions are not losses of identity. Never claim audio reuse.
detailed_description: establish the visible style, then direct the complete chronological shot(s).
overall_soundscape: describe background ambience and physical sounds in a short paragraph.
non_diegetic_music: write N/A unless the user's script/comments request a score; then specify sound,
tempo and development. Do not add a generic cinematic soundtrack.

T2VA (no selected reference inputs): use only integrated_multimodal_description, overall_soundscape,
non_diegetic_music, in that order. Begin the first field with [Shot 1] and the style/composition.

SHOT WRITING: Use [Shot 1] without a timestamp. Prefer one continuous shot for a simple action.
Only add cuts when the story needs them; subsequent shots start [Shot 2] At 00:03.500, ... with
sequential shot numbers and strictly increasing cut times less than the target duration. A cut time
is local to this clip. Do not label time ranges as shots. Establish framing, viewing angle, visible
appearance and screen position, setting, lighting and prop state, then action, reaction and end state.
Write observable action rather than a plot synopsis or adjective list. Keep the default camera fixed
unless requested otherwise. If moving, identify the move and relevant direction/range/speed naturally;
do not confuse zooming with physically moving the camera. Give enough concrete detail for H3; for a
full-reference description aim around 350-500 English words when useful, with natural spoken timing
and the actual scene taking precedence over padding. Keep cuts/action count achievable in this clip.

SPEECH: Assign (S1), (S2), etc. in first-vocal-event order within the clip and retain them across its
shots. Reuse the same character names and vocal traits across clips. Silent characters get no speaker
ID. Put the speaker, performance and lip-sync instruction outside <d>; put only the language and exact
scripted words inside: Asha (S1) says softly: <d>[Hindi] नमस्ते।</d>. This is a syntax example, not new
dialogue to insert. Preserve the user's wording, punctuation, language and speaking order. Identify
off-screen voices; for requested voiceover use 'says in an off-screen voiceover' and keep the visible
character's lips closed. Never invent narration or dialogue. Split overlong dialogue at natural sentence
boundaries when planning clips rather than speeding up or dropping words. For speech crossing an
intentional internal cut, <scenetrans> can mark both sides and audio must continue; do not intentionally
truncate speech with <cutoff> unless requested. Quote actual visible text exactly; do not add subtitles.
Keep dialogue in the shot description, not repeated in the soundscape/music fields. Soundscape N/A
means explicitly requested complete silence, not merely absence of dialogue.

MEDIA AND CONTINUITY: Use ONLY subjectLabel values supplied for selected references; retain their
names and meanings. Never invent <Picture N>, <Audio N>, <Video N>, a Reference heading or file indices;
the host prepends the real Reference bindings at render time. The pipeline has images and voice
references, not source-video editing/reuse. The appended previous-frame attachment is context, not a
new numbered identity reference. When h3Prompting.frameGuide is true, begin from Opening Frame at
zero seconds, preserve observed pose/framing/lighting/prop state, then continue the next action without
replaying prior beats or lines. That frame is injected as a frame-zero guide, not a <Picture 1> asset.
When false, use any previous frame for story context only and honor the requested cut/time jump.
Do not invent first/last-frame modes, ending-frame constraints, or unseen events. Each clip's final
prompt must stand alone with its selected references and current starting state. Keep the requested
duration; do not change a saved take or generate another clip's final prompt before its real frame.
"""


def subject_labels(scene):
    return {ref["id"]: f"<Subject {index + 1}>" for index, ref in enumerate(scene["references"])
            if any(a["kind"] == "image" for a in ref.get("assets", []))}


def context(references, frame_guide=False):
    return {"version": VERSION, "mode": "ref2va" if references else "t2va", "frameGuide": bool(frame_guide),
            "promptFieldsByMode": {"ref2va": list(REF_FIELDS), "t2va": list(BASE_FIELDS)},
            "assetBinding": "Host assigns actual Picture/Audio indices in Reference; never guess them."}


def check_fields(names, expected):
    missing = [field for field in expected if field not in names]
    duplicate = [field for field in dict.fromkeys(names) if names.count(field) > 1]
    unexpected = [field for field in dict.fromkeys(names) if field not in expected]
    issues = [label + ": " + ", ".join(values) for label, values in
              (("missing", missing), ("duplicate", duplicate), ("unexpected", unexpected)) if values]
    if issues:
        raise ValueError("H3 sections: " + "; ".join(issues) + ". Required: " + ", ".join(expected))


def normalize(prompt, references, duration=None):
    """Assemble complete sections without inventing content or rewriting dialogue."""
    expected = REF_FIELDS if references else BASE_FIELDS
    if isinstance(prompt, dict):
        check_fields(list(prompt), expected)
        if any(not isinstance(value, str) for value in prompt.values()):
            raise ValueError("Each H3 section must contain a string")
        parts = prompt
    elif isinstance(prompt, str):
        prompt = prompt.strip()
        # Only remove a fence enclosing the entire prompt, never section content.
        fence = re.fullmatch(r"```(?:text|plaintext|markdown|yaml)?[ \t]*\r?\n(.*?)\r?\n```", prompt, re.S | re.I)
        if fence:
            prompt = fence[1]
        matches = list(FORMATTED_FIELDS.finditer(prompt))
        names = [re.sub(r"[ _-]+", "_", m["marked"] or m["plain"]).lower() for m in matches]
        check_fields(names, expected)
        if prompt[:matches[0].start()].strip():
            raise ValueError("Leave commentary out of the H3 prompt before the first section")
        parts = {name: prompt[m.end():matches[i + 1].start() if i + 1 < len(matches) else len(prompt)]
                 for i, (name, m) in enumerate(zip(names, matches))}
    else:
        raise ValueError("H3 prompt must be section text or an object of section strings")
    return validate("\n".join(field + ": " + parts[field].strip() for field in expected), references, duration)


def validate(prompt, references, duration=None):
    """Check structural promises, without claiming to assess a model's visual quality."""
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 12000:
        raise ValueError("H3 prompt must be nonempty and at most 12000 characters")
    if ASSET.search(prompt) or re.search(r"(?mi)^\s*Reference\s*:?\s*$", prompt):
        raise ValueError("Leave media indices and Reference to the host")
    matches = list(FIELDS.finditer(prompt))
    expected = REF_FIELDS if references else BASE_FIELDS
    check_fields([m.group(1) for m in matches], expected)
    if tuple(m.group(1) for m in matches) != expected or prompt[:matches[0].start()].strip():
        raise ValueError("Use H3 sections in this order: " + ", ".join(expected))
    parts = {m.group(1): prompt[m.end():matches[i + 1].start() if i + 1 < len(matches) else len(prompt)].strip() for i, m in enumerate(matches)}
    if any(not value for value in parts.values()):
        raise ValueError("Fill every H3 section; use N/A only where appropriate")
    allowed = {r.get("subjectLabel") for r in references if r.get("subjectLabel")}
    if any(match.group(0) not in allowed for match in SUBJECT.finditer(prompt)):
        raise ValueError("Use only the selected references' supplied Subject labels")
    if references and not allowed <= {m.group(0) for m in SUBJECT.finditer(parts["subject_definitions"])}:
        raise ValueError("Define every selected visual reference using its supplied Subject label")
    description = parts["detailed_description" if references else "integrated_multimodal_description"]
    shots = list(SHOT.finditer(description))
    if not shots or [int(m.group(1)) for m in shots] != list(range(1, len(shots) + 1)):
        raise ValueError("Start at [Shot 1] and number subsequent shots sequentially")
    previous = 0
    for i, shot in enumerate(shots):
        tail = description[shot.end():shots[i + 1].start() if i + 1 < len(shots) else len(description)]
        stamp = CUT.match(tail)
        if i == 0:
            if re.match(r"\s*At\s+\d", tail):
                raise ValueError("[Shot 1] must not have a timestamp")
            continue
        if stamp is None:
            raise ValueError("Each cut needs At MM:SS.mmm, immediately after its shot label")
        seconds = int(stamp[1]) * 60 + int(stamp[2]) + int(stamp[3]) / 1000
        if seconds <= previous or isinstance(duration, (int, float)) and seconds >= duration:
            raise ValueError("Shot cut times must increase and fall inside this clip's duration")
        previous = seconds
    if prompt.count("<d>") != prompt.count("</d>"):
        raise ValueError("Close every H3 dialogue tag")
    dialogue = re.findall(r"<d>(.*?)</d>", prompt, re.S)
    if any(not re.match(r"\[[^\]\n]+\]\s*\S", line) for line in dialogue):
        raise ValueError("Each dialogue block must start with [Language] and contain the exact spoken line")
    if prompt.count("<d>") != description.count("<d>"):
        raise ValueError("Keep dialogue in the shot description")
    last_end, seen_speakers = 0, []
    for line in re.finditer(r"<d>.*?</d>", description, re.S):
        speakers = re.findall(r"\((S\d+(?:,S\d+)*)\)", description[last_end:line.start()])
        if not speakers:
            raise ValueError("Identify the speaker with (S1), (S2), etc. before each dialogue block")
        for speaker in speakers[-1].split(","):
            if speaker not in seen_speakers:
                if speaker != f"S{len(seen_speakers) + 1}":
                    raise ValueError("Assign speaker IDs by their first vocal event, starting at S1")
                seen_speakers.append(speaker)
        last_end = line.end()
    return prompt
