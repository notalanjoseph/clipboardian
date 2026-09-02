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

    const buildTrayMenu = (binding: string | null) => {
      return Menu.buildFromTemplate([
        { label: "CLIPBOARDIAN", enabled: false },
        { label: `Hotkey: ${binding ?? "not set"}`, enabled: false },
        {
          label: "Change Hotkey...",
          click: () => appImageSetup.openHotkeySettings(),
        },
        { type: "separator" },
        {
          label: "Uninstall...",
          click: async () => {
            const result = await dialog.showMessageBox({
              type: "warning",
              buttons: ["Cancel", "Uninstall"],
              defaultId: 0,
              cancelId: 0,
              message: "Uninstall Clipboardian?",
              detail:
                "Removes the keyboard shortcut and disables autostart. Clipboardian will quit.\nAppImage (or code files) can be manually deleted.",
              checkboxLabel: "Also delete clipboard history",
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
        { type: "separator" },
        {
          label: "Quit",
          click: async () => {
            const result = await dialog.showMessageBox({
              type: "question",
              buttons: ["Cancel", "Quit"],
              defaultId: 1,
              cancelId: 0,
              message: "Quit Clipboardian?",
              detail:
                "Clipboard copies won't be recorded while it's not running.\n" +
                "Press the hotkey to relaunch Clipboardian.",
              checkboxLabel: "Also delete clipboard history",
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
      ]);
    };

    let lastKnownBinding = appImageSetup.currentBindingLabel();
    tray.setContextMenu(buildTrayMenu(lastKnownBinding));

    // Poll for hotkey changes made via GNOME Settings rather than relying on
    // Electron's Tray 'click' event — confirmed by real-world testing (not
    // assumption) that GNOME's tray protocol shows the previously-set menu
    // directly, without giving Electron a reliable hook to rebuild it first.
    // 3s is frequent enough to feel live for a rare, manual action (rebinding
    // a hotkey) without meaningful overhead — only rebuilds the menu when the
    // binding actually changed, not on every tick.
    setInterval(() => {
      if (!tray) return;
      const binding = appImageSetup.currentBindingLabel();
      if (binding !== lastKnownBinding) {
        lastKnownBinding = binding;
        tray.setContextMenu(buildTrayMenu(binding));
      }
    }, 3000);

    const isHotkeyToggle = process.argv.includes(TOGGLE_ARG);
    if (isHotkeyToggle) {
      popupWindow.toggle();
    }

    // Best-effort housekeeping. No-op unless running as a packaged AppImage.
    // Popup toggling above already happened, unblocked, so moving this
    // ahead of the notifyRelaunched() decision below doesn't delay a
    // hotkey-triggered launch — only the (non-performance-critical) decision
    // of whether to also show a relaunch notification is affected. This
    // ordering (not "run last" as before) is required: its return value
    // tells us whether it already notified this run (hotkey newly bound, or
    // newly discovered as unbindable), so a launch that both relaunches
    // *and* resolves the hotkey doesn't show two contradictory
    // notifications back to back — see AGENTS.md correction.
    const notifiedByHotkeySetup = appImageSetup.ensureHotkeyAndAutostart();

    if (!isHotkeyToggle && alreadyConfigured && !notifiedByHotkeySetup) {
      // Plain double-click that relaunched the (previously quit) app, with
      // nothing new to report about the hotkey this run.
      appImageSetup.notifyRelaunched();
    }

    // Rebuild the tray menu now that the hotkey may have just been decided
    // for the first time — the initial buildTrayMenu() call above ran
    // before ensureHotkeyAndAutostart(), so a genuinely first-ever AppImage
    // launch would otherwise show "Hotkey: not set" even after one gets
    // assigned moments later.
    lastKnownBinding = appImageSetup.currentBindingLabel();
    if (tray) tray.setContextMenu(buildTrayMenu(lastKnownBinding));
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
