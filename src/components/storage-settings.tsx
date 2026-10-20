"use client";
import { useEffect, useState } from "react";
import { FolderOpen, LoaderCircle } from "lucide-react";

export function StorageSettings({ open }: { open: boolean }) {
  const [folder, setFolder] = useState("");
  const [current, setCurrent] = useState("");
  const [copyExisting, setCopyExisting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setLoading(true); setError("");
    let cancelled = false;
    void fetch("/api/storage", { cache: "no-store" }).then(async response => {
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      if (!cancelled) { setFolder(data.folder); setCurrent(data.folder); setCopyExisting(true); }
    }).catch(cause => { if (!cancelled) setError(cause.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || loading) return; setBusy(true); setError("");
    try {
      const response = await fetch("/api/storage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder, copyExisting }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the folder."); setBusy(false); }
  }
  if (!open) return null;
  return <section className="settings-section">
    <h2>Base location</h2>
    <p className="modal-description">Choose where projects, video clips, frames, image and audio references, and library items are saved.</p>
    <form onSubmit={event => void save(event)}>
      <label className="h3-field">Base location for all projects<input aria-label="Project storage folder" required value={folder} disabled={busy || loading} placeholder="G:\My Drive\AI Video Agent" onChange={event => setFolder(event.target.value)} /></label>
      <p className="h3-hint">Project files are saved under Base location / Project name, including scenes, clips, frames and library references.</p>
      <p className="h3-hint storage-path">Current folder: {loading ? "Loading…" : current}</p>
      <label className="storage-copy"><input type="checkbox" checked={copyExisting} disabled={busy || loading} onChange={event => setCopyExisting(event.target.checked)} />Copy existing projects and library to this folder</label>
      <p className="h3-hint">Original files are kept. If copying is off, existing projects and library items stay in their current folders and remain accessible; new items use this folder.</p>
      <p className="h3-hint">For Google Drive, paste the full path to a folder available on this computer through Google Drive for desktop. Google Drive handles syncing and backup. The app checks that the folder is writable; it cannot confirm cloud sync.</p>
      {error && <p className="h3-feedback error" role="alert">{error}</p>}
      <button type="submit" className="h3-button" disabled={busy || loading || !folder.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />}{busy ? "Saving storage folder…" : "Save storage folder"}</button>
      {busy && <p className="h3-hint" role="status">Large video collections can take a while to copy. The workspace reloads when complete.</p>}
    </form>
  </section>;
}
