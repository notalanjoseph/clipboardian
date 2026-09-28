# Clipboardian

A small background app that remembers your clipboard text history and lets you
pull up a searchable popup with a global hotkey to grab an older item back
onto the clipboard.

Built for GNOME. Tracks the `CLIPBOARD` selection only (explicit Ctrl+C
copies) — not the mouse-select/middle-click `PRIMARY` selection.

## Setup

**Super+V** will be setup as the keyboard shortcut for Clipboardian
(or **Super+Shift+V**, if Super+V is taken).
You can check if either is free in GNOME Settings → Keyboard → View and Customize Shortcuts.

### Using AppImage

1. **Prerequisite: FUSE** — lets an AppImage self-mount and run.
   One-time, system-wide install:

   ```bash
   sudo apt install libfuse2   # most Ubuntu versions
   ```

2. Download the latest `Clipboardian-<version>.AppImage` from the [Releases page](../../releases).

3. Double-click the AppImage or run it from a terminal:

   ```bash
   ./Clipboardian-<version>.AppImage
   ```

<details> <summary>Unable to install libfuse2?</summary>
After downloading the AppImage, run:

```bash
./Clipboardian-<version>.AppImage --appimage-extract-and-run
```
</details>

<details> <summary>Want to build the AppImage instead of downloading it?</summary>

```bash
git clone https://github.com/notalanjoseph/clipboardian.git
cd clipboardian
pnpm install
pnpm run dist   # produces dist/Clipboardian-<version>.AppImage
```
</details>

<details> <summary>Previously installed from source with <code>setup.sh</code>?</summary>

`setup.sh` has been removed; the AppImage is now the only install method.
Quit the running Clipboardian from the tray (so the AppImage isn't blocked by
it), then run the AppImage — it takes over the existing hotkey (keeping your
binding) and autostart entry automatically, and adds the cursor-position
GNOME Shell extension (log out and back in once for that).
</details>

## Usage

- After setup, **log out and back in once** for full Clipboardian features.
- The app runs in the background; look for its icon in the system tray.
- Press assigned keyboard shortcut anywhere to open the history popup.
- Type to search upto previous 500 entries; **↑/↓** moves the selection.
- **Enter** to pick an item; **Esc** to close the popup.
- **Ctrl+V** normally to paste it wherever you need.
- **Change View** in Tray icon sets how many entries the popup shows (default 25).
Lowering it only hides older entries. Older entries upto 500 are still searchable.
- **Quit** in Tray icon stops Clipboardian, nothing gets recorded. Press hotkey to restart it.
- Delete `~/.config/autostart/clipboardian.desktop` if you don't want autostart.
- Popup stopped opening at the mouse cursor after a GNOME upgrade? Check the
[Releases page](../../releases) for a newer Clipboardian that supports it.

## Uninstalling

Tray icon → **"Uninstall..."** removes the global hotkey, the
autostart entry and the GNOME Shell extension, then quits.

The one thing it doesn't do is delete the app itself.
Delete the `.AppImage` whenever you're done.

## Development

```bash
pnpm install
pnpm start      # build + run from source; Ctrl+C or the tray's Quit to stop
pnpm test       # store.ts unit tests
pnpm run dist   # build the AppImage, to test the installed flow end to end
```

`pnpm start` doesn't register the hotkey, autostart or GNOME Shell extension —
that only happens when running as an AppImage. To open the popup of a
`pnpm start` instance, run `./node_modules/.bin/electron --no-sandbox . --toggle-popup`.

## Releasing

`.github/workflows/release.yml` builds the AppImage and publishes a
GitHub Release automatically whenever a tag matching `v*` is pushed:

```bash
pnpm version major   # or minor/patch — bumps package.json, commits, tags locally
git push
git push --follow-tags   # push the new tag
```

## Future improvements

- **Broader Linux support.** Built and tested specifically against GNOME on
  Wayland (Ubuntu 24.04). Other desktop environments (KDE, XFCE, Sway) and
  X11 sessions would need their own hotkey-registration path and possibly a different clipboard watch mechanism.
- **`.deb` packaging.** AppImage works today; a `.deb` target would suit
  Debian/Ubuntu users who prefer `apt`/`dpkg` over a standalone binary.
- **Broader automated tests.** `pnpm test` covers `store.ts`'s
  dedup/prune/search logic (the piece most worth testing, since it's pure
  logic with no Electron/GUI dependency). The
  Electron main-process wiring, renderer, and real GUI interaction still
  have no automated coverage.
- **Auto-paste on selection.** Right now picking an item just puts it on the
  clipboard and you press Ctrl+V yourself. True auto-paste needs `ydotool` plus a root-privileged `uinput` daemon on Wayland.
- **Image support.** History is text-only for now; storing/thumbnailing
  copied images would need schema changes (blob storage or on-disk files)
  and a different popup UI.
- **Pinned entries.** Exposing a pin/star action in the popup would
  let favorites survive the 500-entry prune instead of aging out.
- **Delete individual entries / clear history.** There's currently no way to
  remove a single item — only age-based pruning does that.
- **Sensitive-content exclusion.** Nothing currently stops a password copied
  from a password manager from landing in plaintext history.
- **Configurable autostart.** During installation and during run from tray.

## License

GPLv3 — see [LICENSE](./LICENSE). Copyright (C) 2026 Alan Joseph.
