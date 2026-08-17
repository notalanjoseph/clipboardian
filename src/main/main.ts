import { app, Tray, Menu, dialog } from 'electron';
import * as path from 'path';
import * as store from './store';
import * as clipboardWatcher from './clipboardWatcher';
import * as popupWindow from './popupWindow';
import * as ipcHandlers from './ipcHandlers';
import * as appImageSetup from './appImageSetup';

const TOGGLE_ARG = '--toggle-popup';

let tray: Tray | null = null;
let quitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes(TOGGLE_ARG)) {
      popupWindow.toggle();
    } else {
      // A plain double-click while already running — no-op otherwise, so
      // let the user know rather than leaving them wondering why nothing
      // happened.
      appImageSetup.notifyAlreadyRunning();
    }
  });

  app.whenReady().then(() => {
    // Captured before ensureHotkeyAndAutostart() runs, so a genuinely
    // first-ever launch (which gets its own one-time "hotkey bound"
    // notification) doesn't also get this one — only later double-click
    // relaunches do.
    const alreadyConfigured = appImageSetup.isHotkeyConfigured();

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
          label: 'Uninstall...',
          click: async () => {
            const result = await dialog.showMessageBox({
              type: 'warning',
              buttons: ['Cancel', 'Uninstall'],
              defaultId: 0,
              cancelId: 0,
              message: 'Uninstall Clipboardian?',
              detail:
                'Removes the keyboard shortcut and disables autostart. Clipboardian will quit.\nAppImage (or code files) can be manually deleted.',
              checkboxLabel: 'Also delete clipboard history',
              checkboxChecked: false,
            });
            if (result.response !== 1) return;
            quitting = true;
            clipboardWatcher.stop();
            popupWindow.destroy();
            appImageSetup.uninstall();
            if (result.checkboxChecked) store.wipeData();
            app.quit();
          },
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: async () => {
            const result = await dialog.showMessageBox({
              type: 'question',
              buttons: ['Cancel', 'Quit'],
              defaultId: 1,
              cancelId: 0,
              message: 'Quit Clipboardian?',
              detail:
                "Clipboard copies won't be recorded while it's not running.\n" +
                'Pressing the hotkey again to relaunch Clipboardian.',
              checkboxLabel: 'Also delete clipboard history',
              checkboxChecked: false,
            });
            if (result.response !== 1) return;
            quitting = true;
            clipboardWatcher.stop();
            popupWindow.destroy();
            if (result.checkboxChecked) store.wipeData();
            app.quit();
          },
        },
      ]),
    );

    if (process.argv.includes(TOGGLE_ARG)) {
      popupWindow.toggle();
    } else if (alreadyConfigured) {
      // Plain double-click that relaunched the (previously quit) app.
      appImageSetup.notifyRelaunched();
    }

    // Best-effort housekeeping, run last so it never delays the tray icon
    // or the popup showing. No-op unless running as a packaged AppImage.
    appImageSetup.ensureHotkeyAndAutostart();
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
