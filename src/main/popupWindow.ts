import { BrowserWindow, screen } from 'electron';
import * as path from 'path';

const WINDOW_WIDTH = 480;
const WINDOW_HEIGHT = 360;

let win: BrowserWindow | null = null;

function position(): void {
  if (!win) return;
  const { workArea } = screen.getPrimaryDisplay();
  const x = Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2);
  const y = Math.round(workArea.y + (workArea.height - WINDOW_HEIGHT) / 3);
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
