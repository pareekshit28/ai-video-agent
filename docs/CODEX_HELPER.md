# Codex desktop helper for Windows and macOS

The desktop app connects your computer's ChatGPT-signed-in Codex installation to ComfyUI on a pod. Both platforms share the same UI and helper core; native builds bundle Python/Tk so the user does not install a runtime. H3 renders on the pod after explicit clip approval.

## Open and connect

1. Update the custom nodes to version 0.9.0 or later, restart ComfyUI and hard-refresh the browser.
2. Download your platform from [desktop downloads](https://github.com/pareekshit28/ai-video-agent/releases/tag/helper-v0.9.0): Windows x64, macOS Apple Silicon, or macOS Intel. Unzip and open **ComfyUI Codex Helper**. On Mac, move the `.app` into Applications. These builds are unsigned; macOS may require approval in System Settings → Privacy & Security on first launch.
3. Install Codex on that computer and sign in with ChatGPT. The helper discovers the Codex CLI on PATH, common Homebrew locations, and the Codex desktop installation. `CODEX_CLI_PATH` overrides detection.
4. Paste the HTTPS ComfyUI URL from your browser. The app connects automatically after you stop typing; **Connect** retries immediately. No pairing step, token or API key is needed.
5. Keep the app open while planning. It shows connection, reconnection and planning activity. Closing it disconnects and stops its active planning request. Saved prompts and completed takes remain on the pod.

When the pod changes, paste its new ComfyUI URL. The old worker stops before the new connection starts. Results from an old request can only be delivered to its original pod; they are never sent to the replacement URL. Interrupted requests require an explicit retry in ComfyUI.

The app remembers only the URL and its **Connect when this app opens** preference in `~/.ai-video-agent/helper.json` on both systems. Opening the app reconnects to the remembered URL when that preference is enabled. It retries temporary network outages automatically. The app does not install a system startup task.

ComfyUI's Settings shows the connected helper and available Codex models. Blank model selection uses the computer's default Codex model. Select an image-capable model when providing images.

## Source and console option

With Python 3.10+ including Tk installed, run `python desktop_helper.py` (use `python3` on macOS). The UI and helper use the standard library. The optional console runner accepts just the URL:

```sh
python pc_helper.py --url "https://YOUR-POD-8188.proxy.runpod.net"
```

`--check` verifies Codex and the connection without claiming work. Later console starts can reuse the saved URL. To build a native app on either OS, install `pyinstaller>=6.16,<7` and run `python desktop/build.py`. GitHub Actions builds and smoke-tests Windows x64, macOS arm64 and macOS x64 separately, then publishes the download ZIPs.

## Data and recovery

The helper opens an outbound HTTPS connection to the supplied URL; it exposes no local port. The helper endpoints accept clients with access to that URL. The app stores no OpenAI credentials and does not send the computer's OpenAI login to ComfyUI. Codex remains an online service using that computer's ChatGPT sign-in and available limits.

Only the request's script/context and selected still images reach Codex. The actual prior frame is the final attachment for frame-aware planning. Voice files stay on the pod; only descriptive metadata is supplied. Temporary downloaded images are removed after each run.

Codex runs in ephemeral read-only threads, with shell/web/app/MCP integrations disabled and requests for additional tools or permissions rejected. It returns planning text/JSON and cannot approve or submit a video render.

A job has one owner and a 90-second lease renewed during inference. Missing heartbeats fail the request instead of reassigning it. Lost claim responses recover the same claim; lost result acknowledgements retry the same result without rerunning Codex. Unconfirmed result delivery stops the worker and shows an error for explicit recovery. Pod restarts cancel interrupted requests. The overall deadline is 15 minutes.

Browser planning remains asynchronous: reload reconnects to the existing task, and a long Codex turn does not hold the browser request open.

## Existing installations

Old connection credentials are discarded; reconnect by URL in the desktop app. Existing project references, scripts, takes and media are preserved. Qwen planning settings remain unused; legacy Qwen canvas node IDs route to Codex. Keep `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`: it is the H3 rendering encoder, separate from the removed Qwen planner.

Protocol reference: [Codex app-server](https://learn.chatgpt.com/docs/app-server).
