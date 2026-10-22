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
const mediaUrl = asset => api.apiURL(`${prefix}/media?path=${encodeURIComponent(asset.path)}`);

let workspace, message, content, projectHost, navigation, livePanel, openButton, projectId = localStorage.getItem("ava-project") || "", sceneId = localStorage.getItem("ava-scene") || "", episodeId = localStorage.getItem("ava-episode") || "";
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
const snapshot = () => JSON.stringify([state, scene], (key, value) => ["serverNow", "elapsedSeconds", "remainingSeconds", "estimatedCompletionAt", "etaKind"].includes(key) ? undefined : value);

function switchSection(value) {
  section = value; localStorage.setItem("ava-section", value);
  navigation.querySelectorAll("button").forEach(el => { const selected = el.dataset.section === value; el.setAttribute("aria-selected", String(selected)); el.tabIndex = selected ? 0 : -1; });
  content.querySelectorAll("[role=tabpanel]").forEach(el => { el.hidden = el.id !== `ava-panel-${value}`; });
}

function statusPanel(clip, compact = false) {
  const panel = $("section", { class: compact ? "ava-take-status" : "ava-live-status", ariaLabel: compact ? "Clip render status" : "Current render status" });
  panel.dataset.clipId = clip.id;
  panel.dataset.compact = String(compact);
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
  let eta = "Learning from first render", finish = "Not available yet";
  if (["recoverable", "submission-unknown"].includes(clip.status) || scene?.paused && active.has(clip.status)) { eta = "Monitoring paused"; finish = "Resume monitoring"; }
  else if (clip.status === "queued") { eta = "Waiting for GPU"; finish = "After queue starts"; }
  else if (clip.status === "complete") { eta = "Finished"; finish = timeText(clock.completedAt) === "—" ? "Not recorded for this older take" : timeText(clock.completedAt); }
  else if (clip.status === "failed") { eta = "Stopped"; finish = timeText(clock.failedAt); }
  else if (!active.has(clip.status)) { eta = "After approval"; finish = "Not started"; }
  else if (clock.etaKind === "history" && remaining > 0) { eta = `~${durationText(remaining)} remaining`; finish = timeText(clock.estimatedCompletionAt); }
  else if (clock.etaKind === "sampling" && remaining > 0) { eta = `Sampling: ~${durationText(remaining)} left`; finish = "Decode & saving follow"; }
  else if (clock.etaKind === "overdue" || remaining === 0) { eta = "Taking longer than estimated"; finish = "Updating estimate…"; }
  const badge = $("span", { class: `ava-badge ava-status-${clip.status}`, text: statusLabels[clip.status] || clip.status });
  const title = compact ? null : $("div", {}, eyebrow("RENDER MONITOR"), $("h3", { text: clip.title }));
  const progress = $("progress", { max: 100, ariaLabel: "Sampling progress" });
  let progressLabel = "Waiting for approval";
  if (clip.status === "complete") { progress.value = 100; progressLabel = "Video saved and ready to play"; }
  else if (clip.status === "rendering" && sampling?.total > 1) { progress.value = sampling.value / sampling.total * 100; progressLabel = `Sampling · ${sampling.value} / ${sampling.total} steps${sampling.value >= sampling.total ? " · decoding video" : ""}`; }
  else if (clip.status === "queued") progressLabel = clock.queuePosition ? `Queue position ${clock.queuePosition}` : "Waiting in the ComfyUI queue";
  else if (clip.status === "saving") progressLabel = "Verifying video & extracting the final frame";
  else if (clip.status === "rendering") progressLabel = "Loading models / preparing references";
  else if (clip.status === "failed" || clip.status === "recoverable") progressLabel = "Open the clip below for details";
  if (!active.has(clip.status) && clip.status !== "complete") progress.value = 0;
  panel.replaceChildren(row(title, badge),
    $("div", { class: "ava-progress" }, progress, $("span", { text: progressLabel })),
    $("dl", { class: "ava-metrics" }, metric("Elapsed", durationText(elapsed)), metric("ETA", eta), metric(clip.status === "failed" ? "Failed at" : terminal ? "Completed at" : "Estimated finish", finish)),
    !compact && note(clock.etaKind === "history" ? `Estimate based on ${clock.estimateSamples} comparable completed take${clock.estimateSamples === 1 ? "" : "s"}. Times shown in your local timezone.` : "Finish estimates learn from matching duration and render settings. Sampler progress covers sampling only."));
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
    throw new Error(`ComfyUI request failed (HTTP ${response.status}). ${detail || "The server returned an empty or non-JSON response."}`);
  }
  if (!response.ok) {
    const detail = typeof data?.error === "string" ? data.error : `ComfyUI returned HTTP ${response.status}.`;
    throw new Error(detail);
  }
  return data;
}

