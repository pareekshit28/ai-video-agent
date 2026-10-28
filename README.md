# AI Video Agent

A local Next.js 16 + TypeScript app that uses your signed-in Codex CLI to read a script, create optional reference slots, and prepare short videos. Choose MiniMax H3 on RunPod or Wan 3.0 on API Mart. The app saves clips and frames on this computer. Reference images are supplied by you. No OpenAI API key or client secret is required.

## Run

Requires Node.js 20.9 or later and Codex CLI signed in with ChatGPT on this computer.

```sh
npm ci
npm run dev
```

Sign in to **Codex CLI with ChatGPT** on this computer, then open **http://127.0.0.1:3000**. The app detects the desktop-bundled Windows executable or `codex` on PATH; set `CODEX_CLI_PATH` to an absolute executable path if necessary. The agent uses Codex's own saved sign-in through `codex app-server`, discovers available models and skills, and selects a Codex model. Paste a scene into **Your scene**, choose a **Thinking** mode, and click **Identify references**. Thinking defaults to **Low** for faster responses; available levels come from the selected Codex model. The chosen level overrides the CLI's configured thinking effort, applies to analysis, prompt preparation, optimization and clip retries, and is saved with the project. Higher levels can improve complex planning but take longer. This first step creates reference slots only. Supply the images and voices you want to use, then click **Understand references & plan clips**. Codex inspects the attached images and uses only supplied references to create the scene outline and first clip prompt. Later clip prompts wait for the preceding clip to finish. After saving its video and last frame, the app automatically asks Codex to inspect that actual frame and plan the next prompt using the preceding submitted prompt, actual duration and remaining story. It pauses for review before the next render. Replacing the previous frame invalidates the next prompt; use **Plan prompt from last frame** to refresh it. If planning fails or is interrupted, retry prompt planning separately; completed videos stay saved. Cuts and scene changes use the preceding frame as story context without forcing visual continuity. Each clip has one editable prompt, reference choices, optional comments, and **Apply comments**, **Save prompt**, and **Generate clip** buttons. Generate saves the visible prompt and reference choices before submitting just that clip. A continuation waits for the preceding clip’s last frame. Set your RunPod key in `.env.local` or **RunPod connection** first. FFmpeg and FFprobe must be on PATH, or configured with their absolute executable paths in `.env.local`.

The browser tab title shows generation status while you work in other tabs: queued, rendering, saving, planning the next prompt, ready for review, completed, or needing attention. Active work has a rotating status marker; clip numbers and saved counts come from the current scene. Video Studio jobs also report their status, including while Library or Settings is open.

Use **Codex connection** to check available models, skills and image-editing support, or refresh after signing in through the CLI. The app does not manage sign-in credentials.

On Windows, if Node is installed in `C:\Program Files\nodejs` but missing from PATH, use:

```powershell
.\scripts\start-local.ps1
```

The app defaults to port 3000. Use `127.0.0.1`, as required by the local request guards, rather than `localhost`. To change the port, set `APP_ORIGIN=http://127.0.0.1:3001` in `.env.local`, then run `npx next dev --hostname 127.0.0.1 --port 3001`.

For a production build running locally:

```sh
npm run build
npm start
```

## What it does

- Scene planning, prompt compilation and single-clip prompt revisions through Codex CLI.
- Available models, local skills and image-editing capability discovered from Codex.
- Extracted or user-replaced last frames used automatically for continuation clips.
- Optional user-supplied references, sequential RunPod rendering, review and recovery.
- Durable local projects, clips, references and frames.

Codex owns its connection and credentials. RunPod uses the separate connection described below. There is no direct ChatGPT plan-sharing integration or OpenAI API-key fallback.

Library cards include **Clone** to create an independent copy in the same category and project, with its description, images, voice samples and voice links. Copies receive unique names such as `(copy)` and `(copy 2)`. The unassigned-library import dropdown has been removed.

