/**
 * codex_layout.cjs — Codex Input Layout Management
 * --------------------------------------------------
 * Stores and retrieves the Codex input field coordinates for screen injection.
 *
 * Coordinates are fractional [0,1] relative to the VS Code window rect,
 * NOT absolute screen coordinates. This survives window moves.
 *
 * Teach methods:
 *   - Manual (preferred): User clicks Codex input, extension records position
 *   - VLM (explicit opt-in): Screenshot → OpenRouter API → parse bbox
 *
 * Safety:
 *   - Manual teach: no screenshots, no network
 *   - VLM teach: requires explicit user confirmation before screenshot leaves machine
 *   - verifyForegroundWindow: checks active window title before injection
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const {
  captureScreen,
  getVSCodeWindowRect,
  getMousePosition,
  getForegroundWindowTitle
} = require('./screen_inject.cjs');

const APP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'CoherentLight', 'ipc-bridge'
);
const LAYOUT_FILE = path.join(APP_DIR, 'codex_layout.json');

// ---------------------------------------------------------------------------
// VLM prompt — adapted from Universal Connector's VLM_LATCH_PROMPT
// ---------------------------------------------------------------------------

const VLM_PROMPT = `You are a UI layout analyzer. Output ONLY valid JSON, no markdown, no explanation.

Analyze this VS Code screenshot. Identify the Codex/AI chat input text field.
It is typically a text area or input box at the bottom of a sidebar chat panel
(left or right side of the screen), with placeholder text like "Ask Codex",
"Type a message", or similar.

Return this EXACT JSON format:
{
  "input": {
    "bbox": [x, y, width, height]
  }
}

Where x, y, width, height are decimal fractions (0.0 to 1.0) of the FULL IMAGE dimensions.
x = left edge fraction, y = top edge fraction, width = width fraction, height = height fraction.`;

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load cached layout from disk.
 * @param {function} [log] — optional logger
 * @returns {object|null} — layout object or null if missing/invalid
 */
function loadLayout(log) {
  try {
    if (!fs.existsSync(LAYOUT_FILE)) return null;

    const data = JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8'));

    // Validate schema
    if (!data.input?.bbox || !Array.isArray(data.input.bbox) || data.input.bbox.length !== 4) {
      if (log) log('Invalid layout: missing or bad input.bbox');
      return null;
    }

    // Validate bounds in [0,1]
    const valid = data.input.bbox.every(v => typeof v === 'number' && v >= 0 && v <= 1);
    if (!valid) {
      if (log) log('Invalid layout: bbox values out of [0,1] range');
      return null;
    }

    return data;
  } catch (err) {
    if (log) log(`Failed to load layout: ${err.message}`);
    return null;
  }
}

/**
 * Save layout to disk.
 * @param {object} layout
 * @param {function} [log]
 * @returns {boolean}
 */
