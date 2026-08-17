# Clipboardian

A small background app that remembers your clipboard text history and lets you
pull up a searchable popup with a global hotkey to grab an older item back
onto the clipboard.

Built for GNOME. Tracks the `CLIPBOARD` selection only (explicit Ctrl+C
copies) — not the mouse-select/middle-click `PRIMARY` selection.

## Setup

**Super+V** will be setup as the keyboard shortcut for Clipboardian (or **Super+Shift+V**, if Super+V is taken).
You can check if either is free in GNOME Settings → Keyboard → View and Customize Shortcuts.

Two ways to setup Clipboardian — pick one.

### Option 1: Using AppImage

**Prerequisite: FUSE** — lets an AppImage self-mount and run at all.
One-time, system-wide install:
```bash
sudo apt install libfuse2   # most Ubuntu versions
```

Download the latest `.AppImage` from the [Releases page](../../releases).

Double-click the AppImage or run it from a terminal:
```bash
./Clipboardian-<version>.AppImage
```

<details>
<summary>Troubleshooting: can't install libfuse2</summary>
After downloading the AppImage, run:

```bash
./Clipboardian-<version>.AppImage --appimage-extract-and-run
```
</details>

<details>
<summary>Building the AppImage yourself instead of downloading it</summary>

```bash
git clone https://github.com/notalanjoseph/clipboardian.git
cd clipboardian
pnpm run dist   # produces dist/Clipboardian-<version>.AppImage
```
</details>

### Option 2: Using source code

```bash
git clone https://github.com/notalanjoseph/clipboardian.git
cd clipboardian
```

```bash
chmod +x ./setup.sh
./setup.sh
```
The setup script installs deps, builds, registers the hotkey, sets up autostart.
Autostart won't kick in until your next login, so to try it immediately:
```bash
pnpm start   # quits cleanly on Ctrl+C, or use the tray icon's Quit
```

## Usage

- The app runs in the background; look for its icon in the system tray.
- Press assigned keyboard shortcut anywhere to open the history popup.
- Type to filter, **↑/↓** to move the selection, **Enter** to pick an item.
- **Ctrl+V** normally to paste it wherever you need.
- **Esc** or clicking away closes the popup without changing the clipboard.
- History persists across restarts and is capped at the 500 most recent entries.
- Tray icon → **Quit** stops it completely, nothing gets recorded.
- Delete `~/.config/autostart/clipboardian.desktop` if you don't want autostart.

## Uninstalling

Tray icon → **"Uninstall..."** removes the global hotkey and the
autostart entry, then quits.

The one thing it doesn't
do is delete the app itself. Remove the cloned repo, or the `.AppImage`
file, whenever you're done.

## Releasing

`.github/workflows/release.yml` builds the AppImage and publishes a
GitHub Release automatically whenever a tag matching `v*` is pushed:

```bash
pnpm version major   # or minor/patch — bumps package.json, commits, tags locally
git push
git push --follow-tags   # push the new tag
```

## Future improvements

- **Auto-paste on selection.** Right now picking an item just puts it on the
  clipboard and you press Ctrl+V yourself. True auto-paste needs `ydotool` plus a root-privileged `uinput` daemon on Wayland.
- **Image support.** History is text-only for now; storing/thumbnailing
  copied images would need schema changes (blob storage or on-disk files)
  and a different popup UI.
- **Broader Linux support.** Built and tested specifically against GNOME on
  Wayland (Ubuntu 24.04). Other desktop environments (KDE, XFCE, Sway) and
  X11 sessions would need their own hotkey-registration path and possibly a different clipboard watch mechanism.
- **Pinned entries.** Exposing a pin/star action in the popup would
  let favorites survive the 500-entry prune instead of aging out.
- **Delete individual entries / clear history.** There's currently no way to
  remove a single item — only age-based pruning
  does that.
- **Sensitive-content exclusion.** Nothing currently stops a password copied
  from a password manager from landing in plaintext history.
- **Quicker selection.** Number-key shortcuts (1–9) to instantly pick one of
  the top entries, instead of always arrow-navigating + Enter.
- **Cursor-relative popup position.** It's centered on the screen for now — positioning near the cursor would feel more
  natural for a keyboard-driven popup.
- **Configurable history size.** The 500-entry cap is hardcoded; could be a
  simple setting instead.
- **Configurable keyboard shortcut.** During installation and during run from tray.
- **Configurable autostart.** During installation and during run from tray.
- **`.deb` packaging.** AppImage works today; a `.deb` target would suit
  Debian/Ubuntu users who prefer `apt`/`dpkg` over a standalone binary.
- **Broader automated tests.** `pnpm test` covers `store.ts`'s
  dedup/prune/search logic (the piece most worth testing, since it's pure
  logic with no Electron/GUI dependency). The
  Electron main-process wiring, renderer, and real GUI interaction still
  have no automated coverage.

## License

GPLv3 — see [LICENSE](./LICENSE). Copyright (C) 2026 Alan Joseph.
