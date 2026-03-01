/**
 * cline.cjs — Cline chat adapter
 * ------------------------------
 * Targets Cline (saoudrizwan.claude-dev extension).
 *
 * Cline exposes commands for programmatic chat injection:
 *   cline.addPromptToChat  — adds text to chat input (with optional submit)
 *   cline.addToChat        — adds content to chat
 *   cline.focusChatInput   — focuses the Cline chat panel
 *
 * Submit strategy:
 *   1. Focus Cline chat panel
 *   2. Send text via cline.addPromptToChat or cline.addToChat
 *   3. If command only adds to input, trigger submit (Enter)
 *
 * Busy policy: submit-anyway (best-effort, like generic adapter)
 */

'use strict';

class ClineAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.vscode - VS Code API reference
   * @param {function} [opts.log]
   */
  constructor(opts) {
    this._vscode = opts.vscode;
    this._log = opts.log || (() => {});
    this.available = false;
    this.method = 'addToChat';
    this.busyPolicy = 'submit-anyway';
    this._busyFlag = false;
    this._abortToken = null;
    this._sendCmd = null;
    this._focusCmd = null;
  }

  /**
   * Probe for Cline-specific commands.
   */
  async probe() {
    try {
      const allCmds = await this._vscode.commands.getCommands(true);

      // Prefer addPromptToChat (stable API per Cline docs), fallback to addToChat
      const addPromptToChat = allCmds.includes('cline.addPromptToChat');
      const addToChat = allCmds.includes('cline.addToChat');
      const focusChatInput = allCmds.includes('cline.focusChatInput');

      this._sendCmd = addPromptToChat ? 'cline.addPromptToChat' : (addToChat ? 'cline.addToChat' : null);
      this._focusCmd = focusChatInput ? 'cline.focusChatInput' : null;

      this.available = !!this._sendCmd;
      this.method = this._sendCmd ? 'addToChat' : 'unavailable';

      this._log(`Cline probe: sendCmd=${this._sendCmd} focusCmd=${this._focusCmd}`);

      return { sendCmd: this._sendCmd, focusCmd: this._focusCmd };
    } catch (err) {
      this._log(`Cline probe failed: ${err.message}`);
      this.available = false;
      return { sendCmd: null, focusCmd: null };
    }
  }

  /**
   * Submit text to Cline's chat.
   * @param {string} text
   * @param {object} [options]
   * @returns {Promise<{grade: string, detail: string|null}>}
   */
  async submit(text, options = {}) {
    if (!this.available) {
      const err = new Error('Cline adapter not available — cline.addPromptToChat/addToChat not found');
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

      // Step 1: Focus Cline chat panel
      this._checkAbort();
      if (this._focusCmd) {
        try {
          await this._vscode.commands.executeCommand(this._focusCmd);
          await this._sleep(300);
        } catch {
          this._log(`${this._focusCmd} failed, continuing...`);
        }
      }

      // Step 2: Add text via Cline's native command
      this._checkAbort();
      try {
        await this._vscode.commands.executeCommand(this._sendCmd, safeText);
      } catch (err) {
        const e = new Error(`Cline submit failed: ${err.message}`);
        e.code = 'SUBMIT_FAILED';
        throw e;
      }
      await this._sleep(200);

      // Step 3: Some Cline versions only add to input; try submit if needed
      this._checkAbort();
      const submitCommands = [
        'workbench.action.chat.submit',
        'workbench.action.chat.acceptInput',
        'default:type'
      ];
      for (const cmd of submitCommands) {
        try {
          if (cmd === 'default:type') {
            await this._vscode.commands.executeCommand(cmd, { text: '\r' });
          } else {
            await this._vscode.commands.executeCommand(cmd);
          }
          this._log(`Submit triggered via ${cmd}`);
          break;
        } catch {
          // Try next
        }
        await this._sleep(50);
      }
      await this._sleep(200);

      return { grade: 'submitted', detail: `submitted via ${this._sendCmd}` };
    } finally {
      this._busyFlag = false;
      this._abortToken = null;
    }
  }

  isBusy() {
    return this._busyFlag;
  }

  _setAbortToken(token) {
    this._abortToken = token;
  }

  _checkAbort() {
    if (this._abortToken?.aborted) {
      const err = new Error('Submit aborted by router timeout');
      err.code = 'PROCESSING_TIMEOUT';
      throw err;
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { ClineAdapter };
