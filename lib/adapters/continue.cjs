/**
 * continue.cjs — Continue chat adapter
 * --------------------------------------
 * Targets Continue (continuedev/continue extension).
 *
 * Continue exposes:
 *   continue.focusContinueInput           — focus chat, clear input
 *   continue.focusContinueInputWithoutClear — focus chat, keep content
 *
 * Submit strategy:
 *   1. Focus Continue panel
 *   2. Send text via executeCommand (Continue may accept text arg, or we use type)
 *
 * Note: Continue may not have addToChat; we use workbench.action.chat.open with query
 * if Continue is the default chat provider, or focus + default:type as fallback.
 */

'use strict';

class ContinueAdapter {
  constructor(opts) {
    this._vscode = opts.vscode;
    this._log = opts.log || (() => {});
    this.available = false;
    this.method = 'focusContinueInput';
    this.busyPolicy = 'submit-anyway';
    this._busyFlag = false;
    this._abortToken = null;
    this._focusCmd = null;
    this._hasChatOpen = false;
  }

  async probe() {
    try {
      const allCmds = await this._vscode.commands.getCommands(true);
      const focusInput = allCmds.includes('continue.focusContinueInput');
      const focusNoClear = allCmds.includes('continue.focusContinueInputWithoutClear');
      const chatOpen = allCmds.includes('workbench.action.chat.open');

      this._focusCmd = focusInput ? 'continue.focusContinueInput' : (focusNoClear ? 'continue.focusContinueInputWithoutClear' : null);
      this._hasChatOpen = chatOpen;

      this.available = !!this._focusCmd;
      this.method = this._focusCmd ? 'focusContinueInput' : 'unavailable';

      this._log(`Continue probe: focusCmd=${this._focusCmd} chatOpen=${chatOpen}`);

      return { focusCmd: this._focusCmd, chatOpen };
    } catch (err) {
      this._log(`Continue probe failed: ${err.message}`);
      this.available = false;
      return { focusCmd: null, chatOpen: false };
    }
  }

  async submit(text, options = {}) {
    if (!this.available) {
      const err = new Error('Continue adapter not available — continue.focusContinueInput not found');
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

      this._checkAbort();
      if (this._focusCmd) {
        try {
          await this._vscode.commands.executeCommand(this._focusCmd);
          await this._sleep(300);
        } catch (e) {
          this._log(`${this._focusCmd} failed: ${e.message}`);
        }
      }

      this._checkAbort();
      if (this._hasChatOpen) {
        try {
          await this._vscode.commands.executeCommand('workbench.action.chat.open', {
            query: safeText,
            isPartialQuery: false
          });
          await this._sleep(300);
        } catch (e) {
          this._log('workbench.action.chat.open failed, trying default:type');
        }
      }

      this._checkAbort();
      try {
        await this._vscode.commands.executeCommand('workbench.action.chat.submit');
      } catch {}
      await this._sleep(200);

      return { grade: 'submitted', detail: `submitted via ${this._focusCmd} + chat.open` };
    } finally {
      this._busyFlag = false;
      this._abortToken = null;
    }
  }

  isBusy() { return this._busyFlag; }
  _setAbortToken(token) { this._abortToken = token; }
  _checkAbort() {
    if (this._abortToken?.aborted) {
      const err = new Error('Submit aborted by router timeout');
      err.code = 'PROCESSING_TIMEOUT';
      throw err;
    }
  }
  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { ContinueAdapter };
