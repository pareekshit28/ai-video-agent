"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Film, FolderOpen, LoaderCircle, Menu, RefreshCw, Settings2, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { VideoStudio } from "./video-studio";
import { StorageSettings } from "./storage-settings";
import { LibraryTab } from "./characters-tab";
import { VideoAgent } from "./video-agent";

import { SceneBrowser } from "./scene-browser";
import type { CodexInfo } from "@/lib/codex";
import { selectTabStatus, type GenerationTabStatus } from "@/lib/generation-tab-status";
import { useGenerationTabTicker } from "./use-generation-tab-status";

const disconnected: CodexInfo = { connected: false, imageGeneration: false, models: [], skills: [] };

export function VideoWorkspace() {
  const [view, setView] = useState<"video" | "agent" | "characters" | "settings">("agent");
  const [projectSelection, setProjectSelection] = useState<{ id: string; version: number } | null>(null);
  const [projects, setProjects] = useState<{ id: string; title: string }[]>([]);
  const [selectedProject, setSelectedProject] = useState("");
  const [projectsReady, setProjectsReady] = useState(false);
  const [choosingProject, setChoosingProject] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentStatus, setAgentStatus] = useState<GenerationTabStatus | null>(null);
  const [studioStatus, setStudioStatus] = useState<GenerationTabStatus | null>(null);
  const [lastGenerationView, setLastGenerationView] = useState<"agent" | "video">("agent");
  useEffect(() => { if (view === "agent" || view === "video") setLastGenerationView(view); }, [view]);
  useGenerationTabTicker(selectTabStatus(agentStatus, studioStatus, lastGenerationView === "video"));
  const [codex, setCodex] = useState<CodexInfo>(disconnected);
  const [loading, setLoading] = useState(true);
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const [projectName, setProjectName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const scenesDialog = useRef<HTMLDialogElement>(null);
  const [scenesOpen, setScenesOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [notice, setNotice] = useState("");
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const refreshProjects = useCallback(async () => {
    const response = await fetch("/api/projects", { cache: "no-store" }); const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load projects.");
    setProjects(data.projects); return data.projects as { id: string; title: string }[];
  }, []);
  async function chooseProject(id: string) {
    setChoosingProject(true);
    try {
      if (id) { const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "organize", projectId: id }) }); const data = await response.json(); if (!response.ok) { if (data.code === "storage_busy") setError(data.error + " Pause generation, then reload to finish organizing."); else throw new Error(data.error || "Could not organize project files."); } }
      if (id !== selectedProject) { setProjectSelection(null); setSelectedProject(id); }
      localStorage.setItem("video-workspace-project", id); await refreshProjects();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open the project."); throw cause; }
    finally { setChoosingProject(false); }
  }
  useEffect(() => {
    void refreshProjects().then(async items => {
      const saved = localStorage.getItem("video-workspace-project");
      const id = items.find(item => item.id === saved)?.id || items[0]?.id || "";
      if (id) { const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "organize", projectId: id }) }); const data = await response.json(); if (!response.ok) { if (data.code === "storage_busy") setError(data.error + " Pause generation, then reload to finish organizing."); else throw new Error(data.error || "Could not organize project files."); } }
      setSelectedProject(id); setProjectsReady(true);
    }).catch(cause => { setError(cause.message); setProjectsReady(true); });
  }, [refreshProjects]);
  async function createProject() {
    if (creating) return; setCreating(true); setCreateError("");
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", title: projectName.trim() }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not create project.");
      await chooseProject(data.project.id); setCreateOpen(false); setView("agent");
    } catch (cause) { setCreateError(cause instanceof Error ? cause.message : "Could not create project."); }
    finally { setCreating(false); }
  }
  async function deleteProject() {
    if (!deleteTarget || deleting) return; setDeleting(true); setDeleteError("");
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", projectId: deleteTarget.id, title: deleteTarget.title }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not delete project.");
      const remaining = projects.filter(project => project.id !== deleteTarget.id);
      setProjects(remaining); setProjectSelection(null);
      if (remaining[0]) { setSelectedProject(remaining[0].id); localStorage.setItem("video-workspace-project", remaining[0].id); await chooseProject(remaining[0].id).catch(() => undefined); }
      else { setSelectedProject(""); localStorage.removeItem("video-workspace-project"); }
      setDeleteTarget(null); setView("agent");
      setNotice(`Deleted “${deleteTarget.title}”. Files were moved to ${data.deleted.trashFolders?.join(", ") || "the storage folder’s .trash directory"}.`);
    } catch (cause) { setDeleteError(cause instanceof Error ? cause.message : "Could not delete project."); }
    finally { setDeleting(false); }
  }
  const refreshConnection = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/agent/codex", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not check Codex CLI. Try again.");
      setCodex(data);
      setModel(current => data.models.some((item: { slug: string }) => item.slug === current) ? current : data.models[0]?.slug || "");
    } catch (cause) {
      setCodex(disconnected); setModel("");
      setError(cause instanceof Error ? cause.message : "Could not check Codex CLI. Try again.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("workspace") === "video") setView("video");
    void refreshConnection();
  }, [refreshConnection]);
  useEffect(() => { if (createOpen) dialog.current?.showModal(); else dialog.current?.close(); }, [createOpen]);

  useEffect(() => { if (scenesOpen) scenesDialog.current?.showModal(); else scenesDialog.current?.close(); }, [scenesOpen]);
  useEffect(() => { if (deleteTarget) deleteDialog.current?.showModal(); else deleteDialog.current?.close(); }, [deleteTarget]);

  return <div className="workspace">
    {sidebar && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebar(false)} />}
    <aside className={"sidebar " + (sidebar ? "is-open" : "")}>
      {sidebar && <button className="icon-button mobile-sidebar-close" aria-label="Close navigation menu" onClick={() => setSidebar(false)}><X size={18} /></button>}
      <a href="/" className="brand"><span className="brand-mark"><Sparkles size={21} strokeWidth={1.8} /></span><span>prompt<span className="brand-light">studio</span><span className="brand-dot">.</span></span></a>
      <label className="sidebar-project-chooser"><span>PROJECT</span><select aria-label="Active project" value={selectedProject} disabled={!projectsReady || choosingProject || agentBusy || deleting} onChange={event => { if (event.target.value === "__manage") { setProjectName(""); setCreateError(""); setCreateOpen(true); setSidebar(false); } else if (event.target.value === "__delete") { const project = projects.find(item => item.id === selectedProject); if (project) { setDeleteTarget(project); setDeleteError(""); setSidebar(false); } } else void chooseProject(event.target.value).catch(() => undefined); }}>{!selectedProject && <option value="" disabled>{projectsReady ? "Create a project to get started" : "Loading projects…"}</option>}{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}<option value="__manage">Create new project…</option>{selectedProject && <option value="__delete">Delete current project…</option>}</select></label>
      <div className="sidebar-label">YOUR WORKSPACE</div>
      <button className={"nav-item " + (view === "agent" ? "active" : "")} onClick={() => { setView("agent"); setSidebar(false); }}><Sparkles size={17} />AI Video Agent</button>
      <button className={"nav-item " + (view === "video" ? "active" : "")} onClick={() => { setView("video"); setSidebar(false); }}><Film size={17} />Video Studio</button>
      <button className={"nav-item " + (view === "characters" ? "active" : "")} onClick={() => { setView("characters"); setSidebar(false); }}><Film size={17} />Library</button>
      <button className={"nav-item " + (view === "settings" ? "active" : "")} onClick={() => { setView("settings"); setSidebar(false); }}><Settings2 size={17} />Settings</button>
      <div className="sidebar-spacer" />
      <div className="sidebar-bottom">
        <div className="local-note"><span className="status-dot" />A workspace on your computer</div>
        <button className="account-button" onClick={() => setView("settings")}><span className="avatar"><ShieldCheck size={18} /></span><span className="account-text"><strong>Codex CLI</strong><span>{loading ? "Checking connection" : codex.connected ? "Connected on this computer" : "Sign in through Codex CLI"}</span></span><ChevronDown size={15} /></button>
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebar(true)}><Menu size={21} /></button><span className="page-label">{view === "agent" ? "AI Video Agent" : view === "characters" ? "Library" : view === "settings" ? "Settings" : "Video Studio"}</span><span className="header-divider" /><span className="private-label"><ShieldCheck size={13} />Local workspace</span></div>
        <div className="topbar-right"><span className={"connection-badge " + (codex.connected ? "connected" : "")}><span className="status-dot" />{loading ? "Checking connection" : codex.connected ? "Codex connected" : "Codex not connected"}</span><button className="icon-button" aria-label="Connection settings" onClick={() => setView("settings")}><Settings2 size={18} /></button></div>
      </header>
      {error && <div className="alert workspace-alert" role="alert"><div><strong>Connection notice</strong><p>{error}</p><button className="text-button" disabled={loading} onClick={() => void refreshConnection()}>Retry connection</button></div><button className="icon-button" aria-label="Dismiss message" onClick={() => setError("")}><X size={17} /></button></div>}
      {notice && <div className="workspace-alert h3-feedback" role="status">{notice}<button className="icon-button" aria-label="Dismiss notice" onClick={() => setNotice("")}><X size={17} /></button></div>}
      {projectsReady && !selectedProject && view !== "settings" && <div className="video-studio"><div className="video-title"><div><h1>Create your first project</h1><p>Create a project to organize your scenes, references and videos.</p></div></div><button className="h3-button" onClick={() => { setProjectName(""); setCreateError(""); setCreateOpen(true); }}>Create new project</button></div>}
      {selectedProject && view === "agent" && <div className="scene-browser-action"><button className="text-button" disabled={agentBusy} onClick={() => setScenesOpen(true)}><FolderOpen size={16} />Manage scenes</button></div>}
      {projectsReady && selectedProject && <LibraryTab key={`library-${selectedProject}`} collectionId={selectedProject} visible={view === "characters"} />}
      {selectedProject && <VideoStudio key={`studio-${selectedProject}`} collectionId={selectedProject} visible={view === "video"} staged={null} onStatusChange={setStudioStatus} />}
      {projectsReady && selectedProject && <VideoAgent key={`agent-${selectedProject}`} collectionId={selectedProject} onBusyChange={setAgentBusy} onStatusChange={setAgentStatus} visible={view === "agent"} selection={projectSelection} codex={codex} model={model} onModelChange={setModel} openConnection={() => setView("settings")} />}
      {view === "settings" && <div className="workspace-settings">
        <h1>Settings</h1><p className="modal-description">Shared connection and storage settings for all projects.</p>
        <section className="settings-section"><h2>Codex connection</h2><p>{loading ? "Checking connection…" : codex.connected ? "Connected and ready." : "Install Codex CLI, run codex login in a terminal, then refresh the connection."}</p>
        {codex.connected && <p>{codex.models.length} models · {codex.skills.length} skills available</p>}
        <button className="connection-button" disabled={loading} onClick={() => void refreshConnection()}>{loading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}Refresh connection</button></section>
        <StorageSettings open={true} />
      </div>}
    </main>
    {deleteTarget && <dialog ref={deleteDialog} className="modal" onCancel={event => { event.preventDefault(); if (!deleting) setDeleteTarget(null); }}>
      <div className="modal-heading"><h2>Delete project?</h2><button className="icon-button" aria-label="Close delete dialog" disabled={deleting} onClick={() => setDeleteTarget(null)}><X size={20} /></button></div>
      <p>Delete <strong>{deleteTarget.title}</strong> and all of its scenes, clips, frames, references and library assets?</p>
      <p className="h3-hint">The project will disappear from the app. Its files, including copies in earlier storage locations, will be moved into a local .trash folder for recovery. This does not cancel Runpod jobs.</p>
      {deleteError && <p className="h3-feedback error" role="alert">{deleteError}</p>}
      <div className="project-actions"><button className="h3-button" disabled={deleting} onClick={() => void deleteProject()}><Trash2 size={16} />{deleting ? "Deleting…" : "Delete project"}</button><button className="text-button" disabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</button></div>
    </dialog>}
    {scenesOpen && <dialog ref={scenesDialog} className="modal scenes-modal" onCancel={event => { event.preventDefault(); setScenesOpen(false); }}><div className="modal-heading"><h2>Scenes</h2><button className="icon-button" aria-label="Close scenes" onClick={() => setScenesOpen(false)}><X size={20} /></button></div><SceneBrowser visible={true} projectId={selectedProject} onOpen={id => { setProjectSelection({ id, version: Date.now() }); setScenesOpen(false); setView("agent"); }} /></dialog>}
    {createOpen && <dialog ref={dialog} className="modal" onCancel={event => { event.preventDefault(); if (!creating) setCreateOpen(false); }}>
      <div className="modal-heading"><h2>Create new project</h2><button className="icon-button" aria-label="Close dialog" disabled={creating} onClick={() => setCreateOpen(false)}><X size={20} /></button></div>
      <form onSubmit={event => { event.preventDefault(); void createProject(); }}>
        <label className="h3-field">Project name<input autoFocus required maxLength={120} value={projectName} onChange={event => setProjectName(event.target.value)} disabled={creating} /></label>
        <p className="h3-hint">Files will be saved in your base location under this project name.</p>
        {createError && <p className="h3-feedback error" role="alert">{createError}</p>}
        <button className="h3-button" type="submit" disabled={creating || !projectName.trim()}>{creating ? "Creating…" : "Create project"}</button>
      </form>
    </dialog>}
  </div>;
}