function saveLayout(layout, log) {
  try {
    if (!fs.existsSync(APP_DIR)) {
      fs.mkdirSync(APP_DIR, { recursive: true });
    }

    const data = {
      ...layout,
      taught_at: new Date().toISOString()
    };

    const content = JSON.stringify(data, null, 2);
    const tmpFile = `${LAYOUT_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmpFile, content, 'utf8');
    try {
      fs.renameSync(tmpFile, LAYOUT_FILE);
    } catch {
      try { fs.unlinkSync(LAYOUT_FILE); } catch {}
      fs.renameSync(tmpFile, LAYOUT_FILE);
    }
    if (log) log(`Layout saved to ${LAYOUT_FILE}`);
    return true;
  } catch (err) {
    if (log) log(`Failed to save layout: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Manual teach (click-to-record)
// ---------------------------------------------------------------------------

/**
 * Manual teach: user positions cursor over Codex input, countdown captures position.
 * Called from extension command — uses VS Code API for UI.
 *
 * Flow: User positions cursor → 5-second countdown (no clicking needed) → capture → confirm.
 * This avoids the old bug where clicking "OK" moved the cursor off the target.
 *
 * @param {object} vscode — VS Code API namespace
 * @param {function} log
 * @returns {Promise<{ ok: boolean, layout?: object, error?: string }>}
 */
async function teachManual(vscode, log) {
  if (log) log('teachManual: starting');

  // Step 1: Get current VS Code window rect
  const winRect = getVSCodeWindowRect(process.pid);
  if (log) log(`teachManual: winRect = ${winRect ? `[${winRect.left},${winRect.top} ${winRect.width}x${winRect.height}]` : 'null'}`);
  if (!winRect) {
    if (log) log('teachManual: FAILED — no VS Code window rect');
    return { ok: false, error: 'Could not find VS Code window' };
  }

  // Step 2: Instruct user (modal — dismissed with button click or Enter)
  if (log) log('teachManual: showing modal dialog');
  const ready = await vscode.window.showInformationMessage(
    'After you click "Start", you have 5 seconds to move your cursor over the Codex input field. ' +
    'Hold still — position will be captured when the countdown ends.',
    { modal: true },
    'Start'
  );
  if (log) log(`teachManual: modal result = "${ready}"`);

  if (ready !== 'Start') {
    if (log) log('teachManual: user cancelled modal');
    return { ok: false, error: 'User cancelled' };
  }

  // Step 3: Countdown — user moves cursor to target and holds still
  if (log) log('teachManual: starting 5s countdown');
  let mouse = null;
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Move cursor to Codex input',
    cancellable: false
  }, async (progress) => {
    for (let i = 5; i >= 1; i--) {
      progress.report({ message: `Capturing in ${i}...` });
      await new Promise(r => setTimeout(r, 1000));
    }
    progress.report({ message: 'Captured!' });
    mouse = getMousePosition();
    if (log) log(`teachManual: mouse position = ${mouse ? `(${mouse.x}, ${mouse.y})` : 'null'}`);
  });

  if (!mouse) {
    if (log) log('teachManual: FAILED — could not get mouse position');
    return { ok: false, error: 'Could not get mouse position' };
  }

  // Step 4: Re-get window rect (foreground window should be this VS Code instance)
  const winRect2 = getVSCodeWindowRect(process.pid);
  const win = winRect2 || winRect;
  if (log) log(`teachManual: window rect for conversion = [${win.left},${win.top} ${win.width}x${win.height}]`);

  // Step 5: Convert absolute → window-relative fractional coords
  const relX = (mouse.x - win.left) / win.width;
  const relY = (mouse.y - win.top) / win.height;
  if (log) log(`teachManual: relative coords = (${relX.toFixed(4)}, ${relY.toFixed(4)})`);

  // Validate cursor is within VS Code window
  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) {
    if (log) log(`teachManual: FAILED — cursor outside window bounds (relX=${relX.toFixed(4)}, relY=${relY.toFixed(4)})`);
    return { ok: false, error: 'Cursor was outside VS Code window bounds' };
  }

  // Store as zero-size bbox at exact cursor point.
  // Adapter computes center as (bbox[0] + bbox[2]/2, bbox[1] + bbox[3]/2) = (relX, relY).
  const bbox = [relX, relY, 0, 0];

  // Step 6: Confirm
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  const workspace = wsFolder?.name || '';
  if (log) log(`teachManual: workspace = "${workspace}", showing save confirmation`);

  const confirm = await vscode.window.showInformationMessage(
    `Cursor captured at [${relX.toFixed(3)}, ${relY.toFixed(3)}]. Save this as the Codex input position?`,
    { modal: true },
    'Save'
  );
  if (log) log(`teachManual: confirm result = "${confirm}"`);

  if (confirm !== 'Save') {
    if (log) log('teachManual: user cancelled save (confirm was dismissed)');
    return { ok: false, error: 'User cancelled confirmation' };
  }

  const layout = {
    input: { bbox },
    submit: { kind: 'key', key: 'ENTER' },
    window: { width: win.width, height: win.height },
    workspace,
    taught_by: 'manual'
  };

  const saved = saveLayout(layout, log);
  if (log) log(`teachManual: save result = ${saved}`);
  return saved ? { ok: true, layout } : { ok: false, error: 'Failed to write layout file' };
}

// ---------------------------------------------------------------------------
// VLM teach (explicit opt-in)
// ---------------------------------------------------------------------------

/**
 * VLM-based teach: capture screenshot, send to OpenRouter, parse bbox.
 * MUST be called only after explicit user confirmation.
 *
 * @param {string} apiKey — OpenRouter API key
 * @param {function} log
 * @param {string} [model='openai/gpt-4o-mini']
 * @param {string} [workspace=''] — workspace name for safety interlock
 * @returns {Promise<{ ok: boolean, layout?: object, error?: string }>}
 */
