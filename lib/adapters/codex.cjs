/**
 * codex.cjs — OpenAI Codex chat adapter (screen injection)
 * ---------------------------------------------------------
 * Codex uses a standalone webview panel that is completely isolated from
 * VS Code's command surface. No VS Code command can inject text into it.
 * (Exhaustively proven: 8+ approaches tested, confirmed by external AI research.)
 *
 * Strategy: PowerShell screen automation
 *   - Manual teach: user clicks Codex input, coordinates recorded
 *   - Runtime: click cached coordinates → clipboard paste → Enter
 *   - VLM fallback: on explicit retry, VLM re-finds coordinates
 *
 * Safety:
 *   - Foreground window title verified before injection
 *   - Clipboard saved and restored
 *   - Coordinates are window-relative (survives moves)
 *   - VLM teach is explicit opt-in only
 *
 * Busy policy: reject-when-busy (screen automation is single-threaded)
 */

'use strict';

const { GenericAdapter } = require('./generic.cjs');
const {
  clickAt,
  pasteText,
  pressEnter,
  getVSCodeWindowRect,
  bringVSCodeToForeground,
  getDpiScale
} = require('../screen_inject.cjs');
const {
  loadLayout,
  teachViaVlm,
  verifyForegroundWindow
} = require('../codex_layout.cjs');

class CodexAdapter extends GenericAdapter {
  constructor(opts) {
    // Pass dummy commands to GenericAdapter — we override probe() and submit()
    const commands = {
      openCommand: 'chatgpt.sidebarView.focus',
      submitMethod: 'query',
      submitCommand: 'workbench.action.chat.submit'
    };

    super({ ...opts, commands });
    this.busyPolicy = 'reject-when-busy';
    this._layout = null;
  }

  /**
   * Probe: check if cached layout exists.
   */
  async probe() {
    this._layout = loadLayout(this._log);

    if (this._layout) {
      this.available = true;
      this.method = 'screen-inject';
      this._log(`Codex probe: layout cached (taught_by=${this._layout.taught_by}, taught_at=${this._layout.taught_at})`);
      return {
        available: true,
        method: 'screen-inject',
        cached: true,
        taught_by: this._layout.taught_by
      };
    }

    // Still "available" — can be taught on first submit via VLM, or user runs teach command
    this.available = true;
    this.method = 'screen-inject-needs-teach';
    this._log('Codex probe: no cached layout — needs teaching');
    return {
      available: true,
      method: 'screen-inject-needs-teach',
      cached: false
    };
  }

  /**
   * Submit text to Codex via screen injection.
   *
   * @param {string} text — the prompt text
   * @param {object} [options]
   * @param {boolean} [options.vlmAssist] — force VLM re-teach before injection
   * @param {string}  [options.apiKey] — OpenRouter API key for VLM
   * @param {string}  [options.vlmModel] — OpenRouter model ID
   */
  async submit(text, options = {}) {
    this._busyFlag = true;
    try {
      // Sanitize: strip leading slash commands and @mentions
      let safeText = text.replace(/^[/@]+/, '');
      if (!safeText.trim()) {
        const err = new Error('Text is empty after stripping leading slash/@ commands');
        err.code = 'INVALID_TEXT';
        throw err;
      }

      // 1. Load or acquire layout
      let layout = this._layout || loadLayout(this._log);

      if ((!layout || options.vlmAssist) && options.apiKey) {
        this._log('Acquiring layout via VLM...');
        const wsFolder = this._vscode.workspace.workspaceFolders?.[0];
        const wsName = wsFolder?.name || '';
        const result = await teachViaVlm(
          options.apiKey,
          this._log,
          options.vlmModel || 'openai/gpt-4o-mini',
          wsName
        );
        if (!result.ok) {
          const err = new Error(`Failed to acquire layout via VLM: ${result.error}`);
          err.code = 'TARGET_UNAVAILABLE';
          throw err;
        }
        layout = result.layout;
        this._layout = layout;
      }

      if (!layout) {
        const err = new Error(
          'No cached Codex layout. Run "CLD IPC Bridge: Teach Codex Layout (Manual)" first, ' +
          'or provide --vlm-assist with an OpenRouter API key.'
        );
        err.code = 'TARGET_UNAVAILABLE';
        throw err;
      }

      // 2. Find the target VS Code window by workspace name
      //    This searches all Code processes for a window whose title contains the workspace.
      //    Does NOT depend on the window being in the foreground.
      const winRect = getVSCodeWindowRect(process.pid, layout.workspace || '');
      if (!winRect) {
        const err = new Error('Could not find VS Code window for this instance');
        err.code = 'TARGET_UNAVAILABLE';
        throw err;
      }
      this._log(`Target window: "${winRect.title}" [${winRect.left},${winRect.top} ${winRect.width}x${winRect.height}]`);

      // 3. Safety interlock: verify the TARGET window (not foreground) is a Code process
      //    with the correct workspace. This works even when VS Code is in the background.
      const ALLOWED_EDITORS = ['Code', 'Antigravity', 'Cursor', 'Windsurf'];
      if (!ALLOWED_EDITORS.includes(winRect.processName)) {
        const err = new Error(
          `Safety interlock failed: target window process is "${winRect.processName}", not a recognized editor (${ALLOWED_EDITORS.join('/')}).`
        );
        err.code = 'SAFETY_INTERLOCK';
        throw err;
      }
      if (layout.workspace && !winRect.title.toLowerCase().includes(layout.workspace.toLowerCase())) {
        const err = new Error(
          `Safety interlock failed: target window "${winRect.title}" does not match workspace "${layout.workspace}".`
        );
        err.code = 'SAFETY_INTERLOCK';
        throw err;
      }

      // 4. Bring VS Code to foreground + focus Codex sidebar
      bringVSCodeToForeground(layout.workspace || '');
      await this._sleep(200);
      try {
        await this._vscode.commands.executeCommand('chatgpt.sidebarView.focus');
        await this._sleep(300);
      } catch {
        try {
          await this._vscode.commands.executeCommand('chatgpt.openSidebar');
          await this._sleep(300);
        } catch {
          this._log('Could not focus Codex sidebar via command');
        }
      }

      const [bx, by, bw, bh] = layout.input.bbox;
      const centerRelX = bx + bw / 2;
      const centerRelY = by + bh / 2;

      // Convert window-relative fraction → absolute screen pixels
      const absX = winRect.left + centerRelX * winRect.width;
      const absY = winRect.top + centerRelY * winRect.height;

      this._log(`Screen inject: clicking at (${Math.round(absX)}, ${Math.round(absY)}) — ` +
        `window [${winRect.left},${winRect.top} ${winRect.width}x${winRect.height}] ` +
        `bbox [${bx.toFixed(3)},${by.toFixed(3)},${bw.toFixed(3)},${bh.toFixed(3)}]`);

      // 6. Execute injection sequence (with abort checks between steps)
      this._checkAbort();
      clickAt(absX, absY);
      await this._sleep(200);

      this._checkAbort();
      pasteText(safeText);
      await this._sleep(200);

      this._checkAbort();
      pressEnter();
      await this._sleep(200);

      this._log('Screen injection completed');

      return {
        grade: 'submitted',
        detail: options.vlmAssist
          ? 'via VLM-assisted screen injection'
          : 'via cached screen injection'
      };

    } finally {
      this._busyFlag = false;
      this._abortToken = null;
    }
  }
}

module.exports = { CodexAdapter };
