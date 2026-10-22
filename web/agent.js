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
const field = (label, input) => $("label", {}, $("span", { text: label }), input);
const input = (value = "", type = "text") => $("input", { value, type });
const area = (value = "", rows = 5) => $("textarea", { value, rows });
const select = (values, current) => $("select", {}, ...values.map(v => $("option", { value: typeof v === "string" ? v : v.id, text: typeof v === "string" ? v : v.name, selected: (typeof v === "string" ? v : v.id) === current })));
const row = (...children) => $("div", { class: "ava-row" }, ...children);
const card = (...children) => $("section", { class: "ava-card" }, ...children);
const note = text => $("p", { class: "ava-note", text });
const mediaUrl = asset => api.apiURL(`${prefix}/media?path=${encodeURIComponent(asset.path)}`);

let workspace, message, content, projectId = localStorage.getItem("ava-project") || "", sceneId = localStorage.getItem("ava-scene") || "";
let state, scene, busy = false, dirty = false, modal, poller, refreshing = false, sidebarHost, diagnostics;
let renderedSnapshot = "";
const originalTitle = document.title;

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
function button(label, work, className = "") {
  return $("button", { text: label, class: className, disabled: busy, onclick: () => run(work) });
}
async function run(work) {
  if (busy) return;
  busy = true;
  workspace.setAttribute("aria-busy", "true");
  content.inert = true;
  message.textContent = "Working…";
  workspace.querySelectorAll("button").forEach(b => { b.disabled = true; });
  try { await work(); dirty = false; message.textContent = "Saved"; await refresh(true); }
  catch (error) { message.textContent = error.message; message.classList.add("ava-error"); }
  finally { busy = false; content.inert = false; workspace.setAttribute("aria-busy", "false"); workspace.querySelectorAll("button").forEach(b => { b.disabled = false; }); }
}
async function action(command, values = {}) {
  return request("/action", { action: command, projectId, sceneId, ...values });
}
function remember() {
  localStorage.setItem("ava-project", projectId);
  localStorage.setItem("ava-scene", sceneId);
}
async function chooseProject(id) { projectId = id; sceneId = ""; remember(); }
async function chooseScene(id) { sceneId = id; remember(); }

