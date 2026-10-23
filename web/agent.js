import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const prefix = "/ava-agent";
const active = new Set(["submitting", "submission-unknown", "queued", "rendering", "saving", "recoverable"]);
const $ = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "src" && /^(video|audio)$/.test(tag)) el.dataset.avaMediaSrc = value;
    else if (value !== undefined) el[key] = value;
  }
  el.append(...children.filter(Boolean));
  return el;
};
const field = (label, input) => {
  input.setAttribute("aria-label", label);
  return $("label", {}, $("span", { text: label }), input);
};
const input = (value = "", type = "text") => $("input", { value, type });
const area = (value = "", rows = 5) => $("textarea", { value, rows });
const select = (values, current) => $("select", {}, ...values.map(v => $("option", { value: typeof v === "string" ? v : v.id, text: typeof v === "string" ? v : v.name, selected: (typeof v === "string" ? v : v.id) === current })));
const row = (...children) => $("div", { class: "ava-row" }, ...children);
const card = (...children) => $("section", { class: "ava-card" }, ...children);
const note = text => $("p", { class: "ava-note", text });
const mediaUrl = asset => api.apiURL(`${prefix}/media?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(asset.path)}`);

let workspace, message, content, projectHost, navigation, livePanel, openButton, projectId = localStorage.getItem("ava-project") || "";
let state, scene, busy = false, dirty = false, modal, poller, refreshing = false, sidebarHost, diagnostics;
let renderedSnapshot = "", sceneReceivedAt = Date.now() / 1000;
let refreshDone = Promise.resolve();
const originalTitle = document.title;
let section = ["agent", "library", "settings"].includes(localStorage.getItem("ava-section")) ? localStorage.getItem("ava-section") : "agent";
const statusLabels = { submitting: "Submitting", "submission-unknown": "Check submission", queued: "In queue", rendering: "Rendering", saving: "Saving video", complete: "Complete", failed: "Failed", recoverable: "Needs recovery", "awaiting-approval": "Awaiting approval" };
const durationText = seconds => {
  if (!Number.isFinite(seconds)) return "—";
  seconds = Math.max(0, Math.floor(seconds));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
};
const timeText = stamp => stamp ? new Date(stamp * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
const eyebrow = text => $("p", { class: "ava-eyebrow", text });
const heading = (title, description) => $("div", { class: "ava-section-heading" }, $("h3", { text: title }), description && note(description));
const metric = (label, value) => $("div", {}, $("dt", { text: label }), $("dd", { text: value }));
// Live clocks update independently; they must not rebuild a playing video.
const snapshot = () => JSON.stringify([state, scene], (key, value) => key === "timing" ? undefined : value);

const mediaSource = node => node.dataset.avaMediaSrc || node.getAttribute("src");
const nodeKey = node => node.nodeType === Node.ELEMENT_NODE ? node.dataset.avaKey || node.id || (/^(VIDEO|AUDIO|IMG)$/.test(node.tagName) ? `${node.tagName}:${mediaSource(node)}` : null) : null;
function activateMedia(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  for (const media of [node, ...node.querySelectorAll("[data-ava-media-src]")]) {
    if (media.dataset.avaMediaSrc && media.getAttribute("src") !== media.dataset.avaMediaSrc) media.setAttribute("src", media.dataset.avaMediaSrc);
  }
}
function patchChildren(parent, desired) {
  const keyed = new Map([...parent.childNodes].map(node => [nodeKey(node), node]).filter(([key]) => key));
  const desiredKeys = new Set(desired.map(nodeKey).filter(Boolean));
  let cursor = parent.firstChild;
  for (const source of desired) {
    const key = nodeKey(source);
    let target = key ? keyed.get(key) : nodeKey(cursor || {}) ? null : cursor;
    if (!target || target.nodeType !== source.nodeType || target.nodeName !== source.nodeName) target = null;
    // Fresh controls retain callbacks bound to their newly created form inputs.
    if (target?.nodeType === Node.ELEMENT_NODE && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName)) target = null;
    if (!target) { parent.insertBefore(source, cursor); activateMedia(source); cursor = source.nextSibling; continue; }
    // Remove obsolete siblings before a keyed player rather than moving the player itself.
    if (key) while (cursor && cursor !== target && !desiredKeys.has(nodeKey(cursor))) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
    if (target !== cursor) parent.insertBefore(target, cursor);
    if (source.nodeType === Node.TEXT_NODE) {
      if (target.data !== source.data) target.data = source.data;
    } else if (source.nodeType === Node.ELEMENT_NODE) {
      // Never detach/reassign an unchanged media element: that restarts playback.
      const keepMedia = /^(VIDEO|AUDIO|IMG)$/.test(source.tagName) && mediaSource(target) === mediaSource(source);
      if (!keepMedia) {
        for (const name of target.getAttributeNames()) if (!source.hasAttribute(name)) target.removeAttribute(name);
        for (const name of source.getAttributeNames()) if (target.getAttribute(name) !== source.getAttribute(name)) target.setAttribute(name, source.getAttribute(name));
        patchChildren(target, [...source.childNodes]);
      }
    }
    cursor = target.nextSibling;
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}

function switchSection(value) {
  section = value; localStorage.setItem("ava-section", value);
  navigation.querySelectorAll("button").forEach(el => { const selected = el.dataset.section === value; el.setAttribute("aria-selected", String(selected)); el.tabIndex = selected ? 0 : -1; });
  content.querySelectorAll("[role=tabpanel]").forEach(el => { el.hidden = el.id !== `ava-panel-${value}`; });
}

function statusPanel(clip, compact = false) {
  const panel = $("section", { class: compact ? "ava-take-status" : "ava-live-status", ariaLabel: compact ? "Clip render status" : "Current render status" });
  panel.dataset.clipId = clip.id;
  panel.dataset.compact = String(compact);
  panel.dataset.avaKey = `status:${clip.id}:${compact}`;
  fillStatus(panel, clip);
  return panel;
}

function fillStatus(panel, clip) {
  const clock = clip.timing || {}, now = Date.now() / 1000;
  const drift = Math.max(0, now - sceneReceivedAt);
  const terminal = ["complete", "failed"].includes(clip.status);
  const elapsed = Number.isFinite(clock.elapsedSeconds) ? clock.elapsedSeconds + (terminal ? 0 : drift) : null;
  const remaining = Number.isFinite(clock.remainingSeconds) ? Math.max(0, clock.remainingSeconds - drift) : null;
  const sampling = clock.sampling;
  const compact = panel.dataset.compact === "true";
  let eta = "Waiting for sampling";
  if (["recoverable", "submission-unknown"].includes(clip.status) || scene?.paused && active.has(clip.status)) eta = "Monitoring paused";
  else if (clip.status === "queued") eta = "Waiting for GPU";
  else if (clip.status === "complete") eta = "Finished";
  else if (clip.status === "failed") eta = "Stopped";
  else if (!active.has(clip.status)) eta = "After approval";
  else if (clip.status === "saving" || sampling?.value >= sampling?.total) eta = "Sampling finished";
  else if (clock.etaKind === "sampling" && remaining > 0) eta = `~${durationText(remaining)} remaining`;
  else if (clip.status === "rendering" && sampling?.total > 1) eta = "Measuring sampling rate…";
  if (!panel.statusUI) {
    const badge = $("span"), title = compact ? null : $("h3");
    const progress = $("progress", { max: 100, ariaLabel: "Sampling progress" }), label = $("span");
    const elapsedMetric = metric("Elapsed", ""), etaMetric = metric("Sampling ETA", ""), stampMetric = metric("Started at", "");
    panel.replaceChildren(row(compact ? null : $("div", {}, eyebrow("RENDER MONITOR"), title), badge),
      $("div", { class: "ava-progress" }, progress, label), $("dl", { class: "ava-metrics" }, elapsedMetric, etaMetric, stampMetric),
      !compact && note("ETA covers sampling steps only. Decoding, saving and final-frame extraction follow."));
    panel.statusUI = { badge, title, progress, label, elapsed: elapsedMetric.lastChild, eta: etaMetric.lastChild,
      stampLabel: stampMetric.firstChild, stamp: stampMetric.lastChild };
  }
  const ui = panel.statusUI;
  const setText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
  if (ui.badge.className !== `ava-badge ava-status-${clip.status}`) ui.badge.className = `ava-badge ava-status-${clip.status}`;
  setText(ui.badge, statusLabels[clip.status] || clip.status);
  setText(ui.title, clip.title);
  let progressLabel = "Waiting for approval";
  let progressValue = null;
  if (clip.status === "complete") { progressValue = 100; progressLabel = "Video saved and ready to play"; }
  else if (clip.status === "rendering" && sampling?.total > 1) { progressValue = sampling.value / sampling.total * 100; progressLabel = `Sampling · ${sampling.value} / ${sampling.total} steps${sampling.value >= sampling.total ? " · decoding video" : ""}`; }
  else if (clip.status === "queued") progressLabel = clock.queuePosition ? `Queue position ${clock.queuePosition}` : "Waiting in the ComfyUI queue";
  else if (clip.status === "saving") progressLabel = "Verifying video & extracting the final frame";
  else if (clip.status === "rendering") progressLabel = "Loading models / preparing references";
  else if (clip.status === "failed" || clip.status === "recoverable") progressLabel = "Open the clip below for details";
  if (!active.has(clip.status) && clip.status !== "complete") progressValue = 0;
  if (progressValue === null) { if (ui.progress.hasAttribute("value")) ui.progress.removeAttribute("value"); }
  else if (!ui.progress.hasAttribute("value") || ui.progress.value !== progressValue) ui.progress.value = progressValue;
  setText(ui.label, progressLabel);
  setText(ui.elapsed, durationText(elapsed));
  setText(ui.eta, eta);
  setText(ui.stampLabel, clip.status === "failed" ? "Failed at" : terminal ? "Completed at" : "Started at");
  setText(ui.stamp, timeText(clip.status === "failed" ? clock.failedAt : terminal ? clock.completedAt : clock.renderStartedAt));
}

function updateStatus() {
  if (!scene?.clips.length) { livePanel.replaceChildren(); return; }
  const lastActivity = clip => Math.max(clip.timing?.completedAt || 0, clip.timing?.failedAt || 0, clip.timing?.submittedAt || 0);
  const current = scene.clips.find(c => active.has(c.status)) || [...scene.clips].sort((a, b) => lastActivity(b) - lastActivity(a))[0];
  let panel = livePanel.firstElementChild;
  if (!panel || panel.dataset.clipId !== current.id) livePanel.replaceChildren(statusPanel(current));
  else fillStatus(panel, current);
  content.querySelectorAll(".ava-take-status").forEach(el => { const clip = scene.clips.find(c => c.id === el.dataset.clipId); if (clip) fillStatus(el, clip); });
}

async function readResponse(response) {
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); }
  catch {
    const detail = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
    throw Object.assign(new Error(`ComfyUI request failed (HTTP ${response.status}). ${detail || "The server returned an empty or non-JSON response."}`), { status: response.status });
  }
  if (!response.ok) {
    const detail = typeof data?.error === "string" ? data.error : `ComfyUI returned HTTP ${response.status}.`;
    throw Object.assign(new Error(detail), { status: response.status });
  }
  return data;
}

