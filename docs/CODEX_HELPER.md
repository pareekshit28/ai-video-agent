# PC-connected Codex planning

The ComfyUI custom nodes queue planning requests on the pod. A Python helper on your PC connects outbound to the same HTTPS ComfyUI URL you use in your browser, claims a request, downloads its selected images, calls your local Codex app-server, and posts the result back. H3 renders on the pod after explicit clip approval.

## Setup

1. Update the custom nodes, restart ComfyUI and hard-refresh the browser. In **Settings → Codex & RunPod setup**, download `pc_helper.py` and create a pairing token.
2. On your Windows PC, check that Python 3.10+ and Codex are installed. Run `codex login` if Codex is not already signed in with ChatGPT.
3. Open PowerShell in the downloaded helper's folder and run:

   ```powershell
   py pc_helper.py --url "https://YOUR-POD-8188.proxy.runpod.net"
   ```

4. Paste the pairing token at the prompt. Keep this process running while planning. Settings should show **PC helper connected** and a list of models reported by your Codex installation. Blank model selection uses its default model. Image references require an image-capable model.

Later starts can use `py pc_helper.py`. The helper remembers the pod URL and pairing token in `%USERPROFILE%\.ai-video-agent\helper.json`. It never copies your OpenAI credentials to that file or the pod. Use `--pair` to enter a replacement token, `--url` when the pod's browser address changes, or `--check` to verify the connection without claiming work. `CODEX_CLI_PATH` can point to a specific installed executable.

The helper uses only Python's standard library. No inbound PC port, public PC server, RunPod management API key or separate OpenAI API key is used. Codex inference uses the PC's ChatGPT sign-in and its available access/limits. It remains an online service.

## Data and recovery

The pod stores only a hash of the pairing token. The helper sends that token over HTTPS on its dedicated endpoints. Creating a replacement token revokes the old token and fails pending planning requests; explicitly retry them after pairing again.

Only the request's script/context and selected still images are passed to Codex. The actual prior frame is transferred as the final attachment for frame-aware planning. Voice files stay on the pod; only their descriptive metadata is supplied, so Codex must not claim to have heard them. Temporary downloaded images are removed after each local run.

The helper uses ephemeral Codex threads, read-only permissions, disabled shell/web/app/MCP integrations and rejects requests for additional permissions or tools. It returns planning text and JSON only. It cannot approve a video or submit an H3 render.

Claims have a 90-second lease, renewed by a heartbeat while Codex runs. A missing heartbeat fails the request instead of assigning it to another helper. Lost claim responses recover the same claim; lost result acknowledgements retry the same result without rerunning Codex. If delivery cannot be confirmed, the helper stops and asks you to check ComfyUI. A pod restart cancels interrupted requests; an explicit retry is required. Requests have a 15-minute overall deadline.

The browser uses the existing background-planning status checks, so a long Codex run does not hold an HTTP response open. Browser reload reconnects to the existing task. Saved drafts, completed takes and per-clip approval rules remain in place.

## Existing installations

The Qwen planner runtime and its 4B model download have been removed. Old planning settings are ignored in favor of project-scoped `codex.json` settings. Legacy Qwen canvas node IDs route to the Codex implementation; an old checkpoint filename widget is ignored. Import the updated `workflow.json` for the current Codex node names and defaults.

Keep the H3 conditioning encoder `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`. Despite its name, it belongs to the renderer and is separate from the removed Qwen planner. Existing scene references, scripts, takes and media are preserved. No model files are deleted automatically.

Protocol and authentication references: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Codex authentication](https://learn.chatgpt.com/docs/auth).
