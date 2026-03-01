/**
 * screen_inject.cjs — PowerShell Screen Automation Helpers
 * --------------------------------------------------------
 * Pure CJS, no native deps. All screen ops via child_process + PowerShell.
 * Patterns adapted from Universal Connector (screen_watcher.js + connector_runtime.js).
 *
 * Safety:
 *   - Clipboard save/restore on paste
 *   - Foreground window title check (safety interlock)
 *   - DPI-aware coordinate conversion
 */

'use strict';

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEMP_DIR = path.join(os.tmpdir(), 'cld-ipc-bridge');

function _ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Screenshot capture
// ---------------------------------------------------------------------------

/**
 * Capture the full virtual screen (all monitors) as PNG buffer.
 * Returns the virtual screen origin (may be negative for left-side monitors)
 * plus width/height so callers can convert between screen and image coords.
 *
 * @returns {{ buffer: Buffer, width: number, height: number, left: number, top: number }}
 */
function captureScreen() {
  _ensureTempDir();
  const outFile = path.join(TEMP_DIR, `cap_${Date.now()}.png`);
  const safeOut = outFile.replace(/\\/g, '\\\\');

  const script = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()
$bmp.Save('${safeOut}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "$($bounds.Left),$($bounds.Top),$($bounds.Width),$($bounds.Height)"
`;

  try {
    const result = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"').replace(/\r?\n/g, '; ')}"`,
      { timeout: 10000, encoding: 'utf8', windowsHide: true }
    ).trim();

    const parts = result.split(',').map(Number);
    const left = parts[0] || 0;
    const top = parts[1] || 0;
    const width = parts[2] || 1920;
    const height = parts[3] || 1080;

    const buffer = fs.readFileSync(outFile);
    try { fs.unlinkSync(outFile); } catch {}
    return { buffer, width, height, left, top };
  } catch (err) {
    try { fs.unlinkSync(outFile); } catch {}
    throw new Error(`Screenshot failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Mouse click
// ---------------------------------------------------------------------------

/**
 * Click at absolute screen coordinates via user32.dll.
 * @param {number} x
 * @param {number} y
 * @param {number} [jitter=3] — random ± pixel offset
 */
function clickAt(x, y, jitter = 3) {
  const jx = Math.round(x + (Math.random() - 0.5) * jitter * 2);
  const jy = Math.round(y + (Math.random() - 0.5) * jitter * 2);

  _ensureTempDir();
  const scriptFile = path.join(TEMP_DIR, `click_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.ps1`);
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinInput {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public static void ClickAt(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(50);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
    }
}
'@
[WinInput]::ClickAt(${jx}, ${jy})
`;

  fs.writeFileSync(scriptFile, script);
  try {
    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`,
      { timeout: 5000, windowsHide: true }
    );
  } finally {
    try { fs.unlinkSync(scriptFile); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Clipboard paste (with save/restore)
// ---------------------------------------------------------------------------

/**
 * Paste text into the focused element via clipboard.
 * Saves and restores clipboard contents.
 * @param {string} text
 */
function pasteText(text) {
  // 1. Save current clipboard
  let prevClip = '';
  try {
    prevClip = execSync(
      'powershell -NoProfile -Command "Get-Clipboard"',
      { timeout: 3000, encoding: 'utf8', windowsHide: true }
    );
  } catch {}

  try {
    // 2. Set clipboard with our text (base64 UTF-16LE for safe encoding)
    const base64Text = Buffer.from(text, 'utf16le').toString('base64');
    execSync(
      `powershell -NoProfile -Command "$text = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${base64Text}')); Set-Clipboard -Value $text"`,
      { timeout: 5000, windowsHide: true }
    );

    // 3. Ctrl+A (select all in input), then Ctrl+V (paste)
    execSync(
      `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^a'); Start-Sleep -Milliseconds 100; [System.Windows.Forms.SendKeys]::SendWait('^v')"`,
      { timeout: 5000, windowsHide: true }
    );
  } finally {
    // 4. Restore clipboard (best-effort, tiny race window)
    try {
      if (prevClip) {
        const prevBase64 = Buffer.from(prevClip, 'utf16le').toString('base64');
        execSync(
          `powershell -NoProfile -Command "$text = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${prevBase64}')); Set-Clipboard -Value $text"`,
          { timeout: 3000, windowsHide: true }
        );
      } else {
        execSync(
          'powershell -NoProfile -Command "Set-Clipboard -Value $null"',
          { timeout: 3000, windowsHide: true }
        );
      }
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Key press
// ---------------------------------------------------------------------------

/**
 * Press Enter key via SendKeys.
 */
function pressEnter() {
  execSync(
    `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')"`,
    { timeout: 5000, windowsHide: true }
  );
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

/**
 * Get VS Code window rect, title, and process name.
 *
 * Search order:
 *   1. If workspaceName given, scan all Code windows for a title match
 *   2. If foreground window is a Code process, use it
 *   3. Fallback: first Code window with a MainWindowHandle
 *
 * @param {number} [_extensionHostPid] — unused (kept for API compat)
 * @param {string} [workspaceName] — workspace to match in window title
 * @returns {{ left: number, top: number, width: number, height: number, title: string, processName: string } | null}
 */
function getVSCodeWindowRect(_extensionHostPid, workspaceName) {
  const safeWs = (workspaceName || '').replace(/'/g, "''");
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinRect {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int nMaxCount);

    public static string GetTitle(IntPtr hWnd) {
        int len = GetWindowTextLength(hWnd);
        if (len == 0) return "";
        var sb = new StringBuilder(len + 1);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
}
'@

$ws = '${safeWs}'
$targetWin = 0
$targetTitle = ""
$targetProc = "unknown"

# Supported editor process names (VS Code, Antigravity/Windsurf, Cursor, etc.)
$editorNames = @('Code', 'Antigravity', 'Cursor', 'Windsurf')

# Strategy 1: Find editor window matching workspace name
if ($ws) {
    foreach ($edName in $editorNames) {
        $edProcs = Get-Process -Name $edName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
        foreach ($p in $edProcs) {
            $title = [WinRect]::GetTitle($p.MainWindowHandle)
            if ($title.ToLower().Contains($ws.ToLower())) {
                $targetWin = $p.MainWindowHandle
                $targetTitle = $title
                $targetProc = $p.ProcessName
                break
            }
        }
        if ($targetWin -ne 0) { break }
    }
}

# Strategy 2: Check if foreground is an editor window
if ($targetWin -eq 0) {
    $fgWin = [WinRect]::GetForegroundWindow()
    $fgPid = 0
    [WinRect]::GetWindowThreadProcessId($fgWin, [ref]$fgPid) | Out-Null
    $fgProc = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
    if ($fgProc -and $editorNames -contains $fgProc.ProcessName) {
        $targetWin = $fgWin
        $targetTitle = [WinRect]::GetTitle($fgWin)
        $targetProc = $fgProc.ProcessName
    }
}

# Strategy 3: First editor window from any supported editor
if ($targetWin -eq 0) {
    foreach ($edName in $editorNames) {
        $proc = Get-Process -Name $edName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($proc) {
            $targetWin = $proc.MainWindowHandle
            $targetTitle = [WinRect]::GetTitle($proc.MainWindowHandle)
            $targetProc = $proc.ProcessName
            break
        }
    }
}

if ($targetWin -ne 0) {
    $rect = New-Object WinRect+RECT
    [WinRect]::GetWindowRect($targetWin, [ref]$rect) | Out-Null
    Write-Output "$($rect.Left),$($rect.Top),$($rect.Right - $rect.Left),$($rect.Bottom - $rect.Top)|$targetProc|$targetTitle"
} else {
    Write-Output "NOTFOUND"
}
`;

  _ensureTempDir();
  const scriptFile = path.join(TEMP_DIR, `winrect_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.ps1`);
  try {
    fs.writeFileSync(scriptFile, script);
    const result = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`,
      { timeout: 8000, encoding: 'utf8', windowsHide: true }
    ).trim();

    if (result === 'NOTFOUND') return null;

    const [rectPart, processName, ...titleParts] = result.split('|');
    const title = titleParts.join('|'); // title may contain |
    const parts = rectPart.split(',').map(Number);
    if (parts.length !== 4 || parts.some(isNaN)) return null;

    return {
      left: parts[0], top: parts[1], width: parts[2], height: parts[3],
      title: title || '',
      processName: processName || ''
    };
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(scriptFile); } catch {}
  }
}

/**
 * Bring a VS Code window to the OS foreground.
 * Essential for screen injection from external IPC clients — chatgpt.sidebarView.focus
 * only focuses the sidebar within VS Code, it doesn't raise the window.
 *
 * Uses WScript.Shell.AppActivate which works from background processes
 * (unlike SetForegroundWindow which Windows restricts to the foreground process).
 *
 * @param {string} [workspaceName] — if provided, activates window whose title contains this
 * @returns {string} — 'ALREADY|title' | 'ACTIVATED|title' | 'NOTFOUND|' | 'ERROR|msg'
 */
function bringVSCodeToForeground(workspaceName) {
  const safeWs = (workspaceName || '').replace(/'/g, "''");
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinCheck {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

    public static string GetTitle(IntPtr hWnd) {
        int len = GetWindowTextLength(hWnd);
        if (len == 0) return "";
        var sb = new System.Text.StringBuilder(len + 1);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
}
'@

$fgWin = [WinCheck]::GetForegroundWindow()
$fgTitle = [WinCheck]::GetTitle($fgWin)
$fgPid = 0
[WinCheck]::GetWindowThreadProcessId($fgWin, [ref]$fgPid) | Out-Null
$fgProc = Get-Process -Id $fgPid -ErrorAction SilentlyContinue

# Check if foreground is already the right editor window
$ws = '${safeWs}'
$editorProcs = @('Code', 'Antigravity', 'Cursor', 'Windsurf')
if ($fgProc -and ($editorProcs -contains $fgProc.ProcessName)) {
    if (-not $ws -or $fgTitle.ToLower().Contains($ws.ToLower())) {
        Write-Output "ALREADY|$fgTitle"
        exit
    }
}

# Use WScript.Shell.AppActivate — works from background processes
$wshell = New-Object -ComObject wscript.shell
$activated = $false

if ($ws) {
    $activated = $wshell.AppActivate($ws)
}

if (-not $activated) {
    $editorTitles = @('Visual Studio Code', 'Antigravity', 'Cursor', 'Windsurf')
    foreach ($title in $editorTitles) {
        $activated = $wshell.AppActivate($title)
        if ($activated) { break }
    }
}

if ($activated) {
    Start-Sleep -Milliseconds 150
    $fgWin2 = [WinCheck]::GetForegroundWindow()
    $fgTitle2 = [WinCheck]::GetTitle($fgWin2)
    Write-Output "ACTIVATED|$fgTitle2"
} else {
    Write-Output "NOTFOUND|"
}
`;

  _ensureTempDir();
  const scriptFile = path.join(TEMP_DIR, `focus_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.ps1`);
  try {
    fs.writeFileSync(scriptFile, script);
    const result = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`,
      { timeout: 5000, encoding: 'utf8', windowsHide: true }
    ).trim();
    return result || 'ERROR|empty';
  } catch (err) {
    return `ERROR|${(err.message || '').slice(0, 100)}`;
  } finally {
    try { fs.unlinkSync(scriptFile); } catch {}
  }
}

/**
 * Get DPI scale factor for primary screen.
 * @returns {number} — e.g. 1.0, 1.25, 1.5, 2.0
 */
function getDpiScale() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DpiHelper {
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr hdc, int nIndex);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    public static int GetDpi() {
        IntPtr hdc = GetDC(IntPtr.Zero);
        int dpi = GetDeviceCaps(hdc, 88);
        ReleaseDC(IntPtr.Zero, hdc);
        return dpi;
    }
}
'@
$dpi = [DpiHelper]::GetDpi()
Write-Output ($dpi / 96.0)
`;

  try {
    const result = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"').replace(/\r?\n/g, '; ')}"`,
      { timeout: 5000, encoding: 'utf8', windowsHide: true }
    ).trim();

    const scale = parseFloat(result);
    return (scale > 0 && scale < 10) ? scale : 1.0;
  } catch {
    return 1.0;
  }
}

/**
 * Get foreground window title (for safety interlock).
 * @returns {string}
 */
function getForegroundWindowTitle() {
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FgWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    public static string GetTitle() {
        IntPtr h = GetForegroundWindow();
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        return sb.ToString();
    }
}
'@
Write-Output ([FgWin]::GetTitle())
`;

  try {
    return execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"').replace(/\r?\n/g, '; ')}"`,
      { timeout: 3000, encoding: 'utf8', windowsHide: true }
    ).trim();
  } catch {
    return '';
  }
}

/**
 * Get current mouse position (absolute screen coords).
 * @returns {{ x: number, y: number } | null}
 */
function getMousePosition() {
  try {
    const result = execSync(
      `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $p = [System.Windows.Forms.Cursor]::Position; Write-Output \\"$($p.X),$($p.Y)\\""`,
      { timeout: 3000, encoding: 'utf8', windowsHide: true }
    ).trim();

    const [x, y] = result.split(',').map(Number);
    if (isNaN(x) || isNaN(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

module.exports = {
  captureScreen,
  clickAt,
  pasteText,
  pressEnter,
  getVSCodeWindowRect,
  bringVSCodeToForeground,
  getDpiScale,
  getForegroundWindowTitle,
  getMousePosition
};
