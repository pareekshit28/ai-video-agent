"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderOpen, LoaderCircle, Pencil, Plus, RefreshCw, Search } from "lucide-react";

type Project = { id: string; title: string; updatedAt: number; sceneCount: number; clipCount: number; completed: number; active: boolean };
type Scene = { id: string; collectionId?: string; title: string; updatedAt: number; status: string; clipCount: number; completed: number; active: boolean };
async function request(path: string, body?: unknown) {
  const response = await fetch(`/api/${path}`, { cache: "no-store", ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load projects."); return data;
}
export function SceneBrowser({ visible, projectId, onOpen }: { visible: boolean; projectId?: string; onOpen: (id: string, collectionId?: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const selected = projectId || "";
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { const [parents, children] = await Promise.all([request("projects"), request("agent/projects")]); setProjects(parents.projects); setScenes(children.projects); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load projects."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (visible) void refresh(); }, [visible, refresh]);
  useEffect(() => { setSearch(""); }, [projectId]);
  async function create(event: React.FormEvent) {
    event.preventDefault(); if (saving || !title.trim()) return;
    setSaving(true); setError("");
    try {
      const data = await request("agent/projects", { action: "create", title, script, ...(selected ? { collectionId: selected } : {}) });
      await refresh(); onOpen(data.project.id, selected);
      setCreating(false); setTitle(""); setScript("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create this item."); }
    finally { setSaving(false); }
  }
  async function rename(event: React.FormEvent) {
    event.preventDefault(); if (saving || !renaming || !name.trim()) return;
    setSaving(true); setError("");
    try { await request("agent/projects", { action: "rename", projectId: renaming, title: name }); setRenaming(null); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not rename this item."); }
    finally { setSaving(false); }
  }
  async function assign(sceneId: string) {
    if (!selected || !sceneId || saving) return; setSaving(true); setError("");
    try { await request("projects", { action: "assign", projectId: selected, sceneId }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add this scene."); }
    finally { setSaving(false); }
  }
  const parent = projects.find(item => item.id === selected);
  const unassigned = scenes.filter(scene => !scene.collectionId);
  const children = scenes.filter(scene => (scene.collectionId || "") === selected);
  const items = children.filter(item => item.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const noun = "scene";
  return <div className="video-studio projects-workspace" style={{ display: visible ? undefined : "none" }}>
    
    <div className="video-title"><div><div className="eyebrow">PROJECT → SCENES → CLIPS</div><h1>{parent?.title || "Unassigned scenes"}</h1><p>{"Add scenes to this project, then open a scene in the AI Video Agent."}</p></div><button className="h3-button" disabled={saving || selected === ""} onClick={() => setCreating(true)}><Plus size={16} />New {noun}</button></div>
    {error && <div className="h3-feedback error" role="alert">{error}</div>}
    {creating && <form className="h3-panel project-create" onSubmit={event => void create(event)}>
      <h2>Create a {noun}</h2>
      <label className="h3-field">{"Scene name"}<input autoFocus required maxLength={120} value={title} disabled={saving} onChange={event => setTitle(event.target.value)} placeholder={"Station arrival"} /></label>
      {<label className="h3-field">Script (optional)<textarea rows={4} maxLength={32000} value={script} disabled={saving} onChange={event => setScript(event.target.value)} placeholder="Describe this scene, or write it later in the agent." /></label>}
      <div className="project-actions"><button className="h3-button" disabled={saving || !title.trim()}>{saving ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}{"Create and open scene"}</button><button type="button" className="text-button" disabled={saving} onClick={() => setCreating(false)}>Cancel</button></div>
    </form>}
    <div className="projects-toolbar"><label className="project-search"><Search size={17} /><input aria-label={"Search scenes"} value={search} onChange={event => setSearch(event.target.value)} placeholder={`Search ${noun}s…`} /></label><button className="text-button" disabled={loading || saving} onClick={() => void refresh()}><RefreshCw size={15} className={loading ? "spin" : ""} />Refresh</button></div>
    {selected && unassigned.length > 0 && <label className="h3-field project-import">Add an existing scene<select aria-label="Add an existing scene" disabled={saving} value="" onChange={event => void assign(event.target.value)}><option value="">Choose an unassigned scene</option>{unassigned.map(scene => <option key={scene.id} value={scene.id} disabled={scene.active}>{scene.title}</option>)}</select></label>}
    {loading && !items.length ? <p role="status">Loading {noun}s…</p> : !items.length ? <div className="h3-panel projects-empty"><FolderOpen size={30} /><h2>{search ? `No matching ${noun}s` : "Add your first scene"}</h2><p>{search ? "Try a different name." : "Each scene has its own script, reference slots and clip sequence."}</p></div> : <div className="projects-grid">{items.map(item => <article key={item.id} className="h3-panel project-card">
      <div className="project-card-top"><FolderOpen size={22} /><span className="project-status">{item.active ? "Running" : !item.clipCount ? "Draft" : (item as Scene).status === "complete" ? "Complete" : "Ready"}</span></div>
      {renaming === item.id ? <form className="project-rename" onSubmit={event => void rename(event)}><label className="h3-field">New {noun} name<input autoFocus required maxLength={120} value={name} disabled={saving} onChange={event => setName(event.target.value)} /></label><div className="project-actions"><button className="text-button" disabled={saving || !name.trim()}>Save name</button><button type="button" className="text-button" disabled={saving} onClick={() => setRenaming(null)}>Cancel</button></div></form> : <h2>{item.title}</h2>}
      <p>{item.clipCount ? `${item.completed} of ${item.clipCount} clips saved` : "Scene draft · ready to analyze"}</p>
      {!!item.clipCount && <progress aria-label={`${item.title} clip progress`} value={item.completed} max={item.clipCount} />}
      <p className="project-date">Updated {new Date(item.updatedAt).toLocaleString()}</p>
      <div className="project-actions"><button className="h3-button secondary" disabled={saving} onClick={() => onOpen(item.id, selected || undefined)}><FolderOpen size={15} />Open {noun}</button><button className="text-button" disabled={saving || item.active} aria-label={`Rename ${item.title}`} onClick={() => { setRenaming(item.id); setName(item.title); }}><Pencil size={14} />Rename</button></div>
    </article>)}</div>}
  </div>;
}
