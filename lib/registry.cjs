/**
 * registry.cjs — Instance registry file CRUD + cleanup
 * -----------------------------------------------------
 * Each VS Code instance writes a JSON file to a shared directory.
 * External clients scan this directory to discover running instances.
 *
 * Registry dir: %APPDATA%\CoherentLight\ipc-bridge\instances\
 * Token dir:    %APPDATA%\CoherentLight\ipc-bridge\tokens\
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Validation: instanceId must be hex (from generateInstanceId)
const INSTANCE_ID_RE = /^[0-9a-f]{8}$/;
// PID must be a positive integer within reasonable range
const MAX_PID = 4194304; // Linux max; Windows is 2^32 but this is safe enough

const BASE_DIR = path.join(
  process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming'),
  'CoherentLight', 'ipc-bridge'
);
const INSTANCES_DIR = path.join(BASE_DIR, 'instances');
const TOKENS_DIR = path.join(BASE_DIR, 'tokens');

/**
 * Create a directory with restricted permissions (current user only).
 */
function mkdirRestricted(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });

  // Windows: restrict ACL
  if (process.platform === 'win32') {
    try {
      const username = process.env.USERNAME || process.env.USER;
      if (username && /^[a-zA-Z0-9._@\- ]+$/.test(username)) {
        execFileSync('icacls', [
          dirPath, '/inheritance:r', '/grant:r', `${username}:(OI)(CI)(F)`, '/Q'
        ], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
      }
    } catch (err) {
      console.warn(`[IPC-Bridge] WARNING: Failed to restrict directory permissions: ${err.message}`);
    }
  }
}

/**
 * Validate an instanceId is safe for use in filenames.
 * @param {string} id
 * @returns {boolean}
 */
function isValidInstanceId(id) {
  return typeof id === 'string' && INSTANCE_ID_RE.test(id);
}

/**
 * Validate a PID is a reasonable positive integer.
 * @param {*} pid
 * @returns {boolean}
 */
function isValidPid(pid) {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid <= MAX_PID;
}

/**
 * Generate a short unique instance ID (8 hex chars).
 */
function generateInstanceId() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Compute a stable hash from a workspace path (for pipe naming).
 */
function workspaceHash(workspacePath) {
  return crypto.createHash('sha256')
    .update(workspacePath || 'global')
    .digest('hex')
    .slice(0, 6);
}

/**
 * Compute the named pipe path for an instance.
 */
function pipeName(wsHash, instanceId) {
  return `\\\\.\\pipe\\cld-ipc-bridge.${wsHash}.${instanceId}`;
}

/**
 * Write a registry entry (atomic write: tmp → rename).
 * @param {object} entry
 * @param {string} entry.instanceId
 * @param {string} entry.pipe
 * @param {string} entry.workspaceName
 * @param {string} entry.workspacePath
 * @param {number} entry.pid
 * @param {string} [entry.tokenHint] - STRIPPED before write (not persisted)
 * @param {object} entry.capabilities
 */
function writeRegistry(entry) {
  if (!isValidInstanceId(entry.instanceId)) {
    throw new Error('Invalid instanceId');
  }

  mkdirRestricted(INSTANCES_DIR);

  const filePath = path.join(INSTANCES_DIR, `${entry.instanceId}.json`);
  const tmpPath = `${filePath}.tmp.${crypto.randomBytes(4).toString('hex')}`;

  // Strip tokenHint — no token material in discovery-readable files
  const { tokenHint: _stripped, ...safeEntry } = entry;
  const data = {
    ...safeEntry,
    startedAt: new Date().toISOString(),
    v: 1
  };

  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    try { fs.unlinkSync(filePath); } catch {}
    fs.renameSync(tmpPath, filePath);
  }

  return filePath;
}

/**
 * Update capabilities in an existing registry entry.
 */