async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await request(`/state${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
    if (projectId && !state.projects.some(p => p.id === projectId)) { projectId = ""; sceneId = ""; remember(); }
    if (!projectId && state.projects.length) { projectId = state.projects[0].id; remember(); state = await request(`/state?projectId=${projectId}`); }
    if (!state.scenes.some(s => s.id === sceneId)) sceneId = state.scenes[0]?.id || "";
    if (sceneId) scene = await request(`/scene?projectId=${projectId}&sceneId=${sceneId}`);
    else scene = null;
    remember();
    if (message.textContent === "Loading…") message.textContent = "Ready";
    const running = scene?.clips.find(c => active.has(c.status));
    document.title = running ? `${running.status} · ${running.title} · ComfyUI` : scene?.clips.length && scene.clips.every(c => c.status === "complete") ? "Video complete · ComfyUI" : originalTitle;
    // Preserve unsaved prompt, script, selection and comments during background checks.
    if (force || (JSON.stringify([state, scene]) !== renderedSnapshot && !dirty && !busy && !workspace.contains(document.activeElement?.closest("input,textarea,select")))) render();
  } finally { refreshing = false; }
}

function newProjectForm() {
  const name = input("New video project");
  return card($("h3", { text: "Projects" }), field("Project name", name), button("Create project", async () => {
    const result = await action("createProject", { name: name.value }); await chooseProject(result.project.id);
  }));
}

function connection() {
  const conf = state.qwen;
  const model = input(conf.model);
  const result = $("pre", { class: "ava-diagnostics", text: diagnostics || "Check the pod's models, nodes, media tools and Qwen connection." });
  return $("details", {}, $("summary", { text: "Qwen & RunPod setup" }), card(
    note("Qwen-VL runs directly inside ComfyUI using the planner file in models/text_encoders. Download links are in workflow.json. The existing H3 Qwen encoder stays in the render graph."),
    field("Qwen planner model filename", model),
    button("Save Qwen model", () => action("qwenConfig", { config: { model: model.value } })),
    button("Check installation", async () => { diagnostics = JSON.stringify(await request("/health"), null, 2); result.textContent = diagnostics; }), result,
    note(`Storage on pod: ${state.storage}. Use a RunPod persistent volume.`)
  ));
}

function projectControls() {
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return newProjectForm();
  const projects = select(state.projects, projectId);
  projects.onchange = () => run(() => chooseProject(projects.value));
  const scenes = select([{ id: "", name: "Select scene" }, ...state.scenes.map(s => ({ id: s.id, name: s.name }))], sceneId);
  scenes.onchange = () => run(() => chooseScene(scenes.value));
  const projectName = input(project.name), sceneName = input("New scene");
  return card(field("Project", projects), field("Scene", scenes),
    $("details", {}, $("summary", { text: "Manage projects & scenes" }),
      newProjectForm(), field("Rename current project", projectName), button("Rename project", () => action("renameProject", { name: projectName.value })),
      field("New scene name", sceneName), button("Create scene", async () => {
        const result = await action("createScene", { name: sceneName.value }); await chooseScene(result.scene.id);
      }), button("Delete project…", async () => {
        if (!confirm(`Move “${project.name}” and its saved media to the pod's recovery trash?`)) return;
        await action("deleteProject"); projectId = ""; sceneId = ""; remember();
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

function assets(ref, sceneReference = false) {
  return $("div", { class: "ava-assets" }, ...ref.assets.map(asset => card(
    asset.kind === "image" ? $("img", { src: mediaUrl(asset), alt: ref.name, loading: "lazy" }) : $("audio", { src: mediaUrl(asset), controls: true, preload: "none" }),
    note(asset.name + (asset.duration ? ` · ${asset.duration.toFixed(2)}s` : "")),
    sceneReference && button("Remove from scene slot", () => action("removeAsset", { referenceId: ref.id, path: asset.path }))
  )));
}

function library() {
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return null;
  const name = input(), kind = select(["character", "location", "prop"], "character"), description = area("", 2);
  return $("details", {}, $("summary", { text: `Project reference library (${project.library.length})` }), card(
    field("Name", name), field("Kind", kind), field("Description", description),
    button("Create library entry", () => action("createLibrary", { name: name.value, kind: kind.value, description: description.value })),
    ...project.library.map(ref => card($("h4", { text: ref.name }), note(ref.description), assets(ref), uploadControl({ referenceId: ref.id }),
      row(scene && button("Add to current scene", () => action("addLibraryReference", { referenceId: ref.id })),
        button("Clone", () => action("cloneLibrary", { referenceId: ref.id })),
        button("Remove library entry", async () => { if (confirm(`Remove ${ref.name} from the library? Scene copies remain available.`)) await action("removeLibrary", { referenceId: ref.id }); }))
    ))));
}

function sceneEditor() {
  const name = input(scene.name), script = area(scene.script, 8);
  const opts = scene.settings;
  const ratio = select(["16:9", "9:16", "1:1"], opts.aspectRatio), mp = input(opts.megapixels, "number"), steps = input(opts.steps, "number"), seed = input(opts.seed, "number");
  mp.min = 0.25; mp.max = 4; mp.step = 0.25; steps.min = 1; steps.max = 100;
  const quality = select(["match", "max"], opts.refImageSize);
  async function save() {
    await action("saveScene", { name: name.value, script: script.value, settings: { provider: "h3", aspectRatio: ratio.value, megapixels: Number(mp.value), steps: Number(steps.value), seed: Number(seed.value), refImageSize: quality.value } });
  }
  return card($("h3", { text: "Scene & video settings" }), field("Scene name", name), field("Script / scene", script),
    note("FastH3 · rendering on this ComfyUI GPU"), row(field("Aspect ratio", ratio), field("H3 megapixels", mp), field("H3 steps", steps)),
    $("details", {}, $("summary", { text: "Advanced settings" }), field("Seed (-1 = random)", seed), field("H3 reference size", quality)),
    row(button("Save scene", save), button("1 · Identify references", async () => { await save(); await action("identify"); })),
    note(scene.summary || "Identify slots, supply your references, then let Qwen inspect them and plan clips."),
    button(scene.clips.length ? "Replan / optimize unsubmitted clips" : "2 · Understand references & plan clips", async () => { await save(); await action("plan"); }, "ava-primary"));
}

function references() {
  const project = state.projects.find(p => p.id === projectId);
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
  return card($("h3", { text: `${index + 1}. ${clip.title}` }), note(`${clip.status} · ${clip.transition} · ${clip.actualDuration ? `${clip.actualDuration.toFixed(2)}s saved` : `${clip.duration}s planned`}`),
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
      const savedScene = await request(`/scene?projectId=${projectId}&sceneId=${sceneId}`);
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
    clip.versions?.length && $("details", {}, $("summary", { text: `Previous takes (${clip.versions.length})` }), ...clip.versions.map(v => card(note(`${v.status} · ${v.actualDuration || v.duration}s · ${v.takeId}`), v.video && $("video", { src: mediaUrl(v.video), controls: true, preload: "none" }), note(v.submittedPrompt || v.prompt)))), keys,
    button("Export this clip's H3 API graph", async () => {
      const result = await action("exportGraph", { clipId: clip.id });
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.graph, null, 2)], { type: "application/json" }));
      const link = $("a", { href: url, download: `${scene.name}-${clip.id}-api.json` }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
}

function studio() {
  if (scene.clips.length) return null;
  const prompt = area("", 5), seconds = input(15, "number");
  return $("details", {}, $("summary", { text: "Video Studio · manual single clip" }), card(
    note("Save the scene settings, supply references, then prepare a manual prompt. Review and generate it using the clip controls below."),
    field("Manual prompt", prompt), field("Duration", seconds), button("Prepare Studio clip", () => action("manualClip", { prompt: prompt.value, duration: Number(seconds.value) }))));
}

function render() {
  const detailsState = new Map([...content.querySelectorAll("details")].map((el, i) => [`${i}:${el.querySelector("summary")?.textContent}`, el.open]));
  message.classList.remove("ava-error");
  content.replaceChildren(connection(), projectControls(), ...(projectId ? [library()] : []), ...(scene ? [sceneEditor(), references(), studio(), ...scene.clips.map(clipEditor)].filter(Boolean) : []));
  [...content.querySelectorAll("details")].forEach((el, i) => { const key = `${i}:${el.querySelector("summary")?.textContent}`; if (detailsState.has(key)) el.open = detailsState.get(key); });
  renderedSnapshot = JSON.stringify([state, scene]);
}

function mount() {
  if (workspace) return;
  const style = $("style", { text: `
  .ava-workspace{--ava-border:#3b4050;background:#171a21;color:#eef1f7;font:14px/1.5 system-ui;padding:20px;height:100%;overflow:auto;box-sizing:border-box}
  .ava-workspace *{box-sizing:border-box}.ava-workspace h2,.ava-workspace h3,.ava-workspace h4{margin:0 0 10px;color:#f4f5fa}
  .ava-workspace[aria-busy=true] main{pointer-events:none;opacity:.7}
  .ava-workspace header{display:flex;align-items:center;justify-content:space-between;gap:12px}.ava-workspace main{max-width:1100px;margin:auto}
  .ava-card{padding:16px;border:1px solid var(--ava-border);border-radius:12px;margin:14px 0;background:#1f232e}
  .ava-workspace label{display:flex;flex-direction:column;gap:5px;margin:10px 0;flex:1;min-width:110px}
  .ava-workspace input,.ava-workspace textarea,.ava-workspace select{width:100%;border:1px solid #485168;border-radius:6px;padding:9px;background:#12161f;color:#eef1f7;font:inherit}
  .ava-workspace textarea{resize:vertical}.ava-workspace button{padding:9px 13px;border:1px solid #4c5670;border-radius:7px;margin:5px 6px 5px 0;background:#303a50;color:#f4f5fa;cursor:pointer;font:inherit}
  .ava-workspace button:disabled{opacity:.5;cursor:wait}.ava-workspace .ava-primary{background:#3154ad;border-color:#5b83e8}.ava-workspace .ava-danger{background:#6a303a}
  .ava-row{display:flex;align-items:end;gap:10px;flex-wrap:wrap}.ava-note{color:#b8c1d3;font-size:13px;white-space:pre-wrap}
  .ava-error{color:#ffb0b0;white-space:pre-wrap}.ava-workspace pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;background:#141823;padding:12px;border-radius:8px}
  .ava-workspace summary{padding:10px 0;cursor:pointer;font-weight:600}.ava-workspace video{width:100%;max-height:460px;background:#080a0e;border-radius:8px}
  .ava-workspace img{max-width:100%;max-height:240px;object-fit:contain;border-radius:6px}.ava-workspace audio{width:100%}
  .ava-assets{display:flex;flex-wrap:wrap;gap:10px}.ava-assets>.ava-card{max-width:260px}.ava-checks{display:flex;gap:14px;flex-wrap:wrap}.ava-checks label{flex-direction:row;align-items:center;flex:0 1 auto}.ava-checks input{width:auto}
  .ava-dialog{position:fixed;inset:4vh 4vw;width:92vw;height:92vh;padding:0;border:1px solid #555f78;border-radius:14px;z-index:10000;background:#171a21;color:#eef1f7}
  .ava-dialog[open]{display:flex;flex-direction:column}.ava-dialog>.ava-workspace{flex:1;min-height:0;height:auto}
  .ava-dialog>button{align-self:flex-end;margin:10px 18px 0;padding:8px 12px;border:1px solid #4c5670;border-radius:7px;background:#303a50;color:#f4f5fa;cursor:pointer}
  .ava-dialog::backdrop{background:#000a}
  ` });
  document.head.append(style);
  message = $("p", { role: "status", text: "Loading…" });
  content = $("main");
  workspace = $("div", { class: "ava-workspace" }, $("header", {}, $("h2", { text: "AI Video Agent · Qwen" }), row(
    button("Refresh", () => refresh(true)), button("Open workspace", async () => openModal()))), message, content);
  workspace.addEventListener("input", () => { dirty = true; });
  workspace.addEventListener("change", event => { if (event.target.tagName !== "SELECT" || event.target.closest("main")) dirty = true; });
  poller = setInterval(() => { if (!busy) refresh().catch(error => { message.textContent = error.message; }); }, 5000);
  refresh(true).catch(error => { message.textContent = error.message; });
}

function openModal() {
  mount();
  if (!modal) {
    modal = $("dialog", { class: "ava-dialog" });
    const close = $("button", { text: "Close workspace", onclick: () => modal.close() });
    modal.addEventListener("close", () => { if (sidebarHost) sidebarHost.append(workspace); });
    modal.append(close); document.body.append(modal);
  }
  modal.append(workspace);
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
