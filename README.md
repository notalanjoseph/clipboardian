# Clipboardian

A small background app that remembers your clipboard text history and lets you
pull up a searchable popup with a global hotkey to grab an older item back
onto the clipboard.

Built for Linux/GNOME/Wayland. Tracks the `CLIPBOARD` selection only (explicit
Ctrl+C copies) — not the mouse-select/middle-click `PRIMARY` selection.

## Setup

```bash
chmod +x ./setup.sh
./setup.sh   # installs deps, builds, registers the hotkey, sets up autostart
```

`setup.sh` uses **Super+V** for the popup hotkey if it's free on your system,
otherwise falls back to **Super+Shift+V** — see "Changing the hotkey" below.
It only appends to your existing GNOME custom-keybindings list — it will not
remove or overwrite any shortcut you already have configured. It also writes
`~/.config/autostart/clipboardian.desktop` so the app launches automatically
on login (safe to delete that file if you don't want autostart; rerunning the
script recreates it).

Autostart won't kick in until your next login, so to try it immediately:
```bash
pnpm start   # quits cleanly on Ctrl+C, or use the tray icon's Quit
```

## Usage

- The app runs in the background; look for its icon in the system tray (with
  a "Quit" option).
- Press **Super+V** (or **Super+Shift+V** if Super+V was taken on your system
  — check the `setup.sh` output) anywhere to open the history popup.
- Type to filter, **↑/↓** to move the selection, **Enter** to pick an item —
  it becomes your clipboard content.
- **Ctrl+V** normally to paste it wherever you need.
- **Esc** or clicking away closes the popup without changing the clipboard.
- History persists across restarts and is capped at the 500 most recent
  entries.

## Changing the hotkey

`setup.sh` auto-detects whether **Super+V** is free on your system each time
it runs, and uses it if so; otherwise it falls back to **Super+Shift+V**.
`Super+V` is commonly taken by Ubuntu GNOME's built-in notification/calendar
panel shortcut — if you'd rather have `Super+V` for Clipboardian, disable that
shortcut (GNOME Settings → Keyboard → View and Customize Shortcuts →
"Notifications") and rerun `./setup.sh`; it'll pick it up automatically.

To bind something else entirely, pass it explicitly:
```bash
./setup.sh '<Control><Alt>v'
```
or rebind manually anytime via GNOME Settings → Keyboard → Keyboard Shortcuts
→ View and Customize Shortcuts → Custom Shortcuts, find "Clipboardian".

## Future improvements

- **Auto-paste on selection.** Right now picking an item just puts it on the
  clipboard and you press Ctrl+V yourself. True auto-paste (simulating the
  keystroke into whatever window has focus) needs `ydotool` plus a
  root-privileged `uinput` daemon on Wayland — a real setup/security
  trade-off, deliberately left out of v1.
- **Image support.** History is text-only for now; storing/thumbnailing
  copied images would need schema changes (blob storage or on-disk files)
  and a different popup UI (thumbnails, not a text list).
- **Broader Linux support.** Built and tested specifically against GNOME on
  Wayland (Ubuntu 24.04). Other desktop environments (KDE, XFCE, Sway) and
  X11 sessions would need their own hotkey-registration path (the current
  `gsettings` approach is GNOME-specific) and possibly a different clipboard
  watch mechanism (e.g. wlroots compositors actually support
  `wl-paste --watch`, which this project doesn't use since GNOME can't).
- **Pinned entries.** The `pinned` column already exists in the schema but
  isn't wired to anything yet — exposing a pin/star action in the popup would
  let favorites survive the 500-entry prune instead of aging out.
- **Delete individual entries / clear history.** There's currently no way to
  remove a single item or wipe history from the UI — only age-based pruning
  does that.
- **Sensitive-content exclusion.** Nothing currently stops a password copied
  from a password manager from landing in plaintext history. Several
  clipboard managers respect a convention where apps mark sensitive copies
  (e.g. a special MIME type) and skip storing those — this project doesn't
  check for that yet.
- **Quicker selection.** Number-key shortcuts (1–9) to instantly pick one of
  the top entries, instead of always arrow-navigating + Enter.
- **Cursor-relative popup position.** It's centered on the screen for now (a
  deliberate v1 simplification) — positioning near the cursor would feel more
  natural for a keyboard-driven popup.
- **Configurable history size.** The 500-entry cap is hardcoded; could be a
  simple setting instead.
- **Actual packaging.** Currently just runs from source via `pnpm start` — an
  `electron-builder` step producing a real AppImage/`.deb` would make it
  installable rather than dev-mode-only.
- **Automated tests.** Zero test coverage right now — `store.ts`'s
  dedup/prune/search logic is the most test-worthy piece since it's pure
  logic with no Electron/GUI dependency.

## License

GPLv3 — see [LICENSE](./LICENSE). Copyright (C) 2026 Alan Joseph.
