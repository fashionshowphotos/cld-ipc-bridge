/**
 * copilot.cjs — GitHub Copilot Chat adapter
 * -------------------------------------------
 * Targets GitHub Copilot Chat (github.copilot-chat extension).
 *
 * Phase 0 spike confirmed:
 *   - workbench.panel.chat.view.copilot.focus exists
 *   - workbench.action.chat.open + { query } works for pre-fill
 *   - workbench.action.chat.submit exists
 *
 * Submit strategy:
 *   1. Focus Copilot chat panel
 *   2. Open with query pre-fill
 *   3. Submit
 *
 * Busy policy: reject-when-busy (Copilot streams one response at a time)
 */

'use strict';

const { GenericAdapter } = require('./generic.cjs');

class CopilotAdapter extends GenericAdapter {
  constructor(opts) {
    const commands = {
      openCommand: 'workbench.action.chat.open',
      submitMethod: 'query',
      submitCommand: 'workbench.action.chat.submit'
    };

    super({ ...opts, commands });
    this.busyPolicy = 'reject-when-busy';
    this._hasCopilotFocus = false;
  }

  /**
   * Probe Copilot-specific commands.
   */
  async probe() {
    try {
      const allCmds = await this._vscode.commands.getCommands(true);

      const copilotFocus = allCmds.includes('workbench.panel.chat.view.copilot.focus');
      const openExists = allCmds.includes('workbench.action.chat.open');
      const submitExists = allCmds.includes('workbench.action.chat.submit');

      this._hasCopilotFocus = copilotFocus;
      this.available = openExists && copilotFocus; // Require Copilot to be present
      this.method = 'query';

      this._log(`Copilot probe: focus=${copilotFocus} open=${openExists} submit=${submitExists}`);

      return { copilotFocus, openExists, submitExists };
    } catch (err) {
      this._log(`Copilot probe failed: ${err.message}`);
      this.available = false;
      return { copilotFocus: false, openExists: false, submitExists: false };
    }
  }

  /**
   * Submit text to Copilot Chat.
   */
  async submit(text, options = {}) {
    if (!this.available) {
      const err = new Error('Copilot adapter not available');
      err.code = 'TARGET_UNAVAILABLE';
      throw err;
    }

    this._busyFlag = true;
    try {
      let safeText = text.replace(/^[/@]+/, '');
      if (!safeText.trim()) {
        const err = new Error('Text is empty after stripping leading slash/@ commands');
        err.code = 'INVALID_TEXT';
        throw err;
      }

      // Step 1: Focus Copilot panel (ensures we target Copilot, not Codex)
      this._checkAbort();
      if (this._hasCopilotFocus) {
        try {
          await this._vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
          await this._sleep(300);
        } catch {
          // Fall through — chat.open will still work
        }
      }

      // Step 2: Open with query pre-fill
      this._checkAbort();
      await this._vscode.commands.executeCommand('workbench.action.chat.open', {
        query: safeText,
        isPartialQuery: false
      });
      await this._sleep(300);

      // Step 3: Submit — chat.submit often silently fails, so we also send Enter key
      this._checkAbort();

      // Try chat.submit (may silently no-op)
      try {
        await this._vscode.commands.executeCommand('workbench.action.chat.submit');
      } catch {
        this._log('chat.submit threw, continuing to Enter fallback');
      }
      await this._sleep(150);

      // Always also send Enter — belt and suspenders
      // chat.open leaves focus on the chat input widget
      this._checkAbort();
      try {
        await this._vscode.commands.executeCommand('workbench.action.chat.focusInput');
        await this._sleep(100);
      } catch {
        // Input likely already focused
      }

      // Try multiple Enter approaches — the chat widget is custom and picky
      const enterMethods = [
        // Method 1: chat.acceptInput (newer VS Code)
        ['workbench.action.chat.acceptInput', undefined],
        // Method 2: chat.submit (may need focus first)
        ['workbench.action.chat.submit', undefined],
        // Method 3: default:type with carriage return
        ['default:type', { text: '\r' }],
        // Method 4: default:type with newline
        ['default:type', { text: '\n' }],
      ];

      for (const [cmd, args] of enterMethods) {
        try {
          if (args) {
            await this._vscode.commands.executeCommand(cmd, args);
          } else {
            await this._vscode.commands.executeCommand(cmd);
          }
          this._log(`Enter method worked: ${cmd}`);
          break;
        } catch {
          this._log(`Enter method failed: ${cmd}`);
        }
        await this._sleep(50);
      }
      await this._sleep(200);

      return { grade: 'submitted', detail: 'submitted via chat.submit + Enter key cascade' };
    } finally {
      this._busyFlag = false;
      this._abortToken = null;
    }
  }
}

module.exports = { CopilotAdapter };