async function teachViaVlm(apiKey, log, model = 'openai/gpt-4o-mini', workspace = '') {
  if (log) log('Starting VLM-based layout teaching...');

  try {
    // 1. Capture screenshot (full virtual screen — all monitors)
    const { buffer, width, height, left: capLeft, top: capTop } = captureScreen();
    if (log) log(`Screen captured: ${width}x${height} origin=(${capLeft},${capTop})`);

    // 2. Get VS Code window rect for coordinate conversion
    const winRect = getVSCodeWindowRect(process.pid);

    // 3. Call OpenRouter VLM
    const base64Image = buffer.toString('base64');
    const vlmResult = await callOpenRouter(apiKey, model, base64Image, log);

    if (!vlmResult?.input?.bbox) {
      return { ok: false, error: 'VLM did not return input bbox' };
    }

    let bbox = vlmResult.input.bbox;

    // Validate bounds
    if (bbox.length !== 4 || !bbox.every(v => typeof v === 'number' && v >= 0 && v <= 1)) {
      return { ok: false, error: `VLM returned invalid bbox: [${bbox.join(', ')}]` };
    }

    // 4. Convert image-relative → absolute screen → window-relative
    //    Image pixel (0,0) maps to absolute screen (capLeft, capTop) because
    //    the capture covers the full virtual screen (which may start at negative coords).
    if (winRect) {
      const screenBbox = bbox;
      bbox = [
        (capLeft + screenBbox[0] * width - winRect.left) / winRect.width,
        (capTop + screenBbox[1] * height - winRect.top) / winRect.height,
        (screenBbox[2] * width) / winRect.width,
        (screenBbox[3] * height) / winRect.height
      ];

      // Clamp to [0,1]
      bbox = bbox.map(v => Math.max(0, Math.min(1, v)));
    }

    const layout = {
      input: { bbox },
      submit: { kind: 'key', key: 'ENTER' },
      window: winRect ? { width: winRect.width, height: winRect.height } : { width, height },
      workspace: workspace,
      taught_by: 'vlm',
      vlm_model: model
    };

    const saved = saveLayout(layout, log);
    if (log) log(`VLM teaching complete: bbox=[${bbox.map(v => v.toFixed(3)).join(', ')}]`);
    return saved ? { ok: true, layout } : { ok: false, error: 'Failed to write layout file' };
  } catch (err) {
    if (log) log(`VLM teaching failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Call OpenRouter chat completions API with a vision prompt.
 * @param {string} apiKey
 * @param {string} model
 * @param {string} base64Image
 * @param {function} [log]
 * @returns {Promise<object>}
 */
function callOpenRouter(apiKey, model, base64Image, log) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: VLM_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
        ]
      }],
      max_tokens: 500,
      temperature: 0.1
    });

    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/coherent-light-designs/ipc-bridge',
        'X-Title': 'CLD IPC Bridge'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          const content = response.choices?.[0]?.message?.content;

          if (!content) {
            return reject(new Error(`Empty VLM response. Status: ${res.statusCode}`));
          }

          // Extract JSON from markdown code blocks if present
          const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/)
            || content.match(/```\s*([\s\S]*?)\s*```/)
            || [null, content];

          const result = JSON.parse(jsonMatch[1].trim());
          resolve(result);
        } catch (err) {
          reject(new Error(`VLM response parse error: ${err.message}`));
        }
      });
    });

    req.on('error', err => reject(new Error(`VLM API error: ${err.message}`)));
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('VLM API timeout (30s)'));
    });

    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Safety interlock
// ---------------------------------------------------------------------------

/**
 * Verify the foreground window title matches expectations.
 * - If expectedWorkspace is set: title must contain that workspace name.
 * - If expectedWorkspace is empty: title must at least contain "Visual Studio Code"
 *   or end with "- Code" (fallback — ensures we're targeting a VS Code window).
 *
 * @param {string} expectedWorkspace
 * @returns {boolean}
 */
function verifyForegroundWindow(expectedWorkspace) {
  const title = getForegroundWindowTitle();
  if (!title) return false; // no foreground window at all

  const lower = title.toLowerCase();

  if (expectedWorkspace) {
    return lower.includes(expectedWorkspace.toLowerCase());
  }

  // Fallback: at least confirm it's a VS Code window
  return lower.includes('visual studio code') || lower.endsWith('- code');
}

module.exports = {
  LAYOUT_FILE,
  loadLayout,
  saveLayout,
  teachManual,
  teachViaVlm,
  verifyForegroundWindow
};