async function request(path, body) {
  try {
    const response = await api.fetchApi(prefix + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    return await readResponse(response);
  } catch (error) {
    if (!Number.isInteger(error.status)) error.transportFailure = true;
    throw error;
  }
}
function button(label, work, className = "", available = true) {
  const control = $("button", { text: label, class: className, disabled: busy || !available, onclick: () => run(work) });
  control.dataset.unavailable = String(!available);
  return control;
}
async function run(work) {
  if (busy) return;
  busy = true;
  workspace.setAttribute("aria-busy", "true");
  content.inert = true;
  projectHost.inert = true;
  message.textContent = "Working…";
  message.classList.remove("ava-error");
  workspace.querySelectorAll("button").forEach(b => { b.disabled = true; });
  try { if (await work() === false) { message.textContent = "Cancelled"; return; } dirty = false; message.textContent = "Saved"; await refresh(true); }
  catch (error) { message.textContent = error.message; message.classList.add("ava-error"); }
  finally { busy = false; content.inert = false; projectHost.inert = false; workspace.setAttribute("aria-busy", "false"); workspace.querySelectorAll("button").forEach(b => { b.disabled = b.dataset.unavailable === "true"; }); }
}
async function action(command, values = {}) {
  return request("/action", { action: command, projectId, ...values });
}
async function chooseProject(id) {
  await refreshDone;
  projectId = id; scene = null; diagnostics = null;
  localStorage.setItem("ava-project", id);
  if (!id) switchSection("agent");
}
const scopeQuery = () => new URLSearchParams({ projectId }).toString();

async function refresh(force = false) {
  if (refreshing) { await refreshDone; if (force) return refresh(true); return; }
  refreshing = true;
  let finish; refreshDone = new Promise(resolve => { finish = resolve; });
  try {
    state = await request(`/state${projectId ? `?${scopeQuery()}` : ""}`);
    if (projectId && !state.projects.some(p => p.id === projectId)) { projectId = ""; diagnostics = null; localStorage.removeItem("ava-project"); }
    scene = state.workspace;
    sceneReceivedAt = Date.now() / 1000;
    if (message.textContent === "Loading…") message.textContent = "Ready";
    const running = scene?.clips.find(c => active.has(c.status));
    document.title = running ? `${running.status} · ${running.title} · ComfyUI` : scene?.clips.length && scene.clips.every(c => c.status === "complete") ? "Video complete · ComfyUI" : originalTitle;
    updateStatus();
    // Preserve unsaved prompt, script, selection and comments during background checks.
    if (force || (snapshot() !== renderedSnapshot && !dirty && !busy && !workspace.contains(document.activeElement?.closest("input,textarea,select")))) render();
  } finally { refreshing = false; finish(); }
}

function connection() {
  const result = $("pre", { class: "ava-diagnostics", text: diagnostics || "Check the pod's models, nodes and media tools." });
  return card(heading("RunPod setup", "FastH3 renders inside ComfyUI."),
    button("Check installation", async () => { diagnostics = JSON.stringify(await request(`/health?projectId=${encodeURIComponent(projectId)}`), null, 2); result.textContent = diagnostics; }), result,
    note(`Storage on pod: ${state.storage}. Use a RunPod persistent volume.`));
}

function projectControls() {
  const projects = select([{ id: "", name: "Select project" }, ...state.projects], projectId);
  projects.onchange = () => run(() => chooseProject(projects.value));
  return card(eyebrow("PROJECT"), row(field("Project", projects), button("Create new project", async () => {
    const name = prompt("New project name", `Project ${state.projects.length + 1}`);
    if (name === null) return false;
    const result = await action("createProject", { name }); await chooseProject(result.project.id); switchSection("agent");
  })));
}

function manageSelection() {
  const project = state.project, name = input(project.name);
  return card(heading("Project settings", "References and videos belong to this project."),
    field("Project name", name), row(button("Rename project", () => action("renameProject", { name: name.value })),
      button("Delete project…", async () => {
        if (!confirm(`Delete “${project.name}” and its clips? Saved data goes to recovery trash.`)) return false;
        await action("deleteProject"); await chooseProject("");
      }, "ava-danger")));
}

async function uploadFile(file, values = {}) {
  const form = new FormData(); form.append("file", file);
  const query = new URLSearchParams({ projectId, ...values });
  const response = await api.fetchApi(`${prefix}/upload?${query}`, { method: "POST", body: form });
  await readResponse(response);
}

function uploadControl(values, label = "Add images / voices") {
  const file = $("input", { type: "file", multiple: !values.clipId, accept: values.clipId ? "image/png,image/jpeg,image/webp" : ".png,.jpg,.jpeg,.webp,.wav,.mp3,.m4a,.ogg,.flac" });
  return $("div", {}, field(label, file), button("Upload selected files", async () => {
    if (!file.files.length) throw new Error("Choose files first");
    for (const item of file.files) await uploadFile(item, values);
  }));
}

function assets(ref) {
  return $("div", { class: "ava-assets" }, ...ref.assets.map(asset => card(
    asset.kind === "image" ? $("img", { src: mediaUrl(asset), alt: ref.name, loading: "lazy" }) : $("audio", { src: mediaUrl(asset), controls: true, preload: "none" }),
    note(asset.name + (asset.duration ? ` · ${asset.duration.toFixed(2)}s` : ""))
  )));
}

function library() {
  const project = state.project;
  if (!project) return null;
  const refs = project.library;
  const name = input(), kind = select(["character", "location", "prop"], "character"), description = area("", 2);
  const groups = [{ kind: "character", title: "Characters" }, { kind: "location", title: "Locations" }, { kind: "prop", title: "Props" }];
  return $("div", {}, heading("Reference library", `${refs.length} entries · isolated to ${project.name}`),
    $("details", { open: !refs.length }, $("summary", { text: "Create a library entry" }), card(
      field("Name", name), field("Kind", kind), field("Description", description),
      button("Create library entry", () => action("createLibrary", { name: name.value, kind: kind.value, description: description.value })))),
    ...groups.map(group => $("section", {}, heading(group.title, `${refs.filter(ref => ref.kind === group.kind).length} library items`),
      $("div", { class: "ava-library-grid" }, ...refs.filter(ref => ref.kind === group.kind).map(ref => card($("h4", { text: ref.name }), note(ref.description), assets(ref), uploadControl({ referenceId: ref.id }),
        row(button("Clone", () => action("cloneLibrary", { referenceId: ref.id })),
          button("Remove library entry", async () => { if (confirm(`Remove ${ref.name} from the library?`)) await action("removeLibrary", { referenceId: ref.id }); }))))))),
    savedVideos());
}

function savedVideos() {
  const takes = state.videos;
  return $("div", {}, heading("Saved videos", `${takes.length} saved take${takes.length === 1 ? "" : "s"} in this project`),
    takes.length ? $("div", { class: "ava-library-grid" }, ...takes.map(take => card($("h4", { text: take.title }),
      note(`${take.sceneName || "Clip"} · ${take.actualDuration || take.duration}s`), $("video", { src: mediaUrl(take.video), controls: true, preload: "none" }),
      note(`Completed at: ${timeText(take.timing?.completedAt)}`), $("a", { href: mediaUrl(take.video), download: take.video.name || `${take.id}.mp4`, text: "Download video" })))) : card(note("Your finished clips and previous takes will appear here.")));
}

function sceneDraft() {
  const value = (id, fallback) => content.querySelector(`#ava-${id}`)?.value ?? fallback;
  return { settings: {
    provider: "h3", aspectRatio: value("ratio", scene.settings.aspectRatio), megapixels: Number(value("mp", scene.settings.megapixels)),
    steps: Number(value("steps", scene.settings.steps)), seed: Number(value("seed", scene.settings.seed)), refImageSize: value("quality", scene.settings.refImageSize) } };
}

function generationSettings() {
  const opts = scene.settings;
  const ratio = select(["16:9", "9:16", "1:1"], opts.aspectRatio), mp = input(opts.megapixels, "number"), steps = input(opts.steps, "number"), seed = input(opts.seed, "number");
  mp.min = 0.25; mp.max = 4; mp.step = 0.25; steps.min = 1; steps.max = 100;
  const quality = select(["match", "max"], opts.refImageSize);
  for (const [id, el] of Object.entries({ ratio, mp, steps, seed, quality })) el.id = `ava-${id}`;
  return card(heading("Render settings", `FastH3 · ${scene.name}`),
    note("Applies to the next approved take. Saved takes keep their original settings."),
    row(field("Aspect ratio", ratio), field("H3 megapixels", mp), field("H3 steps", steps)),
    row(field("Seed (-1 = random)", seed), field("H3 reference size", quality)),
    button("Save render settings", () => action("saveSettings", sceneDraft()), "ava-primary"));
}

function planImporter() {
  const json = area("", 12);
  json.placeholder = '{"version":1,"scene":"Scene name","clips":[{"title":"Opening","duration":5,"references":[{"tag":"Image 1","name":"Mara","type":"character"}],"use_last_frame":false,"prompt":"Image 1: Mara (character)\\n\\nA moving camera follows Mara..."}]}';
  let requestId;
  json.addEventListener("input", () => { requestId = null; });
  return card(eyebrow("01 / IMPORT"), heading("Import a scene from ChatGPT", "Give ChatGPT the scene and planning skill. Import its clip JSON, then fill each reference slot from this project's library."),
    $("a", { href: api.apiURL(`${prefix}/scene-planning-skill`), download: "comfyui-scene-planner.md", text: "Download ChatGPT scene-planning skill" }),
    field("Scene JSON", json),
    note("ChatGPT identifies required character, location and prop references without seeing your library. Imports append clips and retain saved takes."),
    button("Import clips", async () => {
      const plan = JSON.parse(json.value);
      requestId ||= globalThis.crypto?.randomUUID?.() || `import_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await action("importPlan", { plan, requestId });
    }, "ava-primary"));
}

function downloadJSON(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = $("a", { href: url, download: filename }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clipEditor(clip, index) {
  const prompt = area(clip.prompt, 10), length = input(clip.nextDuration ?? clip.duration, "number");
  length.min = 2; length.max = 15; length.step = 0.5;
  const continuity = $("input", { type: "checkbox", checked: clip.continuityMode === "on" || clip.continuityMode === "auto" && clip.transition === "continue" });
  const hasSlots = Array.isArray(clip.referenceSlots);
  const checks = hasSlots ? [] : scene.references.filter(r => r.assets.length).map(ref => ({ ref, box: $("input", { type: "checkbox", checked: clip.referenceIds.includes(ref.id) }) }));
  const slots = (clip.referenceSlots || []).map(slot => {
    const mediaKind = slot.tag.startsWith("Image") ? "image" : "audio";
    const candidates = state.project.library.filter(ref => ref.kind === slot.type && ref.assets.some(asset => asset.kind === mediaKind));
    const librarySelect = select([{ id: "", name: `Select ${slot.type} library item` }, ...candidates], slot.referenceId || "");
    const assetSelect = $("select");
    function updateAssets(changed = false) {
      const ref = candidates.find(item => item.id === librarySelect.value);
      const files = ref?.assets.filter(asset => asset.kind === mediaKind) || [];
      const current = files.length === 1 ? files[0].path : !changed && files.some(asset => asset.path === slot.assetPath) ? slot.assetPath : "";
      assetSelect.replaceChildren(...[{ path: "", name: `Select ${mediaKind} file` }, ...files].map(asset => $("option", { value: asset.path, text: asset.name, selected: asset.path === current })));
    }
    librarySelect.addEventListener("change", () => updateAssets(true));
    updateAssets();
    const view = card($("h4", { text: `${slot.tag} · ${slot.name}` }), note(`Required type: ${slot.type} · ${mediaKind} file`),
      field("Library item", librarySelect), field("File", assetSelect),
      !candidates.length && note(`No ${slot.type} item with an ${mediaKind} file is in this project yet. Add one in Library.`));
    view.classList.add("ava-slot");
    return { slot, librarySelect, assetSelect, view };
  });
  const draft = () => ({ clipId: clip.id, prompt: prompt.value,
    ...(hasSlots ? { referenceSlots: slots.map(({ slot, librarySelect, assetSelect }) => ({ tag: slot.tag, referenceId: librarySelect.value, assetPath: assetSelect.value })) }
      : { referenceIds: checks.filter(c => c.box.checked).map(c => c.ref.id) }),
    use_last_frame: continuity.checked, duration: Number(length.value) });
  async function save() {
    await action("saveClip", draft());
  }
  const frameControls = clip.frame && $("details", {}, $("summary", { text: "Saved last frame" }), $("img", { src: mediaUrl(clip.frame), alt: "Extracted last frame", loading: "lazy" }));
  const keys = $("details", {}, $("summary", { text: "Canvas node IDs / review key" }),
    $("pre", { text: JSON.stringify({ project_id: projectId, clip_id: clip.id, review_key: clip.reviewKey }, null, 2) }));
  const editor = card(eyebrow(`CLIP ${String(index + 1).padStart(2, "0")} / ${String(scene.clips.length).padStart(2, "0")}`), $("h3", { text: `${index + 1}. ${clip.title}` }), statusPanel(clip, true), note(`${clip.transition} · ${clip.actualDuration ? `${clip.actualDuration.toFixed(2)}s saved` : `${clip.duration}s planned`}`),
    clip.continuityOutdated && note("An earlier take or frame changed. This completed take is retained; review continuity before regenerating."),
    clip.error && $("p", { class: "ava-error", text: clip.error }),
    clip.video && $("video", { src: mediaUrl(clip.video), controls: true, preload: "metadata" }),
    clip.sceneName && note(clip.sceneName), field("Editable H3 prompt", prompt),
    hasSlots ? $("div", {}, heading("Reference slots", "Choose a matching library item and one file for every slot. H3 receives files in tag order."),
      ...slots.map(({ view }) => view), !slots.length && note("This clip needs no reference files."))
      : $("div", { class: "ava-checks" }, ...checks.map(({ ref, box }) => $("label", {}, box, document.createTextNode(ref.name)))),
    field("Use previous clip's last frame", continuity),
    clip.previousFrame ? card(note(`Opening frame from: ${clip.previousFrame.name}`), $("img", { src: mediaUrl(clip.previousFrame.assets[0]), alt: "Previous clip's last frame", loading: "lazy" })) : continuity.checked && note("Complete the preceding clip before reviewing this continuation."),
    field(clip.takeId ? "Duration for next take" : "Duration", length),
    clip.nextDuration !== undefined && note(`The saved take keeps ${clip.duration}s. Next take: ${clip.nextDuration}s.`),
    button("Save prompt & references", save),
    button(clip.takeId ? "Approve prompt & regenerate this clip" : "Approve prompt & generate this clip", async () => {
      const result = await action("saveClip", draft());
      const saved = result.workspace.clips.find(c => c.id === clip.id);
      if (!saved.reviewKey || saved.reviewKey !== clip.reviewKey) {
        dirty = false; await refresh(true);
        throw new Error("Draft or preceding clip's last frame changed. Review the saved clip and selected frame, then approve again.");
      }
      await action("approveGenerate", { clipId: clip.id, reviewKey: saved.reviewKey });
    }, "ava-primary", !active.has(clip.status)),
    active.has(clip.status) && row(button("Pause monitoring", () => action("pause")), button("Resume existing job / saving", () => action("resume", { clipId: clip.id }))),
    active.has(clip.status) && $("details", {}, $("summary", { text: "Recover an existing job" }), (() => {
      const job = input(clip.jobId || "");
      return $("div", {}, field("ComfyUI prompt ID", job), button("Recover & monitor this job", () => action("recover", { clipId: clip.id, jobId: job.value })),
        button("I checked the queue: release missing job…", async () => {
          if (confirm("Confirm you checked the ComfyUI queue and this old job cannot produce another result. Releasing it allows an explicit new GPU render."))
            await action("acknowledgeMissingJob", { clipId: clip.id, confirmed: true });
        }));
    })()), frameControls,
    clip.versions?.length && $("details", {}, $("summary", { text: `Previous takes (${clip.versions.length})` }), ...clip.versions.map(v => card(note(`${v.status} · ${v.actualDuration || v.duration}s · ${v.takeId}`), note(`Completed at: ${timeText(v.timing?.completedAt)}`), v.video && $("video", { src: mediaUrl(v.video), controls: true, preload: "none" }), note(v.submittedPrompt || v.prompt)))), keys,
    button("Export this clip's H3 API graph", async () => {
      const result = await action("exportGraph", { clipId: clip.id });
      downloadJSON(result.graph, `${state.project.name}-${clip.id}-api.json`);
    }));
  editor.classList.add("ava-clip");
  editor.dataset.avaKey = `clip:${scene.id}:${clip.id}`;
  return editor;
}

function render() {
  if (!state.project) section = "agent";
  const detailsState = new Map([...workspace.querySelectorAll("details")].map((el, i) => [`${i}:${el.querySelector("summary")?.textContent}`, el.open]));
  const agent = $("section", { id: "ava-panel-agent", role: "tabpanel", ariaLabel: "Agent" },
    ...(scene ? [planImporter(), scene.clips.length && heading("Review & render", `${scene.clips.filter(c => c.status === "complete").length} of ${scene.clips.length} clips complete · approve each take when ready`), ...scene.clips.map(clipEditor)].filter(Boolean) : [card(heading("Your next video starts here", "Create a project above, then import your scene JSON from ChatGPT."))]));
  const libraryPanel = $("section", { id: "ava-panel-library", role: "tabpanel", ariaLabel: "Library" }, projectId ? library() : card(note("Create a project to build its reference library.")));
  const settingsPanel = $("section", { id: "ava-panel-settings", role: "tabpanel", ariaLabel: "Settings" }, ...(state.project ? [manageSelection(), connection()] : []), ...(scene ? [generationSettings()] : []),
    card(heading("Render timing", "Sampling ETA and actual take timestamps."), note("ETA covers only measured sampling steps. It is unavailable until a sampling rate can be measured, and stops when sampling finishes. Decoding and saving have no ETA. Elapsed time includes queue waiting; completion is recorded after video verification and final-frame extraction. Times use your browser's local timezone.")));
  patchChildren(projectHost, [projectControls()]);
  navigation.hidden = !state.project;
  patchChildren(content, [agent, libraryPanel, settingsPanel]);
  switchSection(section);
  [...workspace.querySelectorAll("details")].forEach((el, i) => { const key = `${i}:${el.querySelector("summary")?.textContent}`; if (detailsState.has(key)) el.open = detailsState.get(key); });
  renderedSnapshot = snapshot();
  updateStatus();
}

function mount() {
  if (workspace) return;
  const style = $("link", { rel: "stylesheet", href: new URL("./agent.css", import.meta.url).href });
  document.head.append(style);
  message = $("p", { role: "status", text: "Loading…" });
  content = $("main");
  projectHost = $("div", { class: "ava-project-scope" });
  openButton = $("button", { text: "Open workspace", onclick: openModal });
  navigation = $("nav", { class: "ava-tabs", role: "tablist", ariaLabel: "Workspace sections" },
    ...["agent", "library", "settings"].map((id, index) => {
      const tab = $("button", { role: "tab", id: `ava-tab-${id}`, text: id[0].toUpperCase() + id.slice(1), onclick: () => switchSection(id),
        onkeydown: event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const tabs = [...navigation.children]; const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3; switchSection(tabs[next].dataset.section); tabs[next].focus(); } } });
      tab.dataset.section = id; tab.setAttribute("aria-controls", `ava-panel-${id}`); return tab;
    }));
  navigation.hidden = true;
  livePanel = $("div", { class: "ava-monitor" });
  workspace = $("div", { class: "ava-workspace" }, $("header", { class: "ava-header" },
    $("div", { class: "ava-brand" }, $("span", { class: "ava-mark", text: "a", ariaHidden: "true" }), $("div", {}, $("h2", { text: "AI Video Agent" }), $("span", { class: "ava-subtitle", text: "ChatGPT prompts. FastH3 creates." }))), row(
    button("Refresh", () => refresh(true)), openButton)), projectHost, navigation, message, livePanel, content,
    $("footer", { text: "CHATGPT + FASTH3 / YOUR COMFYUI WORKSPACE" }));
  workspace.addEventListener("input", () => { dirty = true; });
  workspace.addEventListener("change", event => { if (event.target.tagName !== "SELECT" || event.target.closest("main")) dirty = true; });
  poller = setInterval(() => { if (!busy) refresh().catch(error => { message.textContent = error.message; }); }, 5000);
  setInterval(updateStatus, 1000);
  refresh(true).catch(error => { message.textContent = error.message; });
}

function openModal() {
  mount();
  if (modal?.open) return;
  if (!modal) {
    modal = $("dialog", { class: "ava-dialog" });
    const close = $("button", { text: "Close workspace", onclick: () => modal.close() });
    modal.addEventListener("close", () => { openButton.hidden = false; if (sidebarHost) sidebarHost.append(workspace); });
    modal.append(close); document.body.append(modal);
  }
  modal.append(workspace);
  openButton.hidden = true;
  if (!modal.open) modal.showModal();
}

app.registerExtension({
  name: "AI.Video.Agent",
  setup() {
    mount();
    app.extensionManager.registerSidebarTab({ id: "ai-video-agent", icon: "pi pi-video", title: "AI Video Agent", tooltip: "Import scene JSON & review video generation", type: "custom", render(el) { sidebarHost = el; if (!modal?.open) el.append(workspace); } });
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!["AVAShowText", "AVAQueueReviewedClip"].includes(nodeData.name)) return;
    const original = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (data) {
      original?.apply(this, arguments);
      let widget = this.widgets?.find(w => w.name === "result");
      if (!widget) widget = this.addWidget("text", "result", "", () => {}, { multiline: true });
      widget.value = (data.text || []).join("\n");
      this.setDirtyCanvas(true, true);
    };
  }
});