function updateCapabilities(instanceId, capabilities) {
  if (!isValidInstanceId(instanceId)) return;

  const filePath = path.join(INSTANCES_DIR, `${instanceId}.json`);
  try {
    const entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Strip tokenHint if it snuck in from an older version
    delete entry.tokenHint;
    entry.capabilities = capabilities;
    entry.updatedAt = new Date().toISOString();
    const tmpPath = `${filePath}.tmp.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.renameSync(tmpPath, filePath); }
    catch { try { fs.unlinkSync(filePath); } catch {} fs.renameSync(tmpPath, filePath); }
  } catch {}
}

/**
 * Delete a registry entry (cleanup on deactivate).
 */
function deleteRegistry(instanceId) {
  if (!isValidInstanceId(instanceId)) return;
  const filePath = path.join(INSTANCES_DIR, `${instanceId}.json`);
  try { fs.unlinkSync(filePath); } catch {}
}

/**
 * Read all registry entries. Client-side discovery.
 * @returns {Array<object>} array of registry entries
 */
function readAllRegistries() {
  try {
    mkdirRestricted(INSTANCES_DIR);
    const files = fs.readdirSync(INSTANCES_DIR)
      .filter(f => f.endsWith('.json') && !f.includes('.tmp.'));
    return files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, f), 'utf8'));
        // Strip tokenHint from returned data (defense in depth)
        delete data.tokenHint;
        return data;
      } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if a PID is alive.
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(pid, 0); // Signal 0 = check existence, don't kill
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean stale registry entries (PID dead).
 * @returns {number} count of cleaned entries
 */
function cleanStale() {
  const entries = readAllRegistries();
  let cleaned = 0;
  for (const entry of entries) {
    if (!isValidInstanceId(entry.instanceId)) continue;
    if (entry.pid && !isPidAlive(entry.pid)) {
      deleteRegistry(entry.instanceId);
      // Also clean token file
      const tokenPath = path.join(TOKENS_DIR, `${entry.instanceId}.token`);
      try { fs.unlinkSync(tokenPath); } catch {}
      cleaned++;
    }
  }
  return cleaned;
}

/**
 * Find a registry entry matching criteria.
 * Priority: exact instanceId > exact workspacePath > fuzzy workspaceName
 * @param {object} criteria
 * @param {string} [criteria.instanceId]
 * @param {string} [criteria.workspacePath]
 * @param {string} [criteria.workspaceName]
 * @param {string} [criteria.editorName] - e.g., 'antigravity', 'visual studio code'
 * @returns {object|null}
 */
function findInstance(criteria) {
  const entries = readAllRegistries().filter(e => e.pid && isPidAlive(e.pid));

  if (criteria.instanceId) {
    return entries.find(e => e.instanceId === criteria.instanceId) || null;
  }

  if (criteria.workspacePath) {
    const exact = entries.find(e =>
      e.workspacePath && e.workspacePath.toLowerCase() === criteria.workspacePath.toLowerCase()
    );
    if (exact) return exact;
  }

  if (criteria.workspaceName) {
    const matches = entries.filter(e =>
      e.workspaceName && e.workspaceName.toLowerCase().includes(criteria.workspaceName.toLowerCase())
    );
    if (matches.length > 0) {
      // If a target is specified, prefer instance where that target is available
      if (criteria.target) {
        const withTarget = matches.find(e =>
          e.capabilities?.targets?.[criteria.target]?.available === true
        );
        if (withTarget) return withTarget;
      }
      return matches[0];
    }
  }

  // Filter by editor type if specified
  if (criteria.editorName) {
    const editorMatches = entries.filter(e =>
      e.editorName && e.editorName.toLowerCase().includes(criteria.editorName.toLowerCase())
    );
    if (editorMatches.length > 0) {
      // Prefer instance where the requested target is available
      if (criteria.target) {
        const withTarget = editorMatches.find(e =>
          e.capabilities?.targets?.[criteria.target]?.available === true
        );
        if (withTarget) return withTarget;
      }
      return editorMatches[0];
    }
    // editorName not found — fall through to target-based lookup so editors
    // with different vscode.env.appName values (e.g. 'windsurf' for Windsurf IDE)
    // are still found by their available adapter target.
  }

  // Target-based fallback: find any instance that has the requested target available
  if (criteria.target) {
    const withTarget = entries.filter(e =>
      e.capabilities?.targets?.[criteria.target]?.available === true
    );
    if (withTarget.length === 1) return withTarget[0];
    if (withTarget.length > 1) return withTarget[0]; // pick first available
  }

  // If only one instance running, return it
  if (entries.length === 1) return entries[0];

  return null;
}

/**
 * Find all instances belonging to a specific editor.
 * @param {string} editorName - e.g., 'antigravity', 'visual studio code'
 * @returns {Array<object>}
 */
function findInstancesByEditor(editorName) {
  const entries = readAllRegistries().filter(e => e.pid && isPidAlive(e.pid));
  if (!editorName) return entries;
  return entries.filter(e =>
    e.editorName && e.editorName.toLowerCase().includes(editorName.toLowerCase())
  );
}

module.exports = {
  BASE_DIR,
  INSTANCES_DIR,
  TOKENS_DIR,
  generateInstanceId,
  isValidInstanceId,
  isValidPid,
  workspaceHash,
  pipeName,
  writeRegistry,
  updateCapabilities,
  deleteRegistry,
  readAllRegistries,
  isPidAlive,
  cleanStale,
  findInstance,
  findInstancesByEditor
};
