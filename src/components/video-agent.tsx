"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, Check, Film, FolderOpen, ImagePlus, LoaderCircle, Pause, Play, Plus, RefreshCw, Settings2, Sparkles, Trash2, X } from "lucide-react";
import { audioBindings, assetUrl, needsPreviousPrompt, previousPromptAvailable, previousFrameDecision, referenceBindings, type AgentClip, type PublicProject } from "@/lib/agent-types";
import { ratios } from "@/lib/h3";
import { clipReferenceBudget, projectReferenceIssues } from "@/lib/agent-reference-validation";
import { defaultReasoningEffort, reasoningEffortSchema, reasoningLabels, type ReasoningEffort } from "@/lib/reasoning";
import { MAX_REFERENCE_FILE_BYTES, referenceSize } from "@/lib/reference-limits";

import type { Character } from "@/lib/characters";
import { encodeReference } from "./characters-tab";
import { agentTabStatus, type GenerationTabStatus } from "@/lib/generation-tab-status";
import { useReportTabStatus } from "./use-generation-tab-status";

type ProjectSummary = { id: string; collectionId?: string; title: string; status: string; clipCount: number; completed: number; active: boolean };
type Connection = { endpoint: string; configured: boolean; environmentKey?: boolean };
async function api(path: string, body?: unknown) {
  const response = await fetch(`/api/${path}`, { cache: "no-store", ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || "The agent request failed."); return data;
}
function message(error: unknown) { return error instanceof Error ? error.message : "The agent request failed."; }
function shotFields(clip: AgentClip) { const { id, title, duration, prompt, referenceIds, continuation, continuityMode } = clip; return { id, title, duration, prompt, referenceIds, continuation, continuityMode }; }

export function VideoAgent({ visible, collectionId = "", onBusyChange, onStatusChange, selection, codex, model, onModelChange, openConnection }: { visible: boolean; collectionId?: string; onBusyChange?: (busy: boolean) => void; onStatusChange?: (status: GenerationTabStatus | null) => void; selection?: { id: string; version: number } | null; codex: import("@/lib/codex").CodexInfo; model: string; onModelChange: (value: string) => void; openConnection: () => void }) {
  const selectionRef = useRef(selection); selectionRef.current = selection;
  const openedSelection = useRef(0);
  const selectedProjectId = useRef<string | null>(null);
  const selectionVersion = useRef(0);
  const models = codex.models;
  const canPlan = codex.connected && Boolean(collectionId);
  const [thinking, setThinking] = useState<ReasoningEffort>(defaultReasoningEffort);
  const thinkingSelectionVersion = useRef(0);
  const selectedModel = models.find(item => item.slug === model);
  const thinkingModes = selectedModel?.reasoningEfforts?.length ? selectedModel.reasoningEfforts : [{ effort: defaultReasoningEffort, description: "Faster responses with lighter reasoning" }];
  const reasoningEffort = thinkingModes.some(option => option.effort === thinking) ? thinking : thinkingModes.find(option => option.effort === defaultReasoningEffort)?.effort || thinkingModes.find(option => option.effort === selectedModel?.defaultReasoningEffort)?.effort || thinkingModes[0].effort;
  function chooseThinking(value: string) {
    const effort = reasoningEffortSchema.parse(value);
    thinkingSelectionVersion.current++;
    setThinking(effort); localStorage.setItem("video-agent-thinking", effort);
  }
  const [characters, setCharacters] = useState<Character[]>([]);
  useEffect(() => { if (visible) void api(`characters?collectionId=${encodeURIComponent(collectionId)}`).then(data => setCharacters(data.characters)).catch(cause => setError(message(cause))); }, [visible, collectionId]);
  const [script, setScript] = useState("");
  const [project, setProject] = useState<PublicProject | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [folder, setFolder] = useState("");
  const [drafts, setDrafts] = useState<Record<string, AgentClip>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [operationStatus, setOperationStatus] = useState<string>();
  const [mutating, setMutating] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loadingScenes, setLoadingScenes] = useState(true);
  const [preferredProvider, setPreferredProvider] = useState<"runpod" | "apimart">("runpod");
  const provider = project ? project.settings.provider || "runpod" : preferredProvider;
  const isWan = provider === "apimart";
  const [wanConnection, setWanConnection] = useState<{ configured: boolean; environmentKey: boolean } | null>(null);
  const selectedConnection = isWan ? wanConnection : connection;
  useEffect(() => { if (isWan && visible) void api("apimart/settings").then(setWanConnection).catch(cause => setError(message(cause))); }, [isWan, visible]);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [key, setKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [recovery, setRecovery] = useState<Record<string, string>>({});
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const [clearingLibraryAsset, setClearingLibraryAsset] = useState<string>();
  const [revisionEdits, setRevisionEdits] = useState<Record<string, { prompt?: string; referenceIds?: string[] }>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const initialized = useRef(false);
  const mutationLock = useRef(false);
  const pollingLock = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const active = Boolean(project?.active);
  const busy = active || analyzing || mutating || Boolean(uploading);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const supplied = project?.references.filter(slot => slot.asset || slot.audios?.length).length || 0;
  useReportTabStatus(agentTabStatus(project, analyzing ? "Identifying scene references" : operationStatus), onStatusChange);
  const completed = project?.clips.filter(clip => clip.status === "complete").length || 0;
  const editedProject = project ? { ...project, clips: project.clips.map(clip => ({ ...(drafts[clip.id] || clip), referenceIds: revisionEdits[clip.id]?.referenceIds ?? clip.revision?.referenceIds ?? clip.referenceIds })) } : null;
  const referenceIssues = editedProject ? projectReferenceIssues(editedProject) : [];

  const loadLibrary = useCallback(async () => { const data = await api("agent/projects"); const scenes = data.projects.filter((item: ProjectSummary) => (item.collectionId || "") === collectionId); setProjects(scenes); setFolder(data.folder); return scenes as ProjectSummary[]; }, [collectionId]);
  const selectProject = useCallback(async (id: string, choiceVersion = thinkingSelectionVersion.current) => {
    const version = ++selectionVersion.current; selectedProjectId.current = id;
    const data = await api(`agent/project?projectId=${encodeURIComponent(id)}`);
    if (version !== selectionVersion.current) return;
    if ((data.project.collectionId || "") !== collectionId) throw new Error("Select this scene's project from the sidebar first.");
    setProject(data.project); setScript(data.project.script);
    // A late project response must not overwrite a mode the user just selected.
    if (thinkingSelectionVersion.current === choiceVersion) setThinking(data.project.reasoningEffort || defaultReasoningEffort);
    setDrafts({}); setFeedback({}); setRevisionEdits({}); setClearingLibraryAsset(undefined); setError(""); setNotice(""); localStorage.setItem("video-agent-project", id);
  }, [collectionId]);
  useEffect(() => {
    if (!visible || initialized.current) return; initialized.current = true;
    const choiceVersion = thinkingSelectionVersion.current;
    const savedThinking = reasoningEffortSchema.safeParse(localStorage.getItem("video-agent-thinking"));
    if (savedThinking.success) setThinking(savedThinking.data);
    Promise.all([loadLibrary(), api("video/settings")]).then(async ([items, config]) => {
      setConnection(config); setEndpoint(config.endpoint);
      const previous = items.find(item => item.id === localStorage.getItem("video-agent-project")) || items.find(item => item.active) || items[0];
      if (previous && !selectionRef.current) await selectProject(previous.id, choiceVersion);
    }).catch(error => { initialized.current = false; setError(message(error)); }).finally(() => setLoadingScenes(false));
  }, [visible, loadLibrary, selectProject]);
  useEffect(() => {
    if (!visible || !selection || openedSelection.current === selection.version) return;
    openedSelection.current = selection.version;
    void selectProject(selection.id).then(loadLibrary).catch(cause => setError(message(cause)));
  }, [visible, selection, selectProject, loadLibrary]);
  useEffect(() => { if (connectionOpen) dialog.current?.showModal(); else dialog.current?.close(); }, [connectionOpen]);
  useEffect(() => {
    if (!project?.id || !project.active) return;
    const id = project.id;
    const timer = setInterval(async () => {
      if (pollingLock.current) return; pollingLock.current = true;
      try { const data = await api(`agent/project?projectId=${id}`); if (selectedProjectId.current !== id) return; setProject(data.project); if (!data.project.active) { setNotice(data.project.status === "complete" ? "All clips and their final frames are saved locally." : ""); await loadLibrary(); } }
      catch (cause) { setError(message(cause)); }
      finally { pollingLock.current = false; }
    }, 2000);
    return () => clearInterval(timer);
  }, [project?.id, project?.active, loadLibrary]);

  function accept(next: PublicProject) { selectedProjectId.current = next.id; setProject(next); localStorage.setItem("video-agent-project", next.id); }
  async function analyze() {
    if (!script.trim() || !model || !canPlan || mutationLock.current) return;
    mutationLock.current = true; setAnalyzing(true); setError(""); setNotice("");
    try { const data = await api("agent/analyze", { script, model, reasoningEffort, videoProvider: provider, ...(collectionId ? { collectionId } : {}), ...(project && !project.clips.length && !project.references.length ? { projectId: project.id } : {}) }); accept(data.project); setDrafts({}); setFeedback({}); setRevisionEdits({}); setClearingLibraryAsset(undefined); setNotice("References identified. Supply the images and voices you want to use, then plan clip prompts."); await loadLibrary(); }
    catch (cause) { setError(message(cause)); }
    finally { mutationLock.current = false; setAnalyzing(false); }
  }
  async function upload(slotId: string, file?: File, kind: "image" | "audio" = "image") {
    if (!project || busy || mutationLock.current) return;
    mutationLock.current = true; setUploading(slotId); setError("");
    try {
      let payload;
      if (file && kind === "audio") payload = await encodeReference(file);
      else if (file) {
        if (!file.size || file.size > MAX_REFERENCE_FILE_BYTES || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Use a nonempty PNG, JPEG or WebP image under 4 MiB.");
        const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Could not read this image.")); reader.readAsDataURL(file); });
        payload = { name: file.name, bytes: file.size, base64: url.slice(url.indexOf(",") + 1) };
      }
      const data = await api("agent/reference", { projectId: project.id, slotId, kind, ...(payload ? { file: payload } : {}) }); accept(data.project); setNotice(file ? `${file.name} saved locally. Only uploaded slots will be included.` : "Reference removed from the scene. This empty slot will be ignored.");
    } catch (cause) { setError(message(cause)); }
    finally { mutationLock.current = false; setUploading(null); }
  }
  async function saveClip(clipId: string) {
    if (!project || !drafts[clipId]) return;
    const data = await api("agent/project", { projectId: project.id, action: "edit", clip: shotFields(drafts[clipId]) }); accept(data.project); setDrafts(current => { const next = { ...current }; delete next[clipId]; return next; });
  }
  async function mutate(action: () => Promise<void>, operation?: string) {
    if (mutationLock.current) return; mutationLock.current = true; setMutating(true); setError("");
    setOperationStatus(operation);
    try { await action(); } catch (cause) { setError(message(cause)); }
    finally { mutationLock.current = false; setMutating(false); setOperationStatus(undefined); }
  }
  async function planClips() {
    if (!project || !model || !canPlan) return;
    await mutate(async () => {
      const data = await api("agent/project", { projectId: project.id, action: "plan", model, reasoningEffort });
      accept(data.project); setDrafts({}); setRevisionEdits({}); await loadLibrary();
      setNotice("The first prompt and scene outline are ready. Later prompts are planned automatically from the preceding completed clip’s last frame, then wait for your review.");
    }, "Planning clip sequence");
  }
  async function planFollowingPrompt(clip: AgentClip) {
    if (!project || !model || !canPlan) return;
    await mutate(async () => {
      if (drafts[clip.id]) await saveClip(clip.id);
      const text = revisionEdits[clip.id]?.prompt ?? clip.revision?.prompt ?? clip.compiledPrompt;
      const data = await api("agent/project", { projectId: project.id, action: "planNextPrompt", clipId: clip.id, model, reasoningEffort, referenceIds: promptReferences(clip), ...(text?.trim() ? { prompt: text } : {}) });
      accept(data.project); setRevisionEdits(current => { const next = { ...current }; delete next[clip.id]; return next; });
      setNotice("Prompt planned from the previous clip’s actual last frame. Review and edit it before generating.");
    }, `Planning clip ${project.clips.findIndex(item => item.id === clip.id) + 1}/${project.clips.length}`);
  }
  function promptText(clip: AgentClip) { return revisionEdits[clip.id]?.prompt ?? clip.revision?.prompt ?? clip.compiledPrompt ?? clip.prompt; }
  function promptReferences(clip: AgentClip) { return revisionEdits[clip.id]?.referenceIds ?? clip.revision?.referenceIds ?? clip.referenceIds; }
  async function savePrompt(clip: AgentClip) {
    if (!project) return;
    if (drafts[clip.id]) await saveClip(clip.id);
    const data = await api("agent/project", { projectId: project.id, action: "prepareClip", clipId: clip.id, prompt: promptText(clip), referenceIds: promptReferences(clip) });
    accept(data.project);
  }
  async function generateClip(clip: AgentClip) {
    if (!project || !model || !canPlan) return;
    if (!selectedConnection?.configured) { setConnectionOpen(true); return; }
    const budget = clipReferenceBudget(editedProject!, { ...(drafts[clip.id] || clip), referenceIds: promptReferences(clip) });
    if (budget.error) { setError(budget.error); return; }
    await mutate(async () => {
      await savePrompt(clip);
      const data = await api("agent/run", { projectId: project.id, action: ["complete", "failed"].includes(clip.status) ? "rerender" : "start", clipId: clip.id, model, reasoningEffort });
      accept(data.project); setRevisionEdits(current => { const next = { ...current }; delete next[clip.id]; return next; });
      setNotice("Your edited prompt and reference choices were saved. Generating only this clip; previous takes are kept.");
    }, `Starting clip ${project.clips.findIndex(item => item.id === clip.id) + 1}/${project.clips.length}`);
  }
  async function replaceFrame(clipId: string, file?: File) {
    if (!project || busy) return;
    await mutate(async () => {
      let payload;
      if (file) {
        if (!file.size || file.size > MAX_REFERENCE_FILE_BYTES || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Use a nonempty PNG, JPEG or WebP image under 4 MiB.");
        const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Could not read the replacement frame.")); reader.readAsDataURL(file); });
        payload = { name: file.name, bytes: file.size, base64: url.slice(url.indexOf(",") + 1) };
      }
      const data = await api("agent/frame", { projectId: project.id, clipId, ...(payload ? { file: payload } : { restore: true }) });
      accept(data.project); setNotice(file ? "Last frame replaced and saved locally. Future continuation clips will use this image; existing videos are kept." : "Original extracted last frame restored.");
    });
  }
  async function revise(clip: AgentClip, comments: string) {
    if (!project || !canPlan || !model || !comments.trim()) return;
    await mutate(async () => {
      if (drafts[clip.id]) await saveClip(clip.id);
      const data = await api("agent/project", { projectId: project.id, action: "revise", clipId: clip.id, comments: comments.trim(), prompt: promptText(clip), referenceIds: promptReferences(clip), model, reasoningEffort });
      accept(data.project); setRevisionEdits(current => { const next = { ...current }; delete next[clip.id]; return next; }); setNotice("Comments applied to the prompt. Review or edit the text, then click Generate clip.");
    }, `Revising clip ${project.clips.findIndex(item => item.id === clip.id) + 1}/${project.clips.length}`);
  }
  async function resumeClip(clip: AgentClip) {
    if (!project || !model || !canPlan) return;
    await mutate(async () => {
      const data = await api("agent/run", { projectId: project.id, action: "start", clipId: clip.id, model, reasoningEffort });
      accept(data.project); setNotice("Resuming this clip's existing job or saved source. No replacement job is submitted.");
    });
  }
  async function clearLibraryAsset(slotId: string) {
    if (!project || busy) return;
    await mutate(async () => {
      const data = await api("agent/reference", { projectId: project.id, slotId, action: "clearLibraryAsset" });
      accept(data.project);
      setClearingLibraryAsset(undefined);
      setNotice("Selected library asset cleared. The reference slot and clip selections are kept; its empty media will be ignored until you provide another asset.");
    });
  }
  function edit(clip: AgentClip, values: Partial<AgentClip>) { setDrafts(current => ({ ...current, [clip.id]: { ...(current[clip.id] || clip), ...values } })); }
  function newScene() { ++selectionVersion.current; selectedProjectId.current = null; setProject(null); setScript(""); setDrafts({}); setFeedback({}); setRevisionEdits({}); setClearingLibraryAsset(undefined); setError(""); setNotice(""); localStorage.removeItem("video-agent-project"); }
  async function saveConnection(event: React.FormEvent) {
    event.preventDefault(); setSavingKey(true); setError("");
    try { const config = await api(isWan ? "apimart/settings" : "video/settings", { ...(isWan ? {} : { endpoint }), ...(key ? { apiKey: key } : {}) }); if (isWan) setWanConnection(config); else setConnection(config); setKey(""); setConnectionOpen(false); setNotice(`${isWan ? "API Mart" : "RunPod"} connection saved.`); } catch (cause) { setError(message(cause)); } finally { setSavingKey(false); }
  }

  return <div className="video-studio agent-workspace" style={{ display: visible ? undefined : "none" }}>
    <div className="video-title"><div><div className="eyebrow">YOUR STORY. A SEQUENCE OF SCENES.</div><h1>AI video agent.</h1><p>Scene → reference slots → short clips → saved videos and continuity frames.</p></div><button className="h3-button secondary" onClick={() => setConnectionOpen(true)} disabled={active}><Settings2 size={16} />{isWan ? "API Mart connection" : "RunPod connection"}<span className={`status-dot ${selectedConnection?.configured ? "ready" : ""}`} /></button></div>
    <label className="h3-field">Video generation model<select aria-label="Video generation model" value={provider} disabled={loadingScenes || busy || Boolean(project?.clips.some(clip => clip.status !== "complete" && (clip.requestId || clip.jobId || clip.source)))} onChange={event => { const next = event.target.value as "runpod" | "apimart"; if (project) void mutate(async () => { const data = await api("agent/project", { projectId: project.id, action: "edit", settings: { ...project.settings, provider: next } }); accept(data.project); setPreferredProvider(next); }); else setPreferredProvider(next); }}><option value="runpod">MiniMax H3 · RunPod</option><option value="apimart">Wan 3.0 · API Mart</option></select></label>
    {isWan && <p className="h3-hint">Wan uses reference-video mode only. Supply image or voice references; previous last frames are added as reference images alongside them. Continuity is guided by the prompt rather than a fixed first frame. Clips can run up to 30 seconds. Automatic duration lets Wan choose the final length.</p>}
    <div className="agent-library"><span><FolderOpen size={15} />Scenes</span><select aria-label="Local video scene" value={project?.id || ""} disabled={analyzing || mutating || Boolean(uploading)} onChange={event => { if (event.target.value) void selectProject(event.target.value).catch(error => setError(message(error))); }}><option value="">New scene</option>{projects.filter(item => (item.collectionId || "") === collectionId).map(item => <option key={item.id} value={item.id}>{item.title} · {item.completed}/{item.clipCount} clips{item.active ? " · running" : ""}</option>)}</select><button className="text-button" disabled={busy} onClick={newScene}><Plus size={14} />New scene</button></div>
    {!collectionId && <p className="h3-feedback">Choose or create a project in the sidebar before analyzing or generating scenes. Existing unassigned scenes can be added using Manage scenes.</p>}
    {!codex.connected && <div className="agent-connect"><Sparkles size={21} /><div><strong>Connect Codex CLI to plan your video.</strong><p>Sign in using Codex CLI on this computer, then refresh the connection.</p></div><button className="text-button" onClick={openConnection}>Codex connection</button></div>}
    {codex?.connected && <p className="h3-feedback agent-feedback">Codex CLI connected · {codex.skills.length} skills available. Uses your Codex ChatGPT login for planning.</p>}
    {error && <div className="h3-feedback error agent-feedback" role="alert">{error}</div>}
    {project?.error && <div className="h3-feedback error agent-feedback" role="alert">{project.error}</div>}
    {notice && !error && <div className="h3-feedback agent-feedback" role="status"><Check size={15} />{notice}</div>}
    <section className="h3-panel agent-scene"><div className="h3-section-title"><span>01</span><div><h2>Scene or script</h2><p>Describe the story, action and dialogue. The agent uses the fewest practical clips, up to {isWan ? 30 : 10} seconds each.</p></div></div><label className="h3-field">Your scene<textarea aria-label="Your scene" maxLength={32000} rows={5} value={script} disabled={busy || Boolean(project?.referencesIdentified || project?.references.length || project?.clips.length)} onChange={event => setScript(event.target.value)} placeholder="A traveler reaches an old station at dusk. She opens a letter, then looks up as a train arrives…" /></label><div className="agent-scene-actions"><label className="agent-model"><Sparkles size={14} /><select aria-label="Scene planning model" value={model} disabled={busy || !models.length} onChange={event => onModelChange(event.target.value)}>{!models.length && <option value="">Connect Codex CLI to choose a model</option>}{models.map(item => <option key={item.slug} value={item.slug}>{item.displayName}</option>)}</select></label><label className="agent-thinking"><span>Thinking</span><select aria-label="Thinking mode" aria-describedby="thinking-mode-help" value={reasoningEffort} disabled={busy || !models.length} onChange={event => chooseThinking(event.target.value)}>{thinkingModes.map(option => <option key={option.effort} value={option.effort} title={option.description}>{reasoningLabels[option.effort]}</option>)}</select></label><button className="h3-button" disabled={busy || !script.trim() || !canPlan || !model || Boolean(project?.referencesIdentified || project?.references.length || project?.clips.length)} onClick={() => void analyze()}>{analyzing ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{analyzing ? "Reading the scene…" : "Identify references"}</button></div><p id="thinking-mode-help" className="h3-hint agent-thinking-help">Low favors faster responses. Higher modes spend more time reasoning. Applies to reference identification, clip planning and comment edits.</p></section>
    {project && !project.referencesIdentified && !project.references.length && !project.clips.length && <div className="project-draft-note"><span>Draft: <strong>{project.title}</strong></span><button className="text-button" disabled={busy || script === project.script} onClick={() => void mutate(async () => { const data = await api("agent/projects", { action: "saveDraft", projectId: project.id, script }); accept(data.project); await loadLibrary(); setNotice("Draft saved locally."); })}>Save draft</button></div>}
    {project && (project.referencesIdentified || project.references.length > 0 || project.clips.length > 0) && <>
      <div className="agent-plan-heading"><div><h2>{project.title}</h2><p>{project.summary}</p></div><span className={`h3-status ${project.status === "complete" ? "completed" : ""}`}>{project.status.toUpperCase()}</span></div>
      <section className="h3-panel agent-reference-panel"><div className="h3-section-title"><span>02</span><div><h2>Scene references</h2><p>{supplied} supplied · {project.references.length - supplied} empty slots ignored. Supply only the references you want to use. Then choose “Understand references & plan clips” below.</p></div></div>
        <label className="h3-field">Add library reference to scene<select aria-label="Add library reference to scene" value="" disabled={busy || !characters.length} onChange={event => { const characterId = event.target.value; if (characterId) void mutate(async () => { const data = await api("agent/reference", { projectId: project.id, characterId }); accept(data.project); }); }}><option value="">Choose a saved reference</option>{characters.map(character => <option key={character.id} value={character.id}>{character.name} ({character.kind || "character"})</option>)}</select></label>
        {project.references.length ? <div className="agent-slots">{project.references.map(slot => <article className={`agent-slot ${slot.asset ? "has-reference" : ""}`} key={slot.id}><div className="agent-slot-picture">{slot.asset ? <img key={slot.asset.path} src={`${assetUrl(project.id, "reference", slot.id)}&v=${encodeURIComponent(slot.asset.path)}`} alt={`${slot.name} reference`} /> : <ImagePlus size={27} />}<span>{slot.kind}</span></div><div className="agent-slot-copy"><h3>{slot.name}</h3><p>{slot.description}</p><small>{slot.asset ? `${slot.asset.name} · ${referenceSize(slot.asset.bytes)}` : slot.audios?.length ? `${slot.audios.length} voice reference(s)` : "Optional · ignored until supplied"}</small><div className="agent-slot-actions"><label className={`h3-button secondary ${busy ? "disabled" : ""}`}><input className="visually-hidden" type="file" aria-label={`Upload reference for ${slot.name}`} accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(slot.id, file); event.target.value = ""; }} />{uploading === slot.id ? <LoaderCircle size={14} className="spin" /> : <ImagePlus size={14} />}{slot.asset ? "Replace image" : "Add image"}</label><label className="h3-button secondary"><input className="visually-hidden" type="file" aria-label={`Upload voice reference for ${slot.name}`} accept=".wav,.mp3,.m4a,.flac,.ogg" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(slot.id, file, "audio"); event.target.value = ""; }} />{slot.audios?.length ? "Replace voice" : "Add voice"}</label>{Boolean(slot.audios?.length) && <button className="text-button" disabled={busy} onClick={() => void upload(slot.id, undefined, "audio")}>Remove voice</button>}{slot.asset && <button className="icon-button" aria-label={`Remove image for ${slot.name}`} disabled={busy} onClick={() => void upload(slot.id)}><Trash2 size={14} /></button>}{slot.characterId && <button className="text-button" disabled={busy} onClick={() => setClearingLibraryAsset(slot.id)}>Remove selected library asset for {slot.name}</button>}</div>{clearingLibraryAsset === slot.id && <div className="h3-feedback" role="group" aria-label={`Clear library selection for ${slot.name} confirmation`}><p>Clear the selected library asset and its images, voices and links? This reference slot and its clip selections remain. The item stays in the library.</p><button className="h3-button secondary" disabled={busy} onClick={() => void clearLibraryAsset(slot.id)}>Clear selected library asset</button><button className="text-button" disabled={busy} onClick={() => setClearingLibraryAsset(undefined)}>Cancel removal</button></div>}<label className="h3-field">Use saved {slot.kind}<select aria-label={`Choose ${slot.kind} for ${slot.name}`} disabled={busy} value={slot.characterId || ""} onChange={event => { const characterId = event.target.value; if (characterId) void mutate(async () => { const data = await api("agent/reference", { projectId: project.id, slotId: slot.id, characterId }); accept(data.project); }); }}><option value="">Choose a saved {slot.kind}</option>{characters.filter(item => (item.kind || "character") === slot.kind).map(character => <option key={character.id} value={character.id}>{character.name}</option>)}</select></label>{(slot.images?.length || 0) > 1 && <small>{slot.images!.length} image references</small>}{slot.audios?.map((audio,index) => <div key={audio.path}><audio aria-label={`${slot.name} voice ${index+1}`} controls preload="metadata" src={`/api/agent/media?projectId=${project.id}&kind=audio&id=${slot.id}&index=${index}&v=${encodeURIComponent(audio.path)}`} />{isWan && <label className="h3-field">Public voice URL for {slot.name} #{index + 1}<input aria-label={`Public voice URL for ${slot.name} ${index + 1}`} type="url" key={`${audio.path}-${audio.publicUrl || ""}`} defaultValue={audio.publicUrl || ""} placeholder="https://.../voice.wav" disabled={busy} onBlur={event => { const publicUrl = event.target.value.trim(); if (publicUrl !== (audio.publicUrl || "")) void mutate(async () => { const data = await api("agent/reference", { projectId: project.id, slotId: slot.id, audioIndex: index, publicUrl }); accept(data.project); }); }} /></label>}</div>)}</div></article>)}</div> : <p className="h3-hint">This scene has no proposed image-reference slots. The agent can generate from the scene text.</p>}
      </section>
      <p className="h3-hint agent-upload-limits">{isWan ? "Wan accepts up to 10 image references and 5 voice URLs. Voice samples must be WAV/MP3, each 1–15 seconds and at most 15 seconds combined. Images are uploaded to API Mart; the H3 inline 6 MB limit does not apply. Images must be 240–8000 pixels per edge, at most 20 MB, and PNG images must have no alpha channel. Voice URLs must point to the same samples provided here." : "Each clip can use up to 9 selected images, 3 audio references and 6 MB combined, including its continuity frame. Compress or replace large references, or choose fewer references for that clip."}</p>
      {!active && referenceIssues.length > 0 && <div id="agent-reference-validation" className="h3-feedback error agent-feedback agent-reference-validation" role="alert" aria-live="polite"><strong>Reduce reference uploads before generating</strong><ul>{referenceIssues.map(issue => <li key={issue.clipId}>{issue.message}</li>)}</ul></div>}
<section className="h3-panel agent-generation"><div><div className="h3-section-title"><span>03</span><div><h2>{project.clips.length ? "Clip sequence" : "Plan clip prompts"}</h2><p>{project.clips.length} {project.clips.length === 1 ? "clip" : "clips"} · {project.clips.reduce((sum, clip) => sum + clip.duration, 0)} seconds planned · {completed} saved locally</p></div></div><div className="agent-settings"><label className="h3-field">Aspect ratio<select value={project.settings.aspectRatio} disabled={busy} onChange={event => void mutate(async () => { const data = await api("agent/project", { projectId: project.id, action: "edit", settings: { ...project.settings, aspectRatio: event.target.value } }); accept(data.project); })}>{ratios.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}</select></label>{isWan ? <><label className="h3-field">Wan duration<select aria-label="Wan duration mode" value={project.settings.wanDurationMode || "auto"} disabled={busy} onChange={event => void mutate(async () => { const data = await api("agent/project", { projectId: project.id, action: "edit", settings: { ...project.settings, wanDurationMode: event.target.value } }); accept(data.project); })}><option value="auto">Automatic · Wan decides (up to 30s)</option><option value="fixed">Fixed · use planned clip duration</option></select></label><label className="h3-field">Wan resolution<select aria-label="Wan resolution" value={project.settings.wanResolution || "720P"} disabled={busy} onChange={event => void mutate(async () => { const data = await api("agent/project", { projectId: project.id, action: "edit", settings: { ...project.settings, wanResolution: event.target.value } }); accept(data.project); })}>{["480P", "720P", "1080P"].map(value => <option key={value} value={value}>{value}</option>)}</select></label></> : <><label className="h3-field">Resolution<select value={project.settings.megapixels} disabled={busy} onChange={event => void mutate(async () => { const data = await api("agent/project", { projectId: project.id, action: "edit", settings: { ...project.settings, megapixels: Number(event.target.value) } }); accept(data.project); })}>{[0.5, 1, 1.25, 1.5, 1.75, 2, 4].map(value => <option key={value} value={value}>{value} MP</option>)}</select></label><label className="h3-field">Sampling steps<input aria-label="Sampling steps" type="number" min={1} max={100} key={`${project.id}-${project.settings.steps}`} defaultValue={project.settings.steps} disabled={busy} onBlur={event => { const steps = Number(event.target.value); if (!Number.isInteger(steps) || steps < 1 || steps > 100) { setError("Sampling steps must be a whole number from 1 to 100."); event.target.value = String(project.settings.steps); return; } if (steps !== project.settings.steps) void mutate(async () => { const data = await api("agent/project", { projectId: project.id, action: "edit", settings: { ...project.settings, steps } }); accept(data.project); }); }} /></label></>}</div></div><div className="agent-run-actions">{active ? <button className="h3-button secondary" disabled={mutating} onClick={() => void mutate(async () => { const data = await api("agent/run", { projectId: project.id, action: "pause" }); accept(data.project); })}><Pause size={16} />Pause generation</button> : !project.clips.length ? <button className="h3-button" disabled={busy || !canPlan || !model || !project.script.trim() || (!project.referencesIdentified && !project.references.length) || (isWan && !supplied)} onClick={() => void planClips()}><Sparkles size={16} />{mutating ? "Planning prompts…" : "Understand references & plan clips"}</button> : <p>Review each prompt below and generate clips individually. Video provider charges apply.</p>}</div></section>
      {!active && project.status === "paused" && !project.error && completed > 0 && completed < project.clips.length && <p className="h3-feedback agent-feedback" role="status">Clip saved. Review its video and last frame, then generate the next clip when ready.</p>}
      <div className="agent-progress" aria-label="Video generation progress"><span style={{ width: `${100 * completed / Math.max(1, project.clips.length)}%` }} /></div>
      <div className="agent-clips">{project.clips.map((clip, index) => {
        const draft = drafts[clip.id] || clip;
        const retryRefs = promptReferences(clip);
        const revisedText = promptText(clip);
        const sequential = needsPreviousPrompt(project, clip);
        const previousFinished = project.clips[index - 1]?.status === "complete" && Boolean(project.clips[index - 1]?.frame);
        const contextEdited = Boolean(drafts[clip.id]) || JSON.stringify(retryRefs) !== JSON.stringify(clip.revision?.referenceIds ?? clip.referenceIds);
        const promptReady = previousPromptAvailable(project, clip) && (!sequential || !contextEdited);
        const deferred = sequential && !clip.promptContextKey && !clip.compiledPrompt;
        const editable = ["pending", "awaiting-approval", "complete", "failed"].includes(clip.status) && (["complete", "failed"].includes(clip.status) || !(clip.requestId || clip.jobId || clip.source));
        const locked = busy || Boolean(clip.requestId || clip.jobId || clip.status === "complete");
        const bindings = [...referenceBindings(project, { ...draft, referenceIds: retryRefs }), ...audioBindings(project, { ...draft, referenceIds: retryRefs })];
        const continuity = previousFrameDecision(draft);
        const budget = clipReferenceBudget(editedProject!, { ...draft, referenceIds: retryRefs });
        return <article key={clip.id} className={`h3-panel agent-clip ${clip.status === "complete" ? "complete" : ""}`}><div className="agent-clip-heading"><span className="agent-clip-number">{String(index + 1).padStart(2, "0")}</span><div><h3>{clip.title}</h3><p>{clip.media ? `${clip.media.duration.toFixed(2)}s actual` : isWan && project.settings.wanDurationMode !== "fixed" ? `Auto duration · ~${clip.duration}s planned` : `${clip.duration}s`} · {bindings.length} supplied references{continuity ? " · continues previous clip" : ""}</p></div><span className={`h3-status ${clip.status === "complete" ? "completed" : ""}`}>{["preparing", "submitting", "queued", "rendering", "saving"].includes(clip.status) && active && <LoaderCircle size={11} className="spin" />}{clip.status.replaceAll("-", " ").toUpperCase()}</span></div>
          <div className="agent-clip-grid"><div>{sequential && <section className="agent-sequential-prompt"><p className="h3-hint">{!previousFinished ? "This prompt will be planned after the previous clip finishes, using its actual last frame." : !promptReady ? "Plan or refresh this prompt using the previous clip’s current last frame before generating." : "Prompt planned using the previous clip’s actual last frame. Review it before generating."}</p>{previousFinished && <button className="h3-button secondary" disabled={busy || !canPlan || !model || !editable} onClick={() => void planFollowingPrompt(clip)}><Sparkles size={14} />{promptReady ? "Refresh prompt from last frame" : "Plan prompt from last frame"}</button>}{clip.outline && <details><summary>Planned story beats</summary><p className="h3-hint">{clip.outline}</p></details>}{clip.promptPlanError && <p className="h3-feedback error">{clip.promptPlanError}</p>}</section>}<label className="h3-field">Prompt for clip {index + 1}<textarea aria-label={`Prompt for clip ${index + 1}`} value={deferred ? "" : revisedText} placeholder={deferred ? "Waiting for the previous clip to finish before writing this prompt…" : undefined} maxLength={5000} disabled={busy || !editable || !promptReady} rows={7} onChange={event => setRevisionEdits(current => ({ ...current, [clip.id]: { ...current[clip.id], prompt: event.target.value } }))} /></label><div className="agent-clip-options"><label className="h3-field">Clip {index + 1} {isWan && project.settings.wanDurationMode !== "fixed" ? "estimated duration" : "duration"}<input aria-label={`Clip ${index + 1} duration`} type="number" min={2} max={isWan ? 30 : 10} step={isWan ? 1 : 0.5} value={draft.duration} disabled={locked} onChange={event => edit(clip, { duration: Number(event.target.value) })} /></label><label className="h3-field agent-continuity-choice">Frame continuity<select aria-label={`Frame continuity for clip ${index + 1}`} value={draft.continuityMode || "auto"} disabled={locked || index === 0} onChange={event => { const mode = event.target.value as "auto" | "on" | "off"; const next = { ...draft, autoContinuation: draft.autoContinuation ?? draft.continuation, continuityMode: mode }; edit(clip, { autoContinuation: next.autoContinuation, continuityMode: mode, continuation: previousFrameDecision(next) }); }}><option value="auto">Auto · {previousFrameDecision({ ...draft, continuityMode: "auto" }) ? "use previous frame" : "start a new shot"}</option><option value="on">Use previous last frame</option><option value="off">Start a new shot</option></select></label></div>
          <p className="h3-hint agent-frame-decision">{(draft.continuityMode || "auto") === "auto" ? "Agent decision" : "Manual override"}: {index === 0 ? "start the sequence" : continuity ? "use the previous clip’s last frame" : "start a new shot"}.{(draft.continuityMode || "auto") === "auto" && draft.continuityReason ? ` ${draft.continuityReason}` : ""}</p><p className="h3-hint">{bindings.length ? bindings.map(binding => `${binding.tag} → ${binding.name}`).join(" · ") : "No supplied image references for this clip; empty slots are omitted."}</p>
          <p id={`reference-budget-${clip.id}`} className={`h3-hint agent-reference-budget ${budget.error && (Boolean(clip.revision) || (!clip.jobId && !clip.source && clip.status !== "complete")) ? "over-limit" : ""}`}>{isWan ? `References: ${budget.count} / 10 images · ${budget.audioCount} / 5 voices` : `Reference upload: ${referenceSize(budget.bytes)} / 6 MB · ${budget.count} / 9 images.`}{budget.frameBytes > 0 && " Includes the previous clip’s last frame."}{budget.pendingFrame && (isWan ? " The previous clip’s last frame will be uploaded when available." : " The previous clip’s last frame will be added when available and also counts toward 6 MB.")}</p>
          <details className="agent-ref-choice" aria-describedby={`reference-budget-${clip.id}`}><summary>References for clip {index + 1}</summary>{project.references.map(slot => <label key={slot.id}><input aria-label={`Include ${slot.name} in clip ${index + 1}`} type="checkbox" checked={retryRefs.includes(slot.id)} disabled={busy || !editable || (!(slot.asset || slot.images?.length || slot.audios?.length) && !retryRefs.includes(slot.id))} onChange={event => setRevisionEdits(current => ({ ...current, [clip.id]: { ...current[clip.id], referenceIds: event.target.checked ? [...retryRefs, slot.id] : retryRefs.filter(id => id !== slot.id) } }))} />{slot.name}<small>{slot.asset || slot.audios?.length ? "provided" : "ignored — no media"}</small></label>)}</details>
          {editable && <div className="agent-prompt-editor"><label className="h3-field">Comments for clip {index + 1}<textarea aria-label={`Comments for clip ${index + 1}`} rows={3} maxLength={4000} disabled={busy} value={feedback[clip.id] ?? ""} onChange={event => setFeedback(current => ({ ...current, [clip.id]: event.target.value }))} placeholder="Describe changes to action, lighting, dialogue or framing…" /></label><div className="agent-prompt-actions"><button className="h3-button secondary" disabled={busy || (sequential && !previousFinished) || !canPlan || !model || !feedback[clip.id]?.trim() || !revisedText.trim()} onClick={() => void revise(clip, feedback[clip.id] || "")}><Sparkles size={14} />Apply comments</button><button className="h3-button secondary" disabled={busy || !promptReady || !revisedText.trim() || retryRefs.length > 9} onClick={() => void mutate(async () => { await savePrompt(clip); setNotice("Prompt and reference choices saved."); })}><Check size={14} />Save prompt</button><button className="h3-button" disabled={busy || !promptReady || !canPlan || !model || !revisedText.trim() || Boolean(budget.error) || (continuity && !project.clips[index - 1]?.frame)} onClick={() => void generateClip(clip)}><Play size={14} />{clip.status === "complete" || clip.status === "failed" ? "Regenerate clip" : "Generate clip"} {index + 1}</button></div><p className="h3-hint">Generate saves and submits the prompt above. Comments affect it only after Apply comments. {continuity && !project.clips[index - 1]?.frame ? "Generate the previous clip first to provide its last frame." : "Previous takes are kept when regenerating."}</p>{budget.error && <p className="h3-feedback error">{budget.error}</p>}</div>}
          {clip.status === "recoverable" && <div className="agent-prompt-actions"><button className="h3-button secondary" disabled={busy || !model || !canPlan} onClick={() => void resumeClip(clip)}><Play size={14} />Resume clip {index + 1}</button><button className="h3-button secondary" disabled={busy || !model || !canPlan || Boolean(budget.error)} onClick={() => void mutate(async () => { const data = await api("agent/run", { projectId: project.id, action: "retry", clipId: clip.id, model, reasoningEffort }); accept(data.project); })}>Retry clip {index + 1}</button><p className="h3-hint">Resume recovers the existing job. Retry starts a new paid generation after checking the saved job.</p></div>}
          {clip.continuityOutdated && <p className="h3-feedback error">The preceding clip or frame changed. Regenerate this clip to update continuity.</p>}
          {clip.versions?.length ? <details className="agent-versions"><summary>Previous generations ({clip.versions.length})</summary>{clip.versions.map((take, takeIndex) => <div key={takeIndex}><span>Take {takeIndex + 1}</span>{take.clip.video && <a className="text-button" href={`${assetUrl(project.id, "video", clip.id, true)}&version=${takeIndex}`} download>Download previous video {takeIndex + 1}</a>}{take.clip.frame && <a className="text-button" href={`${assetUrl(project.id, "frame", clip.id, true)}&version=${takeIndex}`} download>Download previous frame {takeIndex + 1}</a>}</div>)}</details> : null}
          {clip.jobId && <p className="h3-hint">{clip.endpoint === "apimart" ? "API Mart task" : "RunPod job"} <code>{clip.jobId}</code></p>}{clip.error && <div className="h3-feedback error">{clip.error}</div>}
          {!active && ["submission-unknown", "submitting"].includes(clip.status) && <div className="agent-recovery"><a className="text-button" href={isWan ? "https://apimart.ai" : "https://console.runpod.io/serverless"} target="_blank" rel="noreferrer">{isWan ? "Review API Mart tasks" : "Review RunPod console"} <ArrowRight size={13} /></a><label className="h3-field">Recovered job ID for clip {index + 1}<input value={recovery[clip.id] || ""} onChange={event => setRecovery(current => ({ ...current, [clip.id]: event.target.value }))} /></label><button className="h3-button secondary" disabled={busy || !recovery[clip.id]?.trim()} onClick={() => void mutate(async () => { const data = await api("agent/project", { projectId: project.id, action: "recover", clipId: clip.id, jobId: recovery[clip.id].trim() }); accept(data.project); })}><RefreshCw size={14} />Recover existing job</button><label className="agent-continuity"><input type="checkbox" checked={Boolean(reviewed[clip.id])} onChange={event => setReviewed(current => ({ ...current, [clip.id]: event.target.checked }))} />I checked {isWan ? "API Mart" : "RunPod"} and no job was created</label><button className="text-button" disabled={busy || !reviewed[clip.id]} onClick={() => void mutate(async () => { const data = await api("agent/project", { projectId: project.id, action: "retry", clipId: clip.id, reviewed: true }); accept(data.project); })}>Resolve and allow a new submission</button></div>}
          </div><div className="agent-clip-preview">{clip.video ? <><video controls playsInline preload="metadata" src={`${assetUrl(project.id, "video", clip.id)}&v=${encodeURIComponent(clip.video.path)}`} /><a className="text-button" href={assetUrl(project.id, "video", clip.id, true)} download><ArrowDownToLine size={14} />Download clip {index + 1}</a>{clip.media && <p className="h3-hint">{clip.media.width} × {clip.media.height} · {clip.media.duration.toFixed(2)}s · {clip.media.fps} FPS</p>}</> : <div className="agent-clip-placeholder"><Film size={29} /><span>{clip.status === "pending" ? "Ready for generation" : clip.status.replaceAll("-", " ")}</span></div>}{clip.frame && <div className="agent-last-frame"><img src={`${assetUrl(project.id, "frame", clip.id)}&v=${encodeURIComponent(clip.frame.path)}`} alt={`Last frame of clip ${index + 1}`} /><div><strong>{clip.frameReplaced ? "Last frame replaced" : "Last frame saved"}</strong><p>{isWan ? "Available as the next clip’s continuity reference." : "Available as the next clip’s first-frame guide."}</p><a className="text-button" href={assetUrl(project.id, "frame", clip.id, true)} download>Download frame</a></div></div>}{clip.frame && clip.status === "complete" && <div className="agent-frame-actions"><label className={`h3-button secondary ${busy ? "disabled" : ""}`}><input className="visually-hidden" type="file" aria-label={`Replace last frame for clip ${index + 1}`} accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void replaceFrame(clip.id, file); event.target.value = ""; }} /><ImagePlus size={14} />Replace last frame</label>{clip.frameReplaced && <button className="text-button" disabled={busy} onClick={() => void replaceFrame(clip.id)}>Restore extracted frame</button>}<p className="h3-hint">PNG, JPEG or WebP under 4 MiB. {isWan ? "Used as a reference image when continuity is on." : "Used as the next clip’s first-frame guide when continuity is on."}{active ? " Pause the agent before replacing it." : ""}</p></div>}{clip.firstFrameFrom && <p className="h3-hint">{clip.endpoint === "apimart" ? "Continuity reference from clip" : "First-frame guide from clip"} {project.clips.findIndex(previous => previous.id === clip.firstFrameFrom) + 1}.</p>}</div></div>
        </article>;
      })}</div>
      <div className="agent-folder"><FolderOpen size={17} /><div><strong>Saved on this computer</strong><code>{project.folder}</code><p>One MP4 per completed take, references, extracted frames and request records stay here across reloads and server restarts. Unfinished sources are kept for recovery.</p></div></div>
    </>}
    {!project && folder && <p className="h3-hint agent-default-folder">Projects will be saved in <code>{folder}</code></p>}
    <dialog ref={dialog} className="modal h3-dialog" onCancel={event => { event.preventDefault(); setKey(""); setConnectionOpen(false); }}><div className="modal-heading"><h2>{isWan ? "API Mart connection" : "RunPod connection"}</h2><button className="icon-button" aria-label="Close agent RunPod connection" onClick={() => { setKey(""); setConnectionOpen(false); }}><X size={18} /></button></div><p className="modal-description">{isWan ? "Use APIMART_API_KEY in .env.local or save an encrypted key on this computer." : "Use the H3 worker endpoint. A key in .env.local works here too."}</p><form onSubmit={event => void saveConnection(event)}>{!isWan && <label className="h3-field">Agent endpoint ID<input required pattern="[A-Za-z0-9_-]{1,64}" value={endpoint} onChange={event => setEndpoint(event.target.value)} /></label>}<label className="h3-field">{isWan ? "API Mart API key" : "Agent RunPod API key"}<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={selectedConnection?.configured ? "Already configured — leave blank to keep it" : "Paste your video provider API key"} /></label><p className="h3-hint">{selectedConnection?.configured ? "A key is configured." : "No key configured."}{selectedConnection?.environmentKey ? " Your environment key is available." : ""}</p>{error && <div className="h3-feedback error" role="alert">{error}</div>}<button className="h3-button" disabled={savingKey}>{savingKey ? "Saving…" : "Save connection"}</button></form></dialog>
  </div>;
}
