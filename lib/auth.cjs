/**
 * auth.cjs — Token generation, validation, and file management
 * -------------------------------------------------------------
 * Ephemeral per-session tokens. Regenerated on each VS Code activation.
 * Token file written with restricted permissions (current user only).
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOKEN_BYTES = 32; // 64-char hex string
const AUTH_TIMEOUT_MS = 5000;

/**
 * Generate a new random auth token (hex string).
 */
function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * First 8 chars of token — safe to include in registry for debugging.
 */
function tokenHint(token) {
  return token ? token.slice(0, 8) : '';
}

/**
 * Write token to file with restricted permissions (Windows: current user only).
 * @param {string} tokenDir - directory for token files
 * @param {string} instanceId - unique instance identifier
 * @param {string} token - the auth token
 * @returns {string} path to token file
 */
function writeTokenFile(tokenDir, instanceId, token) {
  // Guard against path traversal (instanceId must be 8 hex chars)
  if (!/^[0-9a-f]{8}$/.test(instanceId)) {
    throw new Error('Invalid instanceId for writeTokenFile');
  }
  // Create token directory with restricted permissions
  fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });

  const tokenPath = path.join(tokenDir, `${instanceId}.token`);
  // Use random suffix to prevent PID-collision race conditions
  const tmpPath = `${tokenPath}.tmp.${crypto.randomBytes(4).toString('hex')}`;

  // Atomic write: tmp → rename
  // Write with restricted permissions from the start (non-Windows)
  fs.writeFileSync(tmpPath, token, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmpPath, tokenPath);
  } catch {
    // Windows may need delete-then-rename
    try { fs.unlinkSync(tokenPath); } catch {}
    fs.renameSync(tmpPath, tokenPath);
  }

  // Platform-specific permission hardening
  if (process.platform === 'win32') {
    // Windows: restrict ACL to current user only
    try {
      const username = process.env.USERNAME || process.env.USER;
      if (username) {
        // Validate username doesn't contain shell metacharacters
        if (/^[a-zA-Z0-9._@\- ]+$/.test(username)) {
          execFileSync('icacls', [
            tokenPath, '/inheritance:r', '/grant:r', `${username}:(F)`, '/Q'
          ], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
        } else {
          console.warn('[IPC-Bridge] WARNING: Username contains special characters, skipping ACL restriction');
        }
      }
    } catch (err) {
      // Log the failure loudly — security-relevant event
      console.warn(`[IPC-Bridge] WARNING: Failed to restrict token file permissions: ${err.message}`);
      console.warn(`[IPC-Bridge] Token file may be readable by other processes`);
    }
  } else {
    // Unix/macOS: enforce 0600 (owner read/write only)
    try {
      fs.chmodSync(tokenPath, 0o600);
    } catch (err) {
      console.warn(`[IPC-Bridge] WARNING: Failed to chmod token file: ${err.message}`);
    }
  }

  return tokenPath;
}

/**
 * Read token from file (client-side).
 * @param {string} tokenDir
 * @param {string} instanceId
 * @returns {string|null}
 */
function readTokenFile(tokenDir, instanceId) {
  // Guard against path traversal (instanceId must be 8 hex chars)
  if (!/^[0-9a-f]{8}$/.test(instanceId)) return null;
  const tokenPath = path.join(tokenDir, `${instanceId}.token`);
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Delete token file (cleanup on deactivate).
 */
function deleteTokenFile(tokenDir, instanceId) {
  // Guard against path traversal (instanceId must be 8 hex chars)
  if (!/^[0-9a-f]{8}$/.test(instanceId)) return;
  const tokenPath = path.join(tokenDir, `${instanceId}.token`);
  try { fs.unlinkSync(tokenPath); } catch {}
}

module.exports = {
  generateToken,
  safeCompare,
  tokenHint,
  writeTokenFile,
  readTokenFile,
  deleteTokenFile,
  AUTH_TIMEOUT_MS
};
