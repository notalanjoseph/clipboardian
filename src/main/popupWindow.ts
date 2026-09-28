import { BrowserWindow, screen } from 'electron';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { stageToDip, placeAtCursor } from './popupPlacement';

const WINDOW_WIDTH = 480;
const WINDOW_HEIGHT = 360;

let win: BrowserWindow | null = null;

// The real pointer position, from the bundled GNOME Shell extension
// (gnome-extension/). Electron's own screen.getCursorScreenPoint() goes
// through XWayland, which is only told the pointer position while it's over
// an X11 window — confirmed frozen for 30s over native Wayland windows on
// this machine, see AGENTS.md. null when the extension isn't installed/enabled
// (gdbus fails fast with UnknownObject) or GNOME Shell doesn't answer in time.
function pointerFromShell(): { x: number; y: number } | null {
  try {
    const out = execFileSync(
      'gdbus',
      [
        'call', '--session',
        '--dest', 'org.gnome.Shell',
        '--object-path', '/io/github/notalanjoseph/Clipboardian',
        '--method', 'io.github.notalanjoseph.Clipboardian.GetPointer',
      ],
      // Blocks the main process on every show: typically 4-10ms, capped low so
      // a slow shell delays the popup by at most this much.
      { encoding: 'utf8', timeout: 100, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = /\((-?\d+), (-?\d+)\)/.exec(out);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

// Whether Mutter's GNOME 47+ xwayland-native-scaling is on. Read once per
// process: changing Mutter's experimental features only takes effect after
// a re-login, which restarts this app too.
let nativeScalingCache: boolean | null = null;
function xwaylandNativeScaling(): boolean {
  if (nativeScalingCache === null) {
    try {
      const out = execFileSync(
        'gsettings',
        ['get', 'org.gnome.mutter', 'experimental-features'],
        { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      nativeScalingCache = out.includes("'xwayland-native-scaling'");
    } catch {
      nativeScalingCache = false;
    }
  }
  return nativeScalingCache;
}

function position(): void {
  if (!win) return;
  const pointer = pointerFromShell();
  if (!pointer) {
    const { workArea } = screen.getPrimaryDisplay();
    const x = Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2);
    const y = Math.round(workArea.y + (workArea.height - WINDOW_HEIGHT) / 3);
    win.setPosition(x, y);
    return;
  }
  // See popupPlacement.ts for why each HiDPI mode converts the way it does.
  const cursor = stageToDip(
    pointer,
    screen.getPrimaryDisplay().scaleFactor,
    xwaylandNativeScaling(),
  );
  const { x, y } = placeAtCursor(
    cursor,
    screen.getDisplayNearestPoint(cursor).workArea,
    WINDOW_WIDTH,
    WINDOW_HEIGHT,
  );
  win.setPosition(x, y);
}

export function createHidden(): void {
  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('blur', () => hide());
  win.on('close', (e) => {
    // Keep the window pre-warmed; only main.ts's explicit app quit should destroy it.
    e.preventDefault();
    hide();
  });
}

export function isVisible(): boolean {
  return !!win && win.isVisible();
}

export function show(): void {
  if (!win) return;
  position();
  win.webContents.send('reset-search');
  win.show();
  win.focus();
}

export function hide(): void {
  if (!win) return;
  win.hide();
}

export function toggle(): void {
  if (isVisible()) hide();
  else show();
}

export function destroy(): void {
  if (win) {
    win.removeAllListeners('close');
    win.destroy();
    win = null;
  }
}
