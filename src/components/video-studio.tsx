"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDownToLine, Check, Copy, ExternalLink, Film, ImagePlus, LoaderCircle, Music2, Play, RefreshCw, Settings2, Trash2, X } from "lucide-react";
import { dimensions, initialSettings, mediaFrom, ratios, readableOutput, terminalStatuses, type H3Job, type H3Settings, type ReferenceFile } from "@/lib/h3";

import { studioTabStatus, type GenerationTabStatus } from "@/lib/generation-tab-status";
import { useReportTabStatus } from "./use-generation-tab-status";

type Connection = { endpoint: string; configured: boolean; environmentKey?: boolean };
async function api(path: string, body?: unknown) {
  const response = await fetch(`/api/video/${path}`, { cache: "no-store", ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The request could not be completed.");
  return data;
}
async function readReference(file: File): Promise<ReferenceFile> {
  const preview = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(`Could not read ${file.name}.`)); reader.readAsDataURL(file);
  });
  return { name: file.name, bytes: file.size, base64: preview.slice(preview.indexOf(",") + 1), preview };
}
async function audioDuration(preview: string) {
  return new Promise<void>((resolve, reject) => {
    const audio = new Audio();
    const timer = setTimeout(() => finish(new Error("Could not read the audio duration. Try WAV or MP3.")), 10000);
    function finish(error?: Error) { clearTimeout(timer); audio.onloadedmetadata = null; audio.onerror = null; audio.removeAttribute("src"); audio.load(); error ? reject(error) : resolve(); }
    audio.onloadedmetadata = () => { const duration = audio.duration; audio.onloadedmetadata = null; audio.onerror = null; finish(Number.isFinite(duration) && duration >= 0.25 && duration <= 15 ? undefined : new Error("Voice references must be 0.25–15 seconds long.")); };
    audio.onerror = () => { audio.onerror = null; finish(new Error("This browser could not read the audio. Try WAV or MP3.")); }; audio.src = preview;
  });
}
function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : "The request could not be completed."; }

