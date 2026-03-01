/**
 * extension.cjs — CLD IPC Bridge VS Code Extension Entry Point
 * -------------------------------------------------------------
 * Lifecycle:
 *   activate()  → generate instanceId → create token → start pipe → write registry
 *   deactivate() → close pipe → delete registry → delete token
 *
 * Commands:
 *   cld-ipc-bridge.probeChat        → Phase 0 capability spike
 *   cld-ipc-bridge.debugCodex       → Debug Codex injection
 *   cld-ipc-bridge.showStatus       → Show pipe + adapter status
 *   cld-ipc-bridge.copyToken        → Copy auth token to clipboard
 *   cld-ipc-bridge.teachCodexManual → Teach Codex input position (click-to-record)
 *   cld-ipc-bridge.teachCodex       → Teach Codex input position (VLM, explicit)
 */

'use strict';

const vscode = require('vscode');
const { PipeServer } = require('./lib/pipe_server.cjs');
const { generateToken, tokenHint, writeTokenFile, deleteTokenFile } = require('./lib/auth.cjs');
const {
  TOKENS_DIR, generateInstanceId, workspaceHash, pipeName,
  writeRegistry, updateCapabilities, deleteRegistry
} = require('./lib/registry.cjs');
const { Router } = require('./lib/router.cjs');
const { CodexAdapter } = require('./lib/adapters/codex.cjs');
const { CopilotAdapter } = require('./lib/adapters/copilot.cjs');
const { GenericAdapter } = require('./lib/adapters/generic.cjs');
const { AntigravityAdapter } = require('./lib/adapters/antigravity.cjs');
const { ClineAdapter } = require('./lib/adapters/cline.cjs');
const { ContinueAdapter } = require('./lib/adapters/continue.cjs');

const fs = require('fs');
const path = require('path');
const MANIFEST_DIR = path.join(process.env.APPDATA || '', 'CoherentLight', 'manifests');
const MANIFEST_FILE = path.join(MANIFEST_DIR, 'coherentlight.cld-ipc-bridge.json');
const pkg = (() => { try { return require('./package.json'); } catch { return {}; } })();

let server = null;
let router = null;
let instanceId = null;
let token = null;
let outputChannel = null;
let deferredReprobeTimer = null;
let _lastCaps = null;
let _editorName = null;

