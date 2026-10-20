"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Character, LibraryKind } from "@/lib/characters";
import { MAX_REFERENCE_FILE_BYTES } from "@/lib/reference-limits";

export async function encodeReference(file: File) {
  if (!file.size || file.size > MAX_REFERENCE_FILE_BYTES) throw new Error("Each reference must be nonempty and under 4 MiB.");
  const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("Could not read the reference.")); reader.readAsDataURL(file); });
  return { name: file.name, bytes: file.size, base64 };
}
export function LibraryTab({ visible, collectionId = "" }: { visible: boolean; collectionId?: string }) {
  const [kind, setKind] = useState<LibraryKind>("character");
  const label = kind === "character" ? "Character" : kind === "location" ? "Location" : "Prop";
  function clear() { setId(undefined); setName(""); setDescription(""); setImages(undefined); setVoices(undefined); setVoiceUrls([]); setRemoving(undefined); setError(""); }
  const [characters, setCharacters] = useState<Character[]>([]), [name, setName] = useState(""), [description, setDescription] = useState(""), [id, setId] = useState<string>();
  const items = characters.filter(item => (item.kind || "character") === kind);
  const [images, setImages] = useState<File[]>(), [voices, setVoices] = useState<File[]>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [voiceUrls, setVoiceUrls] = useState<string[]>([]);
  const [removing, setRemoving] = useState<string>();
  const voiceNames = voices ? voices.map(file => file.name) : characters.find(item => item.id === id)?.voices.map(asset => asset.name) || [];
  const loadVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    async function list(project: string) {
      const response = await fetch(`/api/characters?collectionId=${encodeURIComponent(project)}`, { cache: "no-store" });
      const data = await response.json(); if (!response.ok) throw new Error(data.error); return data.characters as Character[];
    }
    const saved = await list(collectionId);
    if (version === loadVersion.current) setCharacters(saved);
  }, [collectionId]);
  useEffect(() => { if (visible) void load().catch(cause => setError(cause.message)); return () => { loadVersion.current++; }; }, [visible, load]);
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; setBusy(true); setError("");
    try {
      if ((images?.length || 0) > 9 || (voices?.length || 0) > 3) throw new Error("Use up to 9 images and, for characters, 3 voice samples.");
      if ([...(images || []), ...(voices || [])].reduce((sum, file) => sum + file.size, 0) > 6_000_000) throw new Error("Reference uploads must be at most 6 MB combined.");
      const response = await fetch("/api/characters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...(collectionId ? { collectionId } : {}), kind, name, description, ...(images ? { images: await Promise.all(images.map(encodeReference)) } : {}), ...(kind === "character" ? { voiceUrls: voiceNames.map((_, index) => voiceUrls[index]?.trim() || ""), ...(voices ? { voices: await Promise.all(voices.map(encodeReference)) } : {}) } : {}) }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      // Use the saved record immediately; an older list request must not overwrite it.
      loadVersion.current++;
      const saved = data.character as Character;
      setCharacters(current => [saved, ...current.filter(item => item.id !== saved.id)].sort((a, b) => b.updatedAt - a.updatedAt));
      setId(undefined); setName(""); setDescription(""); setImages(undefined); setVoices(undefined); setVoiceUrls([]); form.reset();
    } catch (cause) { setError(cause instanceof Error ? cause.message : `Could not save ${label.toLowerCase()}.`); } finally { setBusy(false); }
  }
  async function remove(character: Character) {
    if (busy || !collectionId) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/characters", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: character.id, collectionId }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      loadVersion.current++;
      setCharacters(current => current.filter(item => item.id !== character.id));
      if (id === character.id) clear();
      setRemoving(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove this reference."); }
    finally { setBusy(false); }
  }
  async function clone(character: Character) {
    if (busy || !collectionId) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/characters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clone", id: character.id, collectionId }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      loadVersion.current++;
      setCharacters(current => [data.character, ...current.filter(item => item.id !== data.character.id)]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not clone this asset."); }
    finally { setBusy(false); }
  }
  return <div className="video-studio" style={{ display: visible ? undefined : "none" }}>
    <div className="video-title"><div><div className="eyebrow">YOUR LOCAL REFERENCE LIBRARY</div><h1>Library.</h1><p>Save characters, locations and props for reuse in your scene references.</p></div></div>
    <div className="library-tabs" role="tablist" aria-label="Reference library categories">{(["character", "location", "prop"] as const).map(category => <button key={category} type="button" role="tab" aria-selected={kind === category} className={`h3-button ${kind === category ? "" : "secondary"}`} disabled={busy} onClick={() => { clear(); setKind(category); }}>{category === "character" ? "Characters" : category === "location" ? "Locations" : "Props"}</button>)}</div>
    {!collectionId && <p className="h3-feedback">Choose a project in the sidebar to create or edit library assets.</p>}
    {error && <p className="h3-feedback error" role="alert">{error}</p>}
    <form key={`${kind}-${id || "new"}`} className="h3-panel character-form" onSubmit={event => void save(event)}>
      <h2>{`${id ? "Edit" : "Create"} ${label.toLowerCase()}`}</h2>
      <label className="h3-field">{label} name<input aria-label={`${label} name`} required maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <label className="h3-field">Description<textarea aria-label={`${label} description`} maxLength={1000} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} /></label>
      <label className="h3-field">Images (up to 9)<input aria-label={`${label} images`} type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => setImages(Array.from(event.target.files || []))} /></label>
      {kind === "character" && <label className="h3-field">Voice samples (up to 3)<input aria-label="Character voice samples" type="file" multiple accept=".wav,.mp3,.m4a,.flac,.ogg" disabled={busy} onChange={event => { const files = Array.from(event.target.files || []); setVoices(files); setVoiceUrls(files.map(() => "")); }} /></label>}
      {kind === "character" && voiceNames.map((voiceName, index) => <label className="h3-field" key={index}>Public voice URL {index + 1} · {voiceName}<input aria-label={`Character public voice URL ${index + 1}`} type="url" placeholder="https://.../voice.wav" value={voiceUrls[index] || ""} disabled={busy} onChange={event => setVoiceUrls(current => { const next = [...current]; next[index] = event.target.value; return next; })} /></label>)}
      {kind === "character" && <p className="h3-hint">Optional public HTTPS links for the same uploaded voice samples. Saved links are copied into scene references when this character is selected and used by Wan. Upload a local voice sample to add its link.</p>}
      <p className="h3-hint">Each file: under 4 MiB. Combined uploads: 6 MB. {kind === "character" ? "Voice samples: 0.25–15 seconds." : "Locations and props use image references."} Editing without choosing new files keeps saved references.</p>
      <button className="h3-button" disabled={busy || !name.trim() || !collectionId}>{busy ? "Saving…" : `Save ${label.toLowerCase()}`}</button>
      {id && <button type="button" className="text-button" onClick={clear}>Cancel editing</button>}
    </form>
    <div className="character-grid">{items.map(character => <article className="h3-panel" key={character.id}><h2>{character.name}</h2><p>{character.description}</p><div className="character-images">{character.images.map((asset,index) => <img key={`${asset.path}-${character.updatedAt}`} alt={`${character.name} reference ${index+1}`} src={`/api/characters?id=${character.id}&kind=image&index=${index}&v=${character.updatedAt}`} />)}</div>{character.voices.map((asset,index) => <div key={`${asset.path}-${character.updatedAt}`}><p className="h3-hint">{asset.name}</p>{asset.publicUrl && <a className="text-button" href={asset.publicUrl} target="_blank" rel="noreferrer">Public voice link {index + 1}</a>}<audio controls preload="metadata" src={`/api/characters?id=${character.id}&kind=voice&index=${index}&v=${character.updatedAt}`} /></div>)}<div className="library-card-actions"><button className="h3-button secondary" aria-label={`Edit ${character.name}`} disabled={busy} onClick={() => { setId(character.id); setName(character.name); setDescription(character.description); setImages(undefined); setVoices(undefined); setVoiceUrls(character.voices.map(asset => asset.publicUrl || "")); }}>Edit</button><button className="h3-button secondary" aria-label={`Clone ${character.name}`} disabled={busy || !collectionId} onClick={() => void clone(character)}>Clone</button><button className="h3-button secondary" aria-label={`Remove ${character.name}`} disabled={busy} onClick={() => setRemoving(character.id)}>Remove</button></div>{removing === character.id && <div className="h3-feedback" role="group" aria-label={`Remove ${character.name} confirmation`}><p>Remove {character.name} and all its images, voice samples and links from the library? References already copied into scenes are kept. Local files are moved to .trash for recovery.</p><button className="h3-button secondary" disabled={busy} onClick={() => void remove(character)}>{busy ? "Removing…" : "Remove reference"}</button><button className="text-button" disabled={busy} onClick={() => setRemoving(undefined)}>Cancel removal</button></div>}</article>)}</div>
    {!items.length && <p className="h3-hint">No {kind === "character" ? "characters" : kind === "location" ? "locations" : "props"} saved yet.</p>}
  </div>;
}
