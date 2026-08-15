import { app, Tray, Menu } from 'electron';
import * as path from 'path';
import * as store from './store';
import * as clipboardWatcher from './clipboardWatcher';
import * as popupWindow from './popupWindow';
import * as ipcHandlers from './ipcHandlers';

const TOGGLE_ARG = '--toggle-popup';

let tray: Tray | null = null;
let quitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes(TOGGLE_ARG)) popupWindow.toggle();
  });

  app.whenReady().then(() => {
    store.init();
    ipcHandlers.register();
    clipboardWatcher.start((text) => store.addEntry(text));
    popupWindow.createHidden();

    tray = new Tray(path.join(__dirname, '..', 'renderer', 'tray-icon.png'));
    tray.setToolTip('Clipboardian');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Clipboardian', enabled: false },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );

    if (process.argv.includes(TOGGLE_ARG)) popupWindow.toggle();
  });

  // Electron doesn't quit on Ctrl+C by default (nothing installs a SIGINT
  // handler) — needed for running via `pnpm start` in a foreground terminal
  // during development, in addition to the tray icon's Quit item.
  process.on('SIGINT', () => {
    quitting = true;
    app.quit();
  });
  process.on('SIGTERM', () => {
    quitting = true;
    app.quit();
  });

  app.on('window-all-closed', () => {
    // The popup window hides rather than closes (see popupWindow.ts), so this
    // should never actually fire during normal operation; no-op just in case.
  });

  app.on('before-quit', () => {
    quitting = true;
    clipboardWatcher.stop();
    popupWindow.destroy();
  });

  app.on('will-quit', () => {
    if (!quitting) clipboardWatcher.stop();
  });
}