function writeManifest() {
  try {
    fs.mkdirSync(MANIFEST_DIR, { recursive: true });
    const manifest = {
      id: 'coherentlight.cld-ipc-bridge',
      displayName: 'CLD IPC Bridge',
      version: pkg.version || '0.4.2',
      state: {
        listening: !!server,
        instanceId: instanceId || null,
        editorName: _editorName || null,
        targets: _lastCaps ? _lastCaps.targets : {},
      },
      capabilities: {
        commands: ['manifest', 'showStatus', 'copyToken', 'probeChat', 'teachCodexManual', 'teachCodex', 'debugCodex'],
        rpcTypes: ['chat.submit', 'run-command', 'list-commands', 'reprobe', 'reload'],
        actions: ['inject text into Copilot/Codex/Antigravity/Cursor chat panels'],
      },
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  } catch { /* non-fatal */ }
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${msg}`;
  if (outputChannel) outputChannel.appendLine(line);
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  outputChannel = vscode.window.createOutputChannel('CLD IPC Bridge');
  log('Activating CLD IPC Bridge...');

  // 1. Generate instance identity
  instanceId = generateInstanceId();
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  const wsPath = wsFolder?.uri.fsPath || '';
  const wsName = wsFolder?.name || 'global';
  const wsHash = workspaceHash(wsPath);
  const pipe = pipeName(wsHash, instanceId);

  // Detect which editor we're running inside (VS Code, Antigravity, Cursor, etc.)
  const editorName = (vscode.env.appName || 'Visual Studio Code').toLowerCase();
  _editorName = editorName;

  log(`Instance: ${instanceId}`);
  log(`Workspace: ${wsName} (${wsPath})`);
  log(`Editor: ${editorName}`);
  log(`Pipe: ${pipe}`);

  // 2. Generate auth token
  token = generateToken();
  const tokenPath = writeTokenFile(TOKENS_DIR, instanceId, token);
  log(`Token written: ${tokenPath}`);

  // 3. Create adapters
  const adapters = {
    codex: new CodexAdapter({ vscode, log }),
    copilot: new CopilotAdapter({ vscode, log }),
    cline: new ClineAdapter({ vscode, log }),
    continue: new ContinueAdapter({ vscode, log }),
    generic: new GenericAdapter({ vscode, log }),
    antigravity: new AntigravityAdapter({ vscode, log })
  };

  // Probe adapters — kicked off after registry write (step 6) to avoid race
  let probePromise;

  // 4. Create router
  router = new Router({ adapters, vscode, log });

  // 5. Start pipe server
  server = new PipeServer({
    pipePath: pipe,
    token,
    instanceId,
    log,
    onRequest: async (request, conn) => {
      // Route through the router; use sendFn to send responses
      const sendFn = (resp) => {
        if (conn.socket && !conn.socket.destroyed) {
          try { conn.socket.write(JSON.stringify(resp) + '\n'); } catch {}
        }
      };

      const immediate = await router.handle(request, sendFn);
      return immediate; // null if ack was already sent, or error object
    }
  });

  try {
    await server.listen();
    log('Pipe server started successfully');
  } catch (err) {
    log(`FATAL: Pipe server failed to start: ${err.message}`);
    vscode.window.showErrorMessage(`CLD IPC Bridge: Failed to start pipe server — ${err.message}`);
    deleteTokenFile(TOKENS_DIR, instanceId);
    return;
  }

  // 6. Write registry (AFTER pipe is listening)
  const capabilities = buildCapabilities(adapters);
  server.setCapabilities(capabilities);

  writeRegistry({
    instanceId,
    pipe,
    workspaceName: wsName,
    workspacePath: wsPath,
    editorName,
    pid: process.pid,
    tokenHint: tokenHint(token),
    capabilities
  });
  log('Registry entry written');
  _lastCaps = capabilities;
  writeManifest();

  // 6b. NOW kick off adapter probing (registry file exists, so updateCapabilities won't be swallowed)
  probePromise = probeAdapters(adapters).then(caps => {
    if (server) server.setCapabilities(caps);
    updateCapabilities(instanceId, caps);
    _lastCaps = caps;
    writeManifest();
    log(`Capabilities updated: ${JSON.stringify(caps)}`);

    // 6c. Deferred re-probe: some editors (Antigravity) register commands lazily.
    // Re-probe after 10s to pick up late-registered commands.
    const hasUnavailable = Object.values(caps.targets).some(t => t.available === false);
    if (hasUnavailable) {
      deferredReprobeTimer = setTimeout(async () => {
        deferredReprobeTimer = null;
        log('Deferred re-probe: checking for late-registered commands...');
        const caps2 = await probeAdapters(adapters);
        if (server) server.setCapabilities(caps2);
        updateCapabilities(instanceId, caps2);
        _lastCaps = caps2;
        writeManifest();
        log(`Deferred capabilities: ${JSON.stringify(caps2)}`);
      }, 10_000);
    }
  });

  // 7. Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('cld-ipc-bridge.debugCodex', async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const testText = 'CODEX_IPC_TEST say hello';
      outputChannel.appendLine('=== CODEX DEBUG v2 — testing ALL approaches ===');
      outputChannel.show(true);

      // ── Approach A: Check extension exports API ──
      try {
        const codexExt = vscode.extensions.getExtension('openai.chatgpt');
        if (codexExt) {
          outputChannel.appendLine(`A1. Extension found: openai.chatgpt v${codexExt.packageJSON?.version}`);
          outputChannel.appendLine(`A2. isActive: ${codexExt.isActive}`);
          const api = codexExt.exports;
          outputChannel.appendLine(`A3. exports type: ${typeof api}`);
          if (api) {
            const keys = Object.keys(api);
            outputChannel.appendLine(`A4. exports keys: [${keys.join(', ')}]`);
            // Check for any send/submit/message methods
            for (const key of keys) {
              outputChannel.appendLine(`  A4.${key}: ${typeof api[key]}`);
            }
          } else {
            outputChannel.appendLine('A4. exports: null/undefined');
          }
        } else {
          outputChannel.appendLine('A1. openai.chatgpt extension NOT FOUND');
        }
      } catch (e) {
        outputChannel.appendLine(`A. Extension check FAIL: ${e.message}`);
      }

      // ── Approach B: Pass { query } directly to Codex open commands ──
      outputChannel.appendLine('');
      outputChannel.appendLine('--- Approach B: query arg on Codex open commands ---');
      try {
        await vscode.commands.executeCommand(
          'workbench.action.chat.openNewChatSessionInPlace.openai-codex',
          { query: testText, isPartialQuery: false }
        );
        outputChannel.appendLine('B1. openNewChatSessionInPlace + {query} — OK (check Codex panel)');
      } catch (e) {
        outputChannel.appendLine(`B1. FAIL: ${e.message}`);
      }
      await sleep(1000);

      // ── Approach C: Clipboard paste ──
      outputChannel.appendLine('');
      outputChannel.appendLine('--- Approach C: clipboard paste ---');
      let prevClip = '';
      try {
        prevClip = await vscode.env.clipboard.readText();
        await vscode.env.clipboard.writeText(testText);
        outputChannel.appendLine('C1. Clipboard written');

        await vscode.commands.executeCommand('chatgpt.sidebarView.focus');
        await sleep(500);
        outputChannel.appendLine('C2. Sidebar focused');

        await vscode.commands.executeCommand('workbench.action.chat.focusInput');
        await sleep(300);
        outputChannel.appendLine('C3. focusInput done');

        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        await sleep(300);
        outputChannel.appendLine('C4. clipboardPasteAction — OK (check Codex panel)');

        // Don't submit yet — let's see if text landed first
      } catch (e) {
        outputChannel.appendLine(`C. Clipboard paste FAIL: ${e.message}`);
      } finally {
        // Restore clipboard
        try { await vscode.env.clipboard.writeText(prevClip); } catch {}
      }

      // ── Approach D: vscode.lm API check ──
      outputChannel.appendLine('');
      outputChannel.appendLine('--- Approach D: vscode.lm (Language Model API) ---');
      try {
        if (vscode.lm && typeof vscode.lm.selectChatModels === 'function') {
          const models = await vscode.lm.selectChatModels();
          outputChannel.appendLine(`D1. Available LM models: ${models.length}`);
          for (const m of models) {
            outputChannel.appendLine(`  D1. ${m.id} (${m.vendor}) family=${m.family}`);
          }
        } else {
          outputChannel.appendLine('D1. vscode.lm.selectChatModels not available');
        }
      } catch (e) {
        outputChannel.appendLine(`D. LM API FAIL: ${e.message}`);
      }

      outputChannel.appendLine('');
      outputChannel.appendLine('=== CODEX DEBUG v2 DONE ===');
    }),

    vscode.commands.registerCommand('cld-ipc-bridge.probeChat', async () => {
      const { runSpike } = require('./spike.cjs');
      await runSpike(outputChannel);
    }),

    vscode.commands.registerCommand('cld-ipc-bridge.showStatus', () => {
      const status = router ? router.getStatus() : {};
      outputChannel.appendLine('=== IPC Bridge Status ===');
      outputChannel.appendLine(`Instance: ${instanceId}`);
      outputChannel.appendLine(`Editor: ${editorName}`);
      outputChannel.appendLine(`Pipe: ${pipe}`);
      outputChannel.appendLine(`PID: ${process.pid}`);
      outputChannel.appendLine(`Targets: ${JSON.stringify(status, null, 2)}`);
      outputChannel.show(true);
    }),

    vscode.commands.registerCommand('cld-ipc-bridge.copyToken', async () => {
      if (token) {
        await vscode.env.clipboard.writeText(token);
        vscode.window.showInformationMessage('IPC Bridge auth token copied (clipboard auto-clears in 30s)');
        // Auto-clear clipboard after 30s to limit exposure
        setTimeout(async () => {
          try {
            const current = await vscode.env.clipboard.readText();
            if (current === token) {
              await vscode.env.clipboard.writeText('');
            }
          } catch {}
        }, 30_000);
      } else {
        vscode.window.showWarningMessage('No auth token available');
      }
    }),

    // ── Teach Codex Layout (Manual — preferred, no network) ──
    vscode.commands.registerCommand('cld-ipc-bridge.teachCodexManual', async () => {
      const { teachManual } = require('./lib/codex_layout.cjs');

      log('Starting manual Codex layout teaching...');
      const result = await teachManual(vscode, log);

      if (result.ok) {
        const bbox = result.layout.input.bbox;
        vscode.window.showInformationMessage(
          `Codex layout saved! Input at [${bbox.map(v => v.toFixed(3)).join(', ')}]`
        );
        // Re-probe codex adapter to pick up new layout
        if (adapters.codex) {
          await adapters.codex.probe();
          const caps = await probeAdapters(adapters);
          if (server) server.setCapabilities(caps);
          updateCapabilities(instanceId, caps);
          log('Codex adapter re-probed after manual teach');
        }
      } else {
        log(`Manual teach failed: ${result.error}`);
        vscode.window.showWarningMessage(`Codex layout teach failed: ${result.error}`);
      }
    }),

    // ── Manifest — live self-description for AI Control ──
    vscode.commands.registerCommand('cld-ipc-bridge.manifest', () => {
      writeManifest();
      try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch { return null; }
    }),

    // ── Teach Codex Layout (VLM — explicit opt-in with warning) ──
    vscode.commands.registerCommand('cld-ipc-bridge.teachCodex', async () => {
      const { teachViaVlm, teachManual } = require('./lib/codex_layout.cjs');

      const config = vscode.workspace.getConfiguration('cld-ipc-bridge');
      const apiKey = process.env.OPENROUTER_API_KEY || config.get('vlm.apiKey');
      const model = config.get('vlm.model') || 'openai/gpt-4o-mini';

      if (!apiKey) {
        // No API key — fall back to manual teach
        const fallback = await vscode.window.showWarningMessage(
          'No OpenRouter API key configured. Use manual teach instead?',
          'Manual Teach', 'Cancel'
        );
        if (fallback === 'Manual Teach') {
          await vscode.commands.executeCommand('cld-ipc-bridge.teachCodexManual');
        }
        return;
      }

      // Safety warning: screenshot will be sent to external API
      const confirm = await vscode.window.showWarningMessage(
        'This will capture a screenshot of your screen and send it to OpenRouter API ' +
        `(model: ${model}) to identify the Codex input field. Continue?`,
        { modal: true },
        'Continue'
      );

      if (confirm !== 'Continue') {
        log('VLM teach cancelled by user');
        return;
      }

      let result;
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Teaching Codex layout via VLM...',
        cancellable: false
      }, async (progress) => {
        progress.report({ increment: 0, message: 'Capturing screen...' });
        await new Promise(r => setTimeout(r, 500)); // let notification render

        progress.report({ increment: 30, message: 'Analyzing with VLM...' });
        result = await teachViaVlm(apiKey, log, model, wsName);

        progress.report({ increment: 100, message: result.ok ? 'Done!' : 'Failed' });
      });

      if (result.ok) {
        const bbox = result.layout.input.bbox;
        vscode.window.showInformationMessage(
          `Codex layout learned via VLM! Input at [${bbox.map(v => v.toFixed(3)).join(', ')}]`
        );
        // Re-probe codex adapter
        if (adapters.codex) {
          await adapters.codex.probe();
          const caps = await probeAdapters(adapters);
          if (server) server.setCapabilities(caps);
          updateCapabilities(instanceId, caps);
          log('Codex adapter re-probed after VLM teach');
        }
      } else {
        vscode.window.showErrorMessage(`VLM teaching failed: ${result.error}`);
      }
    })
  );

  // 8. Status bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBar.text = '$(plug) IPC Bridge';
  statusBar.tooltip = `CLD IPC Bridge — ${instanceId}\nClick for status`;
  statusBar.command = 'cld-ipc-bridge.showStatus';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // 9. Crash-safe cleanup — best-effort fallback if deactivate() is never called
  const crashCleanup = () => {
    try { deleteRegistry(instanceId); } catch {}
    try { deleteTokenFile(TOKENS_DIR, instanceId); } catch {}
  };
  process.on('exit', crashCleanup);
  context.subscriptions.push({ dispose: () => process.removeListener('exit', crashCleanup) });

  log('CLD IPC Bridge activated');
}

/**
 * Probe all adapters and build capabilities map.
 */
async function probeAdapters(adapters) {
  const caps = { targets: {} };
  for (const [name, adapter] of Object.entries(adapters)) {
    try {
      const result = await adapter.probe();
      caps.targets[name] = {
        available: adapter.available,
        method: adapter.method,
        busyPolicy: adapter.busyPolicy,
        probeResult: result
      };
    } catch (err) {
      caps.targets[name] = { available: false, error: err.message };
    }
  }
  return caps;
}

/**
 * Build initial capabilities (before probing completes).
 */
function buildCapabilities(adapters) {
  const caps = { targets: {} };
  for (const [name, adapter] of Object.entries(adapters)) {
    caps.targets[name] = {
      available: adapter.available,
      method: adapter.method || 'unknown',
      busyPolicy: adapter.busyPolicy || 'reject-when-busy'
    };
  }
  return caps;
}

function deactivate() {
  log('Deactivating CLD IPC Bridge...');

  if (deferredReprobeTimer) {
    clearTimeout(deferredReprobeTimer);
    deferredReprobeTimer = null;
  }

  if (server) {
    server.close();
    server = null;
  }

  if (router) {
    router.dispose();
    router = null;
  }

  if (instanceId) {
    deleteRegistry(instanceId);
    deleteTokenFile(TOKENS_DIR, instanceId);
    log(`Cleaned up instance ${instanceId}`);
  }

  if (outputChannel) {
    outputChannel.dispose();
    outputChannel = null;
  }
}

module.exports = { activate, deactivate };
