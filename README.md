# CLD IPC Bridge

**Deterministic chat injection for VS Code AI assistants.**

Route messages from any agent directly into Copilot, Codex, Cursor, Windsurf/Antigravity, Cline, or Continue — over a local named pipe. No clicks, no focus stealing, no raceconditions.

---

## What it does

CLD IPC Bridge runs a named-pipe server inside VS Code. External processes connect, send a message, and the bridge injects it into whichever AI chat panel you target. The target can be:

- **GitHub Copilot** (query pre-fill + submit)
- **OpenAI Codex** (screen-level clipboard injection — Codex webview is fully isolated from VS Code commands)
- **Antigravity / Windsurf** (`sendTextToChat`)
- **Cursor** (same adapter as Copilot)
- **Cline / Continue** (generic chat.open)

### Why not just VS Code commands?

The Codex panel is a sandboxed webview — no VS Code command can reach its textarea. The bridge uses a fallback screen-injection path: it takes a screenshot, locates the textarea with cached coordinates (taught once via VLM or manual click), pastes via clipboard, and presses Enter. Safe, reliable, and verified across 20+ adversarial test rounds.

---

## Install

Install from the VS Code marketplace:

```
ext install coherentlight.cld-ipc-bridge
```

Or install the VSIX directly:

```
code --install-extension cld-ipc-bridge-0.4.2.vsix
```

The extension activates automatically on startup and registers itself in:

```
%APPDATA%\CoherentLight\ipc-bridge\instances\
```

---

## Teach Codex layout (one-time)

Codex injection requires knowing where the textarea is on screen.

1. Open Codex in VS Code
2. Run `Ctrl+Shift+P` → **CLD IPC Bridge: Teach Codex Layout (Manual)**
3. Click the Codex textarea when prompted
4. Done — coordinates are cached in `%APPDATA%\CoherentLight\ipc-bridge\codex_layout.json`

Or use VLM auto-detection (requires OpenRouter key in settings).

---

## Send a message from the command line

```bash
node codex_ipc_client.cjs --target copilot "Hello from the bus"
node codex_ipc_client.cjs --target codex "Review this file"
node codex_ipc_client.cjs --target antigravity "What does this function do?"

# Run any VS Code command remotely
node codex_ipc_client.cjs --run-command "workbench.action.showCommands"

# List available chat commands
node codex_ipc_client.cjs --list-commands --filter chat
```

Exit codes: `0` = success, `2` = no bridge instance found.

---

## Wire up the bus

If you're running [Bus v1](https://github.com/fashionshowphotos/bus-v1), the bus watcher (`watch_train.ps1`) already uses IPC Bridge for all message delivery. Messages arriving at `_train/` are auto-routed to the right AI based on the `to:` field.

---

## Architecture

```
External process
     │
     ▼  named pipe
┌──────────────┐
│  IPC Bridge  │  (VS Code extension)
│  pipe_server │
│  router      │──► copilot adapter   ──► workbench.action.chat.open
│              │──► codex adapter     ──► screen_inject (clipboard)
│              │──► antigravity       ──► sendTextToChat
└──────────────┘
     │
     ▼  registry
%APPDATA%\CoherentLight\ipc-bridge\instances\*.json
```

Auth token is generated on first launch and shown via **CLD IPC Bridge: Copy Auth Token**. Pass it as `Authorization: Bearer <token>` in your IPC client.

---

## Part of Coherent Light Designs

CLD IPC Bridge is the inter-process backbone of the Coherent Light multi-agent platform. Other components:

- **VLM Auto-Clicker** — auto-accepts AI suggestions (marketplace: `coherentlight.vlm-auto-clicker-vscode`)
- **Bus v1** — file-based agent message bus (`_train/` directory protocol)
- **AI Bridge** — routes tasks to browser-based AIs (ChatGPT, Gemini, DeepSeek, Grok, Kimi)

---

## License

Free for personal and non-commercial use. Commercial use requires a license — contact [coherent-light.com](https://coherent-light.com).