async function request(path, body) {
  const response = await api.fetchApi(prefix + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  return readResponse(response);
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
  return request("/action", { action: command, projectId, episodeId, sceneId, ...values });
}
function savedScope(id) {
  try { const saved = JSON.parse(localStorage.getItem(`ava-scope-${id}`) || "{}"); return { episodeId: saved.episodeId || "", scenes: saved.scenes || {} }; }
  catch { return { episodeId: "", scenes: {} }; }
}
function remember() {
  localStorage.setItem("ava-project", projectId);
  localStorage.setItem("ava-episode", episodeId);
  localStorage.setItem("ava-scene", sceneId);
  if (projectId) {
    const saved = savedScope(projectId); saved.episodeId = episodeId; if (episodeId) saved.scenes[episodeId] = sceneId;
    localStorage.setItem(`ava-scope-${projectId}`, JSON.stringify(saved));
  }
}
async function chooseProject(id) {
  await refreshDone; remember(); projectId = id;
  const saved = savedScope(id); episodeId = saved.episodeId; sceneId = saved.scenes[episodeId] || "";
  scene = null; diagnostics = null; remember();
  if (!id) switchSection("agent");
}
async function chooseEpisode(id) {
  await refreshDone; remember(); episodeId = id; sceneId = savedScope(projectId).scenes[id] || ""; scene = null; remember();
}
async function chooseScene(id) { sceneId = id; remember(); }
const scopeQuery = () => new URLSearchParams({ projectId, ...(episodeId ? { episodeId } : {}) }).toString();

async function refresh(force = false) {
  if (refreshing) { await refreshDone; if (force) return refresh(true); return; }
  refreshing = true;
  let finish; refreshDone = new Promise(resolve => { finish = resolve; });
  try {
    state = await request(`/state${projectId ? `?${scopeQuery()}` : ""}`);
    if (projectId && !state.projects.some(p => p.id === projectId)) { projectId = ""; episodeId = ""; sceneId = ""; diagnostics = null; remember(); }
    episodeId = state.selectedEpisodeId || "";
    if (!state.scenes.some(s => s.id === sceneId)) sceneId = state.scenes[0]?.id || "";
    if (sceneId) scene = await request(`/scene?${scopeQuery()}&sceneId=${encodeURIComponent(sceneId)}`);
    else scene = null;
    sceneReceivedAt = Date.now() / 1000;
    remember();
    if (message.textContent === "Loading…") message.textContent = "Ready";
    const running = scene?.clips.find(c => active.has(c.status));
    document.title = running ? `${running.status} · ${running.title} · ComfyUI` : scene?.clips.length && scene.clips.every(c => c.status === "complete") ? "Video complete · ComfyUI" : originalTitle;
    updateStatus();
    // Preserve unsaved prompt, script, selection and comments during background checks.
    if (force || (snapshot() !== renderedSnapshot && !dirty && !busy && !workspace.contains(document.activeElement?.closest("input,textarea,select")))) render();
  } finally { refreshing = false; finish(); }
}

function connection() {
  const conf = state.qwen;
  const model = input(conf.model);
  const result = $("pre", { class: "ava-diagnostics", text: diagnostics || "Check the pod's models, nodes, media tools and Qwen connection." });
  return card(heading("Qwen & RunPod setup", "Your planning model and pod connection."),
    note(`Planner selection is saved for ${state.project.name}. All episodes use this project's Qwen model and reference library.`),
    field("Qwen planner model filename", model),
    button("Save Qwen model", () => action("qwenConfig", { config: { model: model.value } })),
    button("Check installation", async () => { diagnostics = JSON.stringify(await request(`/health?projectId=${encodeURIComponent(projectId)}`), null, 2); result.textContent = diagnostics; }), result,
    note(`Storage on pod: ${state.storage}. Use a RunPod persistent volume.`)
  );
}

function projectControls() {
  const project = state.project;
  const projects = select([{ id: "", name: "Select project" }, ...state.projects], projectId);
  projects.onchange = () => run(() => chooseProject(projects.value));
  const scenes = select([{ id: "", name: "Select scene" }, ...state.scenes.map(s => ({ id: s.id, name: s.name }))], sceneId);
  scenes.onchange = () => run(() => chooseScene(scenes.value));
  const episodes = select(state.episodes.length ? state.episodes : [{ id: "", name: project ? "No episodes yet" : "Select project first" }], episodeId);
  episodes.onchange = () => run(() => chooseEpisode(episodes.value));
  episodes.disabled = !project; scenes.disabled = !episodeId;
  const control = (label, choices, create) => $("div", { class: "ava-selector" }, field(label, choices), create);
  return card(eyebrow("PROJECT / EPISODE / SCENE"), control("Project", projects, button("Create new project", async () => {
    const name = prompt("New project name", `Project ${state.projects.length + 1}`);
    if (name === null) return false;
    const result = await action("createProject", { name }); await chooseProject(result.project.id); switchSection("agent");
  })), row(control("Episode", episodes, button("Create new episode", async () => {
    const name = prompt("New episode name", `Episode ${state.episodes.length + 1}`);
    if (name === null) return false;
    const result = await action("createEpisode", { name }); await chooseEpisode(result.episode.id); switchSection("agent");
  }, "", !!project)), control("Scene", scenes, button("Create new scene", async () => {
    const result = await action("createScene"); await chooseScene(result.scene.id); switchSection("agent");
  }, "", !!project && !!episodeId))));
}

function manageSelection() {
  const project = state.project, episode = state.episodes.find(e => e.id === episodeId);
  const projectName = input(project.name), episodeName = input(episode?.name || ""), sceneName = input(scene?.name || "");
  episodeName.disabled = !episode; sceneName.disabled = !scene;
  return card(heading("Names & deletion", "Manage the selected project, episode and scene."),
    field("Project name", projectName), row(button("Rename project", () => action("renameProject", { name: projectName.value })),
      button("Delete project…", async () => {
        if (!confirm(`Delete “${project.name}” and all its episodes and scenes? Saved data goes to recovery trash.`)) return false;
        await action("deleteProject"); const removed = projectId; await chooseProject(""); localStorage.removeItem(`ava-scope-${removed}`);
      }, "ava-danger")),
    field("Episode name", episodeName), row(button("Rename episode", () => action("renameEpisode", { name: episodeName.value }), "", !!episode),
      button("Delete episode…", async () => {
        if (!confirm(`Delete “${episode.name}” and its scenes? Saved data goes to recovery trash. The project library is retained.`)) return false;
        await action("deleteEpisode"); await chooseEpisode("");
      }, "ava-danger", !!episode)),
    field("Scene name", sceneName), row(button("Rename scene", () => action("renameScene", { name: sceneName.value }), "", !!scene),
      button("Delete scene…", async () => {
        if (!confirm(`Delete “${scene.name}” and its takes? Saved data goes to recovery trash.`)) return false;
        await action("deleteScene"); scene = null; await chooseScene("");
      }, "ava-danger", !!scene)));
}

async function uploadFile(file, values = {}) {
  const form = new FormData(); form.append("file", file);
  const query = new URLSearchParams({ projectId, ...(values.sceneId ? { episodeId } : {}), ...values });
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

function assets(ref, sceneReference = false) {
  return $("div", { class: "ava-assets" }, ...ref.assets.map(asset => card(
    asset.kind === "image" ? $("img", { src: mediaUrl(asset), alt: ref.name, loading: "lazy" }) : $("audio", { src: mediaUrl(asset), controls: true, preload: "none" }),
    note(asset.name + (asset.duration ? ` · ${asset.duration.toFixed(2)}s` : "")),
    sceneReference && button("Remove from scene slot", () => action("removeAsset", { referenceId: ref.id, path: asset.path }))
  )));
}

function library() {
  const project = state.project;
  if (!project) return null;
  const name = input(), kind = select(["character", "location", "prop"], "character"), description = area("", 2);
  return $("div", {}, heading("Reference library", `${project.library.length} saved entries · shared by every episode of ${project.name}`),
    $("details", { open: !project.library.length }, $("summary", { text: "Create a library entry" }), card(
    field("Name", name), field("Kind", kind), field("Description", description),
    button("Create library entry", () => action("createLibrary", { name: name.value, kind: kind.value, description: description.value })))),
    $("div", { class: "ava-library-grid" },
    ...project.library.map(ref => card($("h4", { text: ref.name }), note(ref.description), assets(ref), uploadControl({ referenceId: ref.id }),
      row(scene && button("Add to current scene", () => action("addLibraryReference", { referenceId: ref.id })),
        button("Clone", () => action("cloneLibrary", { referenceId: ref.id })),
        button("Remove library entry", async () => { if (confirm(`Remove ${ref.name} from the library? Scene copies remain available.`)) await action("removeLibrary", { referenceId: ref.id }); }))
    ))), savedVideos());
}

function savedVideos() {
  const takes = state.videos;
  return $("div", {}, heading("Saved videos", `${takes.length} saved take${takes.length === 1 ? "" : "s"} in this project`),
    takes.length ? $("div", { class: "ava-library-grid" }, ...takes.map(take => card($("h4", { text: take.title }),
      note(`${take.episodeName} / ${take.sceneName} · ${take.actualDuration || take.duration}s`), $("video", { src: mediaUrl(take.video), controls: true, preload: "none" }),
      note(`Completed at: ${timeText(take.timing?.completedAt)}`), $("a", { href: mediaUrl(take.video), download: take.video.name || `${take.id}.mp4`, text: "Download video" })))) : card(note("Your finished clips and previous takes will appear here.")));
}

function sceneDraft() {
  const value = (id, fallback) => content.querySelector(`#ava-${id}`)?.value ?? fallback;
  return { name: scene.name, script: value("scene-script", scene.script), settings: {
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
    button("Save render settings", () => action("saveScene", sceneDraft()), "ava-primary"));
}

function sceneEditor() {
  const script = area(scene.script, 8);
  script.id = "ava-scene-script";
  async function save() {
    await action("saveScene", sceneDraft());
  }
  return card(eyebrow("01 / PLAN"), heading("Build your scene", "Start with your script. Qwen identifies references, then plans each clip."), field("Script / scene", script),
    note(`FastH3 · ${scene.settings.aspectRatio} · ${scene.settings.megapixels} MP · ${scene.settings.steps} steps · configure in Settings`),
    row(button("Save scene", save), button("1 · Identify references", async () => { await save(); await action("identify"); })),
    note(scene.summary || "Identify slots, supply your references, then let Qwen inspect them and plan clips."),
    note("Qwen combines consecutive actions and dialogue into fewer clips, up to 15 seconds each, while preserving natural timing."),
    button(scene.clips.length ? "Replan / optimize unsubmitted clips" : "2 · Understand references & plan clips", async () => { await save(); await action("plan"); }, "ava-primary"));
}

function references() {
  const project = state.project;
  const name = input(), kind = select(["character", "location", "prop"], "character");
  return $("details", { open: !scene.clips.length }, $("summary", { text: `Scene references (${scene.references.length})` }), card(
    note("Empty slots are ignored. Add images and voice samples you actually want used. Choose references independently for each clip."),
    row(field("New reference", name), field("Kind", kind)), button("Add reference slot", () => action("createReference", { name: name.value, kind: kind.value })),
    ...scene.references.map(ref => {
      const saved = select([{ id: "", name: "Choose a library entry" }, ...project.library], "");
      return card($("h4", { text: `${ref.name} · ${ref.kind}` }), note(ref.description), assets(ref, true), uploadControl({ sceneId, referenceId: ref.id }),
        field("Use saved library files", saved), button("Copy library files to this slot", () => {
          if (!saved.value) throw new Error("Choose a library entry first");
          return action("addLibraryReference", { referenceId: saved.value, slotId: ref.id });
        }));
    })
  ));
}

function clipEditor(clip, index) {
  const prompt = area(clip.prompt, 10), comments = area("", 3), length = input(clip.nextDuration ?? clip.duration, "number");
  length.min = 2; length.max = 15; length.step = 0.5;
  const continuity = select(["auto", "on", "off"], clip.continuityMode);
  const checks = scene.references.filter(r => r.assets.length).map(ref => ({ ref, box: $("input", { type: "checkbox", checked: clip.referenceIds.includes(ref.id) }) }));
  async function save() {
    await action("saveClip", { clipId: clip.id, prompt: prompt.value, referenceIds: checks.filter(c => c.box.checked).map(c => c.ref.id), continuityMode: continuity.value });
  }
  const frameControls = clip.status === "complete" && $("details", {}, $("summary", { text: "Last frame & continuity" }),
    clip.frame && $("img", { src: mediaUrl(clip.frame), alt: "Actual last frame / replacement", loading: "lazy" }),
    uploadControl({ sceneId, clipId: clip.id }, "Replace last frame"), button("Restore extracted frame", () => action("restoreFrame", { clipId: clip.id })));
  const keys = $("details", {}, $("summary", { text: "Canvas node IDs / review key" }),
    $("pre", { text: JSON.stringify({ project_id: projectId, scene_id: sceneId, clip_id: clip.id, review_key: clip.reviewKey }, null, 2) }));
  const editor = card(eyebrow(`CLIP ${String(index + 1).padStart(2, "0")} / ${String(scene.clips.length).padStart(2, "0")}`), $("h3", { text: `${index + 1}. ${clip.title}` }), statusPanel(clip, true), note(`${clip.transition} · ${clip.actualDuration ? `${clip.actualDuration.toFixed(2)}s saved` : `${clip.duration}s planned`}`),
    clip.continuityOutdated && note("An earlier take or frame changed. This completed take is retained; review continuity before regenerating."),
    clip.error && $("p", { class: "ava-error", text: clip.error }),
    clip.video && $("video", { src: mediaUrl(clip.video), controls: true, preload: "metadata" }),
    note(`Outline: ${clip.outline}`), field("Editable video prompt", prompt),
    $("div", { class: "ava-checks" }, ...checks.map(({ ref, box }) => $("label", {}, box, document.createTextNode(ref.name)))),
    field("Frame continuity", continuity),
    row(field(clip.takeId ? "Duration for next take" : "Duration", length), button("Save duration", () => action("setDuration", { clipId: clip.id, duration: Number(length.value) }))),
    clip.nextDuration !== undefined && note(`The submitted/saved take keeps ${clip.duration}s. Next take: ${clip.nextDuration}s.`),
    row(button("Save prompt & references", save), button(index ? "Plan prompt from last frame" : "Plan prompt", async () => {
      // Save existing edits before Qwen sees the target. A blank outline prompt is planned directly.
      await save();
      await action("planPrompt", { clipId: clip.id });
    })),
    field("Revision comments", comments), button("Apply comments with Qwen", async () => { await save(); await action("revisePrompt", { clipId: clip.id, comments: comments.value }); }),
    button(clip.takeId ? "Approve prompt & regenerate this clip" : "Approve prompt & generate this clip", async () => {
      await save();
      const savedScene = await request(`/scene?${scopeQuery()}&sceneId=${encodeURIComponent(sceneId)}`);
      const saved = savedScene.clips.find(c => c.id === clip.id);
      if (!saved.reviewKey) throw new Error("Plan this prompt again after changing references, continuity or duration, then review it before generating.");
      await action("approveGenerate", { clipId: clip.id, reviewKey: saved.reviewKey });
    }, "ava-primary"),
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
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.graph, null, 2)], { type: "application/json" }));
      const link = $("a", { href: url, download: `${scene.name}-${clip.id}-api.json` }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
  editor.classList.add("ava-clip");
  return editor;
}

function studio() {
  if (scene.clips.length) return null;
  const prompt = area("", 5), seconds = input(15, "number");
  return $("details", {}, $("summary", { text: "Video Studio · manual single clip" }), card(
    note("Save the scene settings, supply references, then prepare a manual prompt. Review and generate it using the clip controls below."),
    field("Manual prompt", prompt), field("Duration", seconds), button("Prepare Studio clip", () => action("manualClip", { prompt: prompt.value, duration: Number(seconds.value) }))));
}

function render() {
  if (!state.project) section = "agent";
  const detailsState = new Map([...workspace.querySelectorAll("details")].map((el, i) => [`${i}:${el.querySelector("summary")?.textContent}`, el.open]));
  message.classList.remove("ava-error");
  const agent = $("section", { id: "ava-panel-agent", role: "tabpanel", ariaLabel: "Agent" },
    ...(scene ? [sceneEditor(), references(), studio(), scene.clips.length && heading("Review & render", `${scene.clips.filter(c => c.status === "complete").length} of ${scene.clips.length} clips complete · approve each take when ready`), ...scene.clips.map(clipEditor)].filter(Boolean) : [card(heading("Your next video starts here", "Create a project and scene above, then give Qwen your script."))]));
  const libraryPanel = $("section", { id: "ava-panel-library", role: "tabpanel", ariaLabel: "Library" }, projectId ? library() : card(note("Create a project to build its reference library.")));
  const settingsPanel = $("section", { id: "ava-panel-settings", role: "tabpanel", ariaLabel: "Settings" }, ...(state.project ? [manageSelection(), connection()] : []), ...(scene ? [generationSettings()] : []),
    card(heading("Render timing", "Automatic tracking for every new take."), note("Elapsed time includes time spent in the queue. Estimated finish uses recent completed takes with matching duration, steps, resolution and reference size. The first render shows a sampling estimate once its rate is known. Completion time is recorded after the video is verified and saved. Times use your browser's local timezone.")));
  projectHost.replaceChildren(projectControls());
  navigation.hidden = !state.project;
  content.replaceChildren(agent, libraryPanel, settingsPanel);
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
    $("div", { class: "ava-brand" }, $("span", { class: "ava-mark", text: "a", ariaHidden: "true" }), $("div", {}, $("h2", { text: "AI Video Agent" }), $("span", { class: "ava-subtitle", text: "Qwen plans. FastH3 creates." }))), row(
    button("Refresh", () => refresh(true)), openButton)), projectHost, navigation, message, livePanel, content,
    $("footer", { text: "QWEN + FASTH3 / YOUR COMFYUI WORKSPACE" }));
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
  name: "AI.Video.Agent.Qwen",
  setup() {
    mount();
    app.extensionManager.registerSidebarTab({ id: "ai-video-agent", icon: "pi pi-video", title: "AI Video Agent", tooltip: "Qwen video planning & reviewed generation", type: "custom", render(el) { sidebarHost = el; if (!modal?.open) el.append(workspace); } });
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