export function VideoStudio({ visible, staged, collectionId = "", onStatusChange }: { collectionId?: string; onStatusChange?: (status: GenerationTabStatus | null) => void; visible: boolean; staged: { prompt: string; key: number } | null }) {
  const [settings, setSettings] = useState<H3Settings>(initialSettings);
  const [images, setImages] = useState<ReferenceFile[]>([]);
  const [audios, setAudios] = useState<ReferenceFile[]>([]);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [jobs, setJobs] = useState<H3Job[]>([]);
  const [job, setJob] = useState<H3Job | null>(null);
  const [jobId, setJobId] = useState("");
  const [polling, setPolling] = useState(false);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const imageInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const pollingLock = useRef(false);
  const submissionLock = useRef(false);
  const uploadLock = useRef(false);
  const initialized = useRef(false);
  const unknown = jobs.find(item => ["SUBMISSION_UNKNOWN", "SUBMITTING"].includes(item.status));
  useReportTabStatus(studioTabStatus(job, submitting, polling, error), onStatusChange);
  const media = mediaFrom(job?.output);
  const size = dimensions(settings.aspectRatio, settings.megapixels);

  const remember = useCallback((next: H3Job) => {
    setJob(next); setJobId(next.id || "");
    setJobs(current => [next, ...current.filter(item => item.localId !== next.localId)]);
    localStorage.setItem("h3-selected-job", next.localId);
  }, []);
  useEffect(() => {
    if (!visible || initialized.current) return;
    initialized.current = true;
    Promise.all([api("settings"), api(`jobs?collectionId=${encodeURIComponent(collectionId)}`)]).then(([config, history]) => {
      setConnection(config); setEndpoint(config.endpoint); setJobs(history.jobs);
      const selected = history.jobs.find((item: H3Job) => item.localId === localStorage.getItem("h3-selected-job")) || history.jobs[0];
      if (selected) { remember(selected); setPolling(Boolean(selected.id && !terminalStatuses.has(selected.status))); }
    }).catch(cause => { initialized.current = false; setError(errorMessage(cause)); });
  }, [visible, remember]);
  useEffect(() => { if (staged) { setSettings(current => ({ ...current, prompt: staged.prompt })); setNotice("Response added to the scene. Review it and add your references before generating."); } }, [staged]);
  useEffect(() => { if (connectionOpen) dialog.current?.showModal(); else dialog.current?.close(); }, [connectionOpen]);

  // Match the source Studio's optional browser tool: stages the form, never submits.
  useEffect(() => {
    type Tool = { name: string; title: string; description: string; inputSchema: object; annotations: object; execute: (input: unknown) => unknown };
    const context = (document as Document & { modelContext?: { registerTool: (tool: Tool, options: { signal: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try { void Promise.resolve(context.registerTool({ name: "configure_h3_scene", title: "Configure H3 scene", description: "Stage scene settings in the visible form without submitting a RunPod job.", inputSchema: { type: "object", properties: { prompt: { type: "string", minLength: 1, maxLength: 32000 }, duration: { type: "number", minimum: 2, maximum: 15 }, aspectRatio: { type: "string", enum: ratios } }, required: ["prompt"], additionalProperties: false }, annotations: { readOnlyHint: false }, execute(input) {
      const values = input as Partial<H3Settings>;
      if (!values || typeof values.prompt !== "string" || !values.prompt.trim() || values.prompt.length > 32000 || (values.duration !== undefined && (!Number.isFinite(values.duration) || values.duration < 2 || values.duration > 15)) || (values.aspectRatio !== undefined && !ratios.includes(values.aspectRatio))) throw new Error("Invalid scene settings.");
      setSettings(current => ({ ...current, prompt: values.prompt!, ...(values.duration === undefined ? {} : { duration: values.duration }), ...(values.aspectRatio === undefined ? {} : { aspectRatio: values.aspectRatio }) }));
      return { staged: true };
    } }, { signal: lifecycle.signal })).catch(() => undefined); } catch { /* Form works without WebMCP. */ }
    return () => lifecycle.abort();
  }, []);

  const checkStatus = useCallback(async (id: string, localId?: string) => {
    if (pollingLock.current || !id.trim()) return;
    pollingLock.current = true; setChecking(true);
    try { const data = await api("status", { ...(collectionId ? { collectionId } : {}), jobId: id.trim(), ...(localId ? { localId } : {}) }); remember(data.job); setError(""); setPolling(!terminalStatuses.has(data.job.status)); if (terminalStatuses.has(data.job.status)) setNotice(data.job.status === "COMPLETED" ? "Generation completed. Download the video to keep a local copy." : `Job ${data.job.status.toLowerCase().replaceAll("_", " ")}.`); }
    catch (cause) { setError(errorMessage(cause)); setPolling(false); }
    finally { pollingLock.current = false; setChecking(false); }
  }, [remember]);
  useEffect(() => {
    if (!polling || !job?.id) return;
    const timer = setInterval(() => void checkStatus(job.id!, job.localId), 5000);
    return () => clearInterval(timer);
  }, [polling, job?.id, job?.localId, checkStatus]);

  function update<K extends keyof H3Settings>(field: K, value: H3Settings[K]) { setSettings(current => ({ ...current, [field]: value })); }
  async function addFiles(kind: "image" | "audio", files: FileList | null) {
    if (!files?.length || uploadLock.current) return;
    uploadLock.current = true; setUploading(true); setError("");
    try {
      const selected = Array.from(files);
      if ((kind === "image" ? images : audios).length + selected.length > (kind === "image" ? 9 : 3)) throw new Error(`Use up to ${kind === "image" ? "9 images" : "3 audio clips"}.`);
      if (selected.some(file => kind === "image" ? !["image/png", "image/jpeg", "image/webp"].includes(file.type) || !/\.(png|jpe?g|webp)$/i.test(file.name) : !/\.(wav|mp3|m4a|flac|ogg)$/i.test(file.name))) throw new Error(kind === "image" ? "Use PNG, JPEG, or WebP images." : "Use WAV, MP3, M4A, FLAC, or OGG audio.");
      if (selected.some(file => file.size === 0 || file.size > 4 * 1024 * 1024)) throw new Error("Each reference must be nonempty and under 4 MiB.");
      if ([...images, ...audios].reduce((sum, file) => sum + file.bytes, 0) + selected.reduce((sum, file) => sum + file.size, 0) > 6_000_000) throw new Error("Images and audio must be under 6 MB combined.");
      const added = await Promise.all(selected.map(readReference));
      if (kind === "audio") await Promise.all(added.map(file => audioDuration(file.preview!)));
      (kind === "image" ? setImages : setAudios)(current => [...current, ...added]);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { uploadLock.current = false; setUploading(false); if (imageInput.current) imageInput.current.value = ""; if (audioInput.current) audioInput.current.value = ""; }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (submissionLock.current) return;
    if (!collectionId) { setError("Choose or create a project in the sidebar before generating."); return; }
    if (!connection?.configured) { setConnectionOpen(true); return; }
    if (!images.length && !audios.length) { setError("Add at least one image or audio reference."); return; }
    submissionLock.current = true; setSubmitting(true); setError(""); setNotice("");
    try {
      const data = await api("run", { requestId: crypto.randomUUID(), ...(collectionId ? { collectionId } : {}), settings, images: images.map(({ preview: _preview, ...file }) => file), audios: audios.map(({ preview: _preview, ...file }) => file) });
      remember(data.job);
      setPolling(Boolean(data.job.id && !terminalStatuses.has(data.job.status)));
      if (data.job.error) setError(data.job.error); else setNotice("Job submitted. Track its progress in the job monitor.");
    } catch (cause) {
      setError(errorMessage(cause));
      // Reload server reservations before allowing another submission after a lost local response.
      try { const data = await api(`jobs?collectionId=${encodeURIComponent(collectionId)}`); setJobs(data.jobs); const uncertain = data.jobs.find((item: H3Job) => ["SUBMISSION_UNKNOWN", "SUBMITTING"].includes(item.status)); if (uncertain) remember(uncertain); } catch { setError("Connection lost. Reload the page and check saved jobs before submitting again."); setConnection(null); }
    } finally { submissionLock.current = false; setSubmitting(false); }
  }
  async function save(clearKey = false) {
    setSaving(true); setError("");
    try { const config = await api("settings", { endpoint, ...(apiKey ? { apiKey } : {}), clearKey }); setConnection(config); setApiKey(""); setConnectionOpen(false); setNotice(clearKey ? "Saved RunPod key removed." : "RunPod connection saved on this computer."); }
    catch (cause) { setError(errorMessage(cause)); } finally { setSaving(false); }
  }
  async function resolve() {
    if (!unknown) return;
    try { const data = await api("jobs", { localId: unknown.localId, reviewed: true }); remember(data.job); setError(""); setNotice("Submission resolved. You can submit a new scene."); } catch (cause) { setError(errorMessage(cause)); }
  }

  return <div className="video-studio" style={{ display: visible ? undefined : "none" }}>
    <div className="video-title"><div><div className="eyebrow">MINIMAX H3 · REFERENCE TO VIDEO</div><h1>Bring a scene to life.</h1><p>Shape the motion, add visual and voice references, and create with H3.</p></div><button className="h3-button secondary" onClick={() => setConnectionOpen(true)}><Settings2 size={16} />RunPod connection<span className={`status-dot ${connection?.configured ? "ready" : ""}`} /></button></div>
    <div className="h3-grid">
      <form className="h3-form" onSubmit={submit}>
        <section className="h3-panel"><div className="h3-section-title"><span>01</span><div><h2>Scene</h2><p>Refer to images as &lt;Picture 1&gt;, &lt;Picture 2&gt;, and voices as &lt;Audio 1&gt;.</p></div></div>
          <label className="h3-field">Video prompt<textarea value={settings.prompt} onChange={event => update("prompt", event.target.value)} maxLength={32000} required placeholder="Describe the scene, characters, camera movement, and dialogue…" rows={5} /></label>
          <div className="h3-fields"><label className="h3-field">Duration (seconds)<input type="number" min={2} max={15} step={0.5} required value={settings.duration} onChange={event => update("duration", Number(event.target.value))} /></label><label className="h3-field">Megapixels<input type="number" min={0.25} max={4} step={0.25} required value={settings.megapixels} onChange={event => update("megapixels", Number(event.target.value))} /></label></div>
          <fieldset className="h3-ratios"><legend>Aspect ratio</legend>{ratios.map(ratio => <label key={ratio}><input type="radio" name="h3-ratio" value={ratio} checked={settings.aspectRatio === ratio} onChange={() => update("aspectRatio", ratio)} /><span>{ratio.split(" ")[0]}<small>{ratio.split("(")[1].replace(")", "")}</small></span></label>)}</fieldset>
          <p className="h3-hint">Estimated output: {size.width} × {size.height} · 24 FPS</p>
        </section>
        <section className="h3-panel"><div className="h3-section-title"><span>02</span><div><h2>Reference images</h2><p>Up to 9 images, in the order mentioned in your prompt.</p></div></div>
          <input ref={imageInput} className="visually-hidden" aria-label="Upload reference images" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={event => void addFiles("image", event.target.files)} />
          <button type="button" className="h3-upload" disabled={uploading || submitting} onClick={() => imageInput.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!uploading && !submitting) void addFiles("image", event.dataTransfer.files); }}><ImagePlus size={22} /><strong>Add images</strong><span>Drop PNG, JPEG, or WebP · 4 MiB each</span></button>
          {images.map((file, index) => <div className="h3-reference" key={`${index}-${file.name}`}><img src={file.preview} alt={`Picture ${index + 1} preview`} /><div><strong>Picture {index + 1}</strong><small>{file.name}</small></div><button className="icon-button" type="button" aria-label={`Remove Picture ${index + 1}`} disabled={uploading || submitting} onClick={() => setImages(current => current.filter((_, i) => i !== index))}><Trash2 size={16} /></button></div>)}
        </section>
        <section className="h3-panel"><div className="h3-section-title"><span>03</span><div><h2>Voice references</h2><p>Up to 3 clips · 0.25–15 seconds each.</p></div></div>
          <input ref={audioInput} className="visually-hidden" aria-label="Upload voice references" type="file" accept=".wav,.mp3,.m4a,.flac,.ogg" multiple onChange={event => void addFiles("audio", event.target.files)} />
          <button className="h3-upload" type="button" disabled={uploading || submitting} onClick={() => audioInput.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!uploading && !submitting) void addFiles("audio", event.dataTransfer.files); }}><Music2 size={22} /><strong>Add audio clips</strong><span>WAV, MP3, M4A, FLAC, OGG · 4 MiB each</span></button>
          {audios.map((file, index) => <div className="h3-reference h3-audio" key={`${index}-${file.name}`}><Music2 size={22} /><div><strong>Audio {index + 1}</strong><small>{file.name}</small></div><button className="icon-button" type="button" aria-label={`Remove Audio ${index + 1}`} disabled={uploading || submitting} onClick={() => setAudios(current => current.filter((_, i) => i !== index))}><Trash2 size={16} /></button><audio src={file.preview} controls preload="metadata" aria-label={`Preview Audio ${index + 1}`} /></div>)}
          <p className="h3-hint">{([...images, ...audios].reduce((sum, file) => sum + file.bytes, 0) / 1_000_000).toFixed(2)} / 6 MB combined{uploading ? " · Reading references…" : ""}</p>
        </section>
        <section className="h3-panel"><details><summary>Advanced settings</summary><div className="h3-fields"><label className="h3-field">Seed (−1 = random)<input value={settings.seed} required inputMode="numeric" onChange={event => update("seed", event.target.value)} /></label><label className="h3-field">Steps<input type="number" min={1} max={100} required value={settings.steps} onChange={event => update("steps", Number(event.target.value))} /></label></div><label className="h3-field">Reference image quality<select value={settings.refImageSize} onChange={event => update("refImageSize", event.target.value as H3Settings["refImageSize"])}><option value="max">Maximum</option><option value="match">Match output</option></select></label></details></section>
        <div className="h3-submit"><p>Video generation uses your RunPod account and incurs RunPod GPU charges.</p><button className="h3-button" type="submit" disabled={submitting || uploading || Boolean(unknown) || !collectionId}>{submitting ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}{submitting ? "Submitting…" : "Generate video"}</button></div>
        {error && <div className="h3-feedback error" role="alert">{error}</div>}{notice && !error && <div className="h3-feedback" role="status"><Check size={15} />{notice}</div>}
      </form>
      <aside className="h3-monitor">
        <section className="h3-panel"><div className="h3-monitor-heading"><div><div className="eyebrow">RUNPOD QUEUE</div><h2>Job monitor</h2></div><span className={`h3-status ${job?.status === "COMPLETED" ? "completed" : ""}`}>{job?.status.replaceAll("_", " ") || "NO JOB"}</span></div>
          <p className="h3-hint">Endpoint <code>{job?.endpoint || connection?.endpoint || "xnnd4qobofshqz"}</code></p>
          <label className="h3-field">Job ID<div className="h3-id"><input placeholder="Paste a job ID to resume" value={jobId} spellCheck={false} onChange={event => { setJobId(event.target.value); setPolling(false); }} /><button className="icon-button" type="button" aria-label="Copy job ID" disabled={!jobId} onClick={async () => { try { await navigator.clipboard.writeText(jobId); setNotice("Job ID copied."); } catch { setError("Could not copy the job ID."); } }}><Copy size={16} /></button></div></label>
          <div className="h3-monitor-actions"><button type="button" className="h3-button secondary" disabled={!jobId.trim() || checking || submitting} onClick={() => void checkStatus(jobId, job && (!job.id || job.id === jobId.trim()) ? job.localId : undefined)}><RefreshCw size={15} className={checking ? "spin" : ""} />Check status</button>{job?.id && !terminalStatuses.has(job.status) && <button className="text-button" onClick={() => setPolling(current => !current)}>{polling ? "Pause polling" : "Resume polling"}</button>}</div>
          {unknown && <div className="h3-feedback error"><strong>Check this submission before trying again.</strong><p>A lost response can leave a running GPU job. Open the RunPod console, then paste its job ID above to recover it.</p><a href="https://console.runpod.io/serverless" target="_blank" rel="noreferrer">Open RunPod console <ExternalLink size={13} /></a><button type="button" className="text-button" disabled={submitting || checking} onClick={() => void resolve()}>I checked RunPod; no job was created</button></div>}
          {job ? <div className="h3-job-details">{job.delayTime !== undefined && <p>Queue time <strong>{job.delayTime / 1000}s</strong></p>}{job.executionTime !== undefined && <p>Execution time <strong>{job.executionTime / 1000}s</strong></p>}{polling && <small><LoaderCircle size={13} className="spin" />Checking every 5 seconds</small>}{job.error && <div className="h3-feedback error">{job.error}</div>}{job.status === "COMPLETED" && <p className="h3-hint">Download your video to keep a local copy. Hosted links can expire.</p>}</div> : <div className="h3-empty"><Film size={32} /><h3>Ready when you are.</h3><p>Your scene’s progress and final video will appear here.</p></div>}
          {job?.output !== undefined && <div className="h3-output"><h3>Output</h3>{media.map((src, index) => <div className="h3-video" key={index}><video controls playsInline preload="metadata" src={src} /><a href={src} download={`h3-output-${index + 1}.mp4`} target="_blank" rel="noreferrer"><ArrowDownToLine size={15} />Download video {index + 1}</a></div>)}{!media.length && <p className="h3-hint">No video link found. Inspect the worker response below.</p>}<details><summary>View response data</summary><pre>{readableOutput(job.output)}</pre></details></div>}
        </section>
        {jobs.length > 0 && <section className="h3-panel"><h2>Saved jobs</h2><p className="h3-hint">Stored on this computer. Select a job to review or resume.</p><div className="h3-history">{jobs.map(item => <button type="button" key={item.localId} className={job?.localId === item.localId ? "selected" : ""} disabled={checking || submitting} onClick={() => { remember(item); setError(""); setPolling(Boolean(item.id && !terminalStatuses.has(item.status))); }}><strong>{item.prompt.slice(0, 75)}</strong><span>{item.status.replaceAll("_", " ")} · {new Date(item.createdAt).toLocaleDateString()}</span></button>)}</div></section>}
      </aside>
    </div>
    <dialog ref={dialog} className="modal h3-dialog" onCancel={event => { event.preventDefault(); setConnectionOpen(false); }}><div className="modal-heading"><h2>RunPod connection</h2><button className="icon-button" aria-label="Close RunPod connection" onClick={() => { setApiKey(""); setConnectionOpen(false); }}><X size={18} /></button></div><p className="modal-description">Connect the H3 worker used by Runpod H3 Studio. The key stays encrypted on this computer. ChatGPT continues to power your text conversations.</p><form onSubmit={event => { event.preventDefault(); void save(); }}><label className="h3-field">Endpoint ID<input required pattern="[A-Za-z0-9_-]{1,64}" value={endpoint} onChange={event => setEndpoint(event.target.value)} /></label><label className="h3-field">RunPod API key<input type="password" autoComplete="off" value={apiKey} placeholder={connection?.configured ? "Key saved — leave blank to keep it" : "Paste your RunPod API key"} onChange={event => setApiKey(event.target.value)} /></label><p className="h3-hint">{connection?.configured ? "A RunPod key is configured." : "No RunPod key configured."}{connection?.environmentKey ? " An environment key is also available." : ""}</p>{error && <div className="h3-feedback error" role="alert">{error}</div>}<div className="settings-actions"><button className="h3-button" disabled={saving}>{saving ? "Saving…" : "Save connection"}</button><button type="button" className="text-button" disabled={saving} onClick={() => void save(true)}>Remove saved key</button></div></form></dialog>
  </div>;
}