Library cards include **Remove** for the entire saved character, location or prop. Confirming removes its images, voice samples and saved links from the library immediately. Files from all configured storage copies are moved into `.trash` for recovery; references already copied into scenes are preserved.

## Wan 3.0 on API Mart

Wan prompt rules follow [Alibaba Cloud's official Wan 3.0 prompting guide](https://www.alibabacloud.com/help/en/model-studio/wan3-video-generation-prompt-guide). Analysis, optimization, compilation and comment-based retries share these rules. Older unsubmitted Wan prompts are refreshed during generation; existing paid jobs are preserved.

Choose **Video generation model → Wan 3.0 · API Mart** in the scene agent. Set `APIMART_API_KEY` in `.env.local` and restart the server, or use **API Mart connection** to save a key encrypted on this computer. RunPod's key and endpoint remain separate. Select **Wan resolution** (480P, 720P or 1080P); 720P is the default. H3 sampling steps and megapixels do not apply to Wan. Wan plans clips of 2–30 whole seconds. **Wan duration** defaults to **Automatic**, sending `duration: -1` so Wan chooses the final length with natural pacing, up to 30 seconds. Planned durations are estimates; the returned length is retained and displayed as actual duration. Choose **Fixed** to send the planned duration instead. H3 remains limited to 2–10 seconds.

Supplied images and continuation frames are uploaded using API Mart's image upload API immediately before submission. Generation requests contain public URLs rather than inline Base64, so H3's combined 6 MB submission limit does not apply to Wan. Existing per-file local upload limits still apply. API Mart image links expire after 72 hours; images are uploaded again for a new generation. Wan requires image edges 240–8000 pixels, at most 20 MB and no PNG alpha channel.

For voice references, supply a local sample as usual, then enter a **Public voice URL** pointing to the same WAV/MP3 sample on accessible HTTPS storage. These optional links can be saved alongside each voice sample in **Library → Characters** and edited without re-uploading audio. Selecting the character in a scene copies its saved voice links; existing scene references retain their own saved copies until you select the character again. Links can also be edited in scene references. API Mart documents image uploads only, so local voice files are not automatically hosted. Wan requires each voice sample to be 1–15 seconds, with at most 15 seconds total per clip. Up to 10 image references and 5 voice references can be submitted, within the existing library/slot limits.

Wan uses reference-video mode only (`generation_type: "reference"`). Each clip requires at least one supplied image, voice sample or previous last frame. Continuation frames are appended as `reference_image` inputs alongside image and voice references, with an explicit prompt binding; they count toward the 10-image limit. Continuity is a visual reference and prompt instruction, not a guaranteed fixed first frame. Unfinished jobs lock the provider choice; resume and recovery query the original provider. Lost submission responses require task-ID recovery or explicit account review before another paid task. Videos, last frames, previous takes and request audits use the same local folders as H3.

The separate Video Studio remains the H3 worker interface. Contract details: [Wan generation](https://docs.apimart.ai/en/api-reference/videos/wan3.0-video/generation), [image uploads](https://docs.apimart.ai/en/api-reference/uploads/images), [task polling](https://docs.apimart.ai/en/api-reference/tasks/status).

## Automatic video agent

**Approve prompt before each clip** is enabled by default. Starting generation prepares prompts and pauses before any new paid video submission. Edit the **Prepared prompt**, then choose **Approve and generate clip**. Each clip requires its own approval; changing its settings, references or continuity context invalidates that approval. Existing submitted jobs can still resume without being resubmitted. You can turn off this review option to allow automatic submission.

In **Retry clip with comments**, choose the references for the replacement clip before revising. The LLM uses those selections. The revised prompt is editable: **Save revised prompt** persists both text and references, and **Generate revised clip** saves any remaining edits before submitting. The previous take retains its original reference selections and video.

The hierarchy is **Project → Scenes → Clips**. Choose the active project at the top of the left sidebar; the choice persists across reloads and scopes scenes, the reference library and Video Studio history. Select **Create new project…** in that chooser to open a project-name dialog. Use **Manage scenes** in the agent to create, search and rename named scene drafts. Each scene keeps its own script, references, settings, clips and continuity frames. Existing scenes appear under **Unassigned scenes** and can be added with **Add an existing scene** inside a project. Organizing existing items moves their folders under the parent project while preserving IDs and filenames. Scene references can only use library items from the same project. New scene planning, library creation and Studio generation require a selected project.

Project folders contain `workspace.json`, `scenes/<scene-id>/`, `library/<asset-id>/` and `studio/<request-id>/`. Each scene contains `project.json`, `references/`, `clips/`, `frames/` and `requests/`. Video Studio saves supplied references and request settings before submission, then saves a completed video locally when its status is checked. Concurrent/repeated status checks reuse the saved MP4. Keep the local server and job monitor running until the video is saved. Credentials remain in the local credential store outside project media.

Select **Delete current project…** in the project chooser to delete a project after confirmation. Scenes, library assets and Studio files are moved into `.trash/<project-id>-<batch-id>/` under their storage roots, including earlier copies, so they disappear from the app but remain recoverable. The success message shows the trash locations. Generation and unresolved Runpod jobs block deletion; deleting a project does not cancel remote jobs.

The default workspace combines scene planning, reference uploads, video generation, local playback and recovery:

1. After identifying references, set **Maximum clip duration** before choosing **Understand references & plan clips** (2–10 seconds for H3; 2–30 whole seconds for Wan). Codex plans the **fewest practical clips** within that maximum, combining related actions while preserving every story event, dialogue, ordering and necessary pacing. Longer scenes use more clips. The maximum is saved with the scene after successful planning, and the final packing pass respects it. Individual clip durations remain editable afterward. Automatic Wan durations are estimates; select Fixed to request the planned lengths. **Optimize clip plan** replans an existing unsubmitted sequence using the saved maximum while retaining uploaded references and edits. Submitted jobs and completed videos keep their clip IDs.
2. Upload PNG, JPEG or WebP references into the slots you want. Empty slots are ignored. Only supplied references selected for a shot become uploads and contiguous `<Picture 1>`, `<Picture 2>` bindings. Codex compiles the prompts around that supplied-reference list before any GPU submission. With no uploads, the native H3 graph can render from the scene text; no reference images are generated.
3. The server runs one clip at a time. It downloads the provider's output once, creates a playable H.264 MP4 at 24 FPS, trims any excess H3 frame-snapped duration to the requested duration, and extracts the actual last decoded frame. After the final video and frame are verified and recorded, the intermediate `.source.mp4` is removed, leaving one MP4 per successful take. A short or invalid result remains incomplete and stops the sequence; its source stays available for recovery.
4. **Motion continuity** defaults to **Auto** for H3. The planner chooses direct continuation, cut, scene change or time jump and explains its choice. A continuation loads the preceding take’s UUID into `MiniMaxH3MotionContextLoadLatent.clip_id`; every new take saves its own UUID through `MiniMaxH3MotionContextSaveLatent.clip_id`. New shots leave the load UUID empty with `clip_index: 0`. The motion-context and trim nodes stay connected in all requests. Regenerations use new UUIDs and retain previous takes. Wan uses its existing frame-reference continuity.

**Review after each clip** defaults to enabled: after saving a clip and extracting its frame, the agent pauses before the next clip. Review the result and choose **Resume clip** when ready. Turn this setting off for uninterrupted sequential rendering.

Each completed clip saves a last frame for preview and prompt planning. Replacing that image changes planning context. H3 render continuity always loads the preceding take’s saved latent UUID; it never uploads the last frame as a frame-zero guide. Wan continues to use the previous image as a visual reference.



Use **Retry generation for clip N** to render that clip again with its current prompt and latest continuity guide; no comments or LLM rewrite are required. Previous takes remain available, and a new RunPod job incurs GPU charges. A replacement affects new continuation jobs; an already submitted or completed clip must be retried to use it.

Edit any pending or completed clip in its prompt editor. **Apply comments** rewrites that same prompt using the current text, selected references, duration and continuity setting; it does not start a render. Edit the returned text freely. **Generate clip** saves and submits the reviewed text. For completed or failed clips, **Regenerate clip** starts a new paid job for that clip, keeping previous takes under **Previous generations**. Comments are optional. Resume interrupted jobs using **Resume clip**; **Retry clip** is available for recoverable jobs when a replacement is needed.

The default folder is `%USERPROFILE%\Videos\AI Video Agent\<project-name>`. Open **Settings → Base location** in the sidebar to save a different absolute base folder. You can point it to a local Google Drive for desktop folder. **Copy existing projects and library** is enabled by default; originals are retained. With copying disabled, older projects and library entries remain accessible in their original folders, while new projects use the selected folder. New scenes and assets added to an existing project stay inside its existing folder until that project is copied. The saved setting persists across restarts and takes priority over the initial `VIDEO_OUTPUT_DIR` default in `.env.local`. Each parent project is saved under **Base location / Project name**, containing its scene, library and Studio folders. Legacy UUID parent folders are renamed when opening the project; scene IDs, filenames and references are preserved. Project names must be unique and valid local folder names. Settings also shows the shared Codex connection status. Completed takes, references and frames stay local; intermediate sources are retained only for unfinished processing or recovery. Request records contain the workflow and filenames without embedded media or credentials. Folder changes check write access and are blocked during generation. Existing destination items are never overwritten during copying. Google Drive for desktop handles cloud syncing; this app does not verify cloud upload completion. RunPod and Codex credentials are kept in their local credential stores and are not copied into the media folder.

**Pause generation** stops new work; an already submitted RunPod job can keep running. Closing the browser leaves the local server working. After restarting the server, **Resume generation** recovers saved job IDs and retained sources. A lost submission response pauses for job-ID recovery or explicit console review; it never automatically submits another paid job. Keep the local server running so it can download results before RunPod's hosted output expires.

Reference files are limited to 4 MiB each, with at most nine supplied appearance references per H3 shot and 6 MB combined. H3 latent continuity adds no frame upload. The controls validate selected uploads before generation. Existing jobs and retained sources can resume without re-uploading references. Planning and compilation use Codex CLI; rendering incurs RunPod GPU charges.

Each clip displays RunPod queue time, generation time and their total in seconds/minutes. These provider-reported values are saved with the clip and previous takes; unavailable values display a dash. Total covers the RunPod request through completion, excluding local download and video processing.

## Video Studio

Choose **Video Studio** in the sidebar, then **RunPod connection**. Paste your RunPod API key and select the endpoint hosting your FastH3 OmniRef worker (the app's fallback endpoint is `6b68a4fh76ub8s`). The key is encrypted in the local RunPod credential store; it is never returned to the browser. Alternatively, set `RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID` in `.env.local` and restart. Removing a saved key does not remove an environment key.

The current ComfyUI source is preserved in `workflows/minimax_h3_motion_context.json`, with its API graph in `src/lib/h3-workflow.json`. Requests retain `{ input: { workflow, images } }`, including audio bytes in the `images` array. The graph uses `minimax_h3_ref2va_pruned_int8_convrot.safetensors`, turbo LoRA, `minimax_h3_video_vae_int8_convrot.safetensors`, beta scheduler, sigma shifts 12/3 and Comfy Kitchen attention. Motion-context load/save nodes use `/runpod-volume/h3_latents` and the `clip_id` UUID input. The worker must have the requested H3 model, video VAE and the UUID-capable motion-context nodes used in the attached workflow.

New Studio jobs default to 5 seconds, 2 MP and 6 sampling steps, with the source seed and maximum reference size. New agent projects default to 2 MP and 6 steps. H3 planning and generation are limited to 2–10 seconds per clip; saved settings and explicit overrides are retained.

- Scene prompt, 2–10 second duration, 0.25–4 megapixels, widescreen/portrait/square ratios and estimated dimensions at 24 FPS. The source workflow snaps frame counts to H3's valid sequence lengths, so actual duration can differ slightly.
- Up to 9 PNG/JPEG/WebP images and 3 WAV/MP3/M4A/FLAC/OGG audio clips. Reference them as `<Picture 1>` and `<Audio 1>`. Audio must be 0.25–15 seconds; preview support depends on the browser's codec support. Each file is limited to 4 MiB, and combined references to 6 MB. At least one image or audio reference is required.
- Advanced seed (−1 for random), sampling steps, and maximum/matched reference image quality.
- RunPod submission, status checks every 5 seconds, pause/resume polling, manual job recovery, queue/execution timings, video preview/download and inspectable output data.
- Encrypted local job history that survives reloads and server restarts. Jobs retain the endpoint they were submitted to. The app retains recent completed jobs and all unfinished jobs. Reference uploads stay in browser memory; download generated videos to preserve them independently of expiring hosted links.
- The optional `configure_h3_scene` browser tool stages settings without starting a GPU job.

Video generation incurs RunPod GPU charges. No OpenAI API key is used; last-frame editing runs through Codex CLI. The worker must have the FastH3 models and the API graph's custom nodes installed; `BlockSparseAttention` is omitted from API requests. Local checks do not confirm a successful render on that worker.

The server builds the workflow from validated settings rather than accepting arbitrary graphs from the browser. It submits using `/run` and checks `/status/{jobId}`. If a submission times out, returns an ambiguous error, or loses its job ID, it blocks another submission until you recover the job ID from the RunPod console or explicitly confirm that no job was created. It never automatically retries a GPU submission. RunPod's asynchronous result retention is limited; see the [RunPod request documentation](https://docs.runpod.io/serverless/endpoints/send-requests).

## Local credential storage

The runtime stores only the RunPod key and H3 job history in an AES-256-GCM encrypted file outside the repository:

- Windows: `%LOCALAPPDATA%\prompt-studio`
- Other systems: `~/.config/prompt-studio`

The existing directory is retained so upgrades preserve saved RunPod connections and jobs. On opening the store, the app removes obsolete app sign-in credentials, registrations, sessions and transactions while keeping RunPod data. Codex credentials stay in Codex's own store. If you previously configured a custom storage directory, set `AGENT_STORAGE_DIR` to that same absolute directory before starting this version.

The encryption key is protected in the same directory. Unix uses owner-only permissions; Windows restricts access to the current user. Set `AGENT_STORAGE_DIR` to choose another directory. Never commit, share or log its files. Run one Next.js process against each storage directory; writes are serialized within that process.

## Local access

Run on this computer at `http://127.0.0.1:3000`. Server routes reject unexpected hosts and cross-origin requests. This app controls the local Codex CLI and reads local media, so keep it bound to loopback.

## Verify

```sh
npm run typecheck
npm test
npm run test:e2e
npm run build
```

The browser suite uses installed Microsoft Edge by default and tests desktop/mobile layouts. For a system without Edge, install Playwright Chromium with `npx playwright install chromium` and remove `channel: "msedge"` from `playwright.config.ts`.


Characters are saved locally under Library → Characters with images and voice samples (0.25–15 seconds). Choose saved characters or upload audio in scene references; only selected, supplied media is sent. Each clip supports 9 images and 3 audio references within a combined 6 MB budget. Sampling steps can be set from 1 to 100. H3 continuation clips load the preceding take’s latent by UUID. Each take saves its own latent UUID, retained with previous generations; fresh shots keep the load node connected with an empty `clip_id` and `clip_index: 0`. Existing clips generated before this workflow need regeneration to provide a latent.

The Library includes Characters, Locations and Props categories. Save named image references with descriptions, then add library entries to a scene or select a matching entry for an existing reference slot. Existing character entries remain available.
