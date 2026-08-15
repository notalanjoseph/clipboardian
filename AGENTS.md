# AGENTS.md

Context for an AI picking up this repo cold. See `README.md` for user-facing
setup/usage instructions — this file is about how the thing is built and why,
including non-obvious decisions and dead ends already ruled out.

## What this is

**Clipboardian** — a small Electron + TypeScript background app for
Linux/GNOME/Wayland that watches the system clipboard, stores text history in
SQLite, and pops up a searchable list on a global hotkey. Selecting an item
writes it back to the clipboard — the user pastes it themselves with Ctrl+V
(no auto-typing). Tracks the `CLIPBOARD` selection only, not the
mouse-select/middle-click `PRIMARY` selection (deliberate scope decision, not
a limitation to fix).

Package manager is **pnpm**, not npm — always use `pnpm`, never `npm`, for
install/scripts in this repo.

Project was renamed from "clipboard-history" to "clipboardian" after initial
build. `package.json`'s `name` field drives Electron's default `userData`
path (`app.getPath('userData')`), so this rename moved the SQLite DB from
`~/.config/clipboard-history/` to `~/.config/clipboardian/` — old history
didn't migrate (deliberately not attempted, low-stakes data). If the parent
directory itself is ever renamed/moved, re-run `./setup.sh` afterward — the
registered hotkey command and the autostart `.desktop` file both bake in an
absolute path resolved at setup time, and won't update themselves.

## Dev commands

```bash
pnpm install       # postinstall runs electron-rebuild for better-sqlite3's native binding
pnpm run build     # tsc + copies static renderer assets (html/css/png) into build/
pnpm start          # build + launch (electron --no-sandbox .)
```

No test suite exists (verified manually end-to-end during initial build — see
"How it was verified" below). No linter/formatter configured.

## Architecture

```
src/main/main.ts             app bootstrap: single-instance lock, tray icon, wires everything together
src/main/clipboardWatcher.ts polls clipboard.readText() every 500ms, feeds new entries to store
src/main/store.ts            better-sqlite3: schema, insert/dedup/bump, prune, search
src/main/popupWindow.ts       the hidden/shown BrowserWindow: create, show/hide/toggle, position
src/main/ipcHandlers.ts       ipcMain handlers: search / selectEntry / hidePopup
src/preload/preload.ts        contextBridge exposing window.clipboardAPI to the renderer
src/renderer/                 index.html + renderer.ts (vanilla, no framework) + styles.css
setup.sh                      user-run: pnpm install + build, registers the GNOME
                              custom keybinding (append-only), writes autostart entry
```

No bundler, no UI framework — the renderer is one plain `<script>`-loaded TS
file. Don't introduce webpack/vite/React/etc. unless the UI genuinely outgrows
this; it hasn't.

Build output (`build/`) mirrors `src/` 1:1 for the TS files; `pnpm run build`
additionally copies `index.html`, `styles.css`, `tray-icon.png` into
`build/renderer/` since `tsc` only compiles `.ts`.

## Non-obvious decisions and dead ends already ruled out

Don't re-attempt these without re-reading why they were rejected:

- **Clipboard watching is polling, not event-driven.** `wl-paste --watch`
  (the "obvious" event-driven approach on Wayland) was tried first and fails
  outright on this machine: it needs the wlroots `zwlr_data_control`
  protocol, which **GNOME's Mutter compositor does not implement** (only
  Sway/wlroots compositors do). Plain one-shot `wl-copy`/`wl-paste` work
  fine — it's specifically the "watch other apps' clipboard changes"
  capability that's unsupported. `clipboardWatcher.ts` instead polls
  `clipboard.readText()` every 500ms and diffs against the last-seen value.
  No external process is spawned at all.
  - Corollary: a polling diff can't distinguish "user copied the exact same
    text that was already on the clipboard, with nothing in between" from
    "nothing happened" — there's no observable event for that case. This is
    an accepted, inherent limitation, not a bug to fix.

- **Electron runs with `--no-sandbox`.** Chromium's setuid sandbox helper
  (`chrome-sandbox`) isn't root-owned/mode-4755 on this machine, and fixing
  that needs a `sudo chown`/`chmod` — which the project deliberately avoids
  requiring anywhere. `--no-sandbox` is the standard sudo-free workaround and
  is safe here since the app only ever loads its own local `file://` content,
  never remote/untrusted pages. The flag is baked into `package.json`'s
  `start` script and into both things `./setup.sh` generates
  (the registered hotkey command and the autostart `.desktop` file) — all
  three must stay in sync if this ever changes.

- **`pnpm` needs `onlyBuiltDependencies` in `package.json`.** By default pnpm
  silently *ignores* install/postinstall scripts for `electron` (which
  downloads the actual Electron binary) and `better-sqlite3` (native build)
  unless explicitly allowlisted — you'd get a "Ignored build scripts"
  warning and a broken install (no Electron binary) with no hard error. The
  fix already in place: `"pnpm": { "onlyBuiltDependencies": ["electron",
  "better-sqlite3"] }` in `package.json`. If dependencies are ever added that
  also need install scripts, they need to be added to that list too.

- **Global hotkey is a GNOME custom keybinding (`gsettings`), not Electron's
  `globalShortcut` API.** Electron's `globalShortcut` is known unreliable
  under GNOME/Wayland (no X11-style key-grab equivalent). GNOME Shell owns
  hotkeys at the compositor level regardless of session type, so a custom
  keybinding via `org.gnome.settings-daemon.plugins.media-keys` reliably
  works on both X11 and Wayland. `./setup.sh` **appends** to the
  existing `custom-keybindings` array (reads it first via `python3
  ast.literal_eval`) rather than overwriting it — this machine already had a
  pre-existing `custom0` entry, and a naive overwrite would have silently
  deleted it.

- **`setup.sh` also installs the autostart entry** (writes
  `~/.config/autostart/clipboardian.desktop` directly via a heredoc, using
  the same `$REPO_DIR`/`$ELECTRON_BIN` it resolves for the hotkey command).
  There used to be a separate static `clipboard-history.desktop.template`
  file the user had to `cp` manually — removed in favor of generating it here
  so the path is always correct regardless of where the repo is cloned, and
  so one script finishes the whole setup. If the Exec line's flags/path logic
  ever change, this is the only place to update (no template file to keep in
  sync anymore).

- **Hotkey is auto-detected (`<Super>v` if free, else `<Super><Shift>v`), not
  hardcoded.** `<Super>v` looks free but often isn't: Ubuntu's GNOME Shell has
  a *built-in* binding, `org.gnome.shell.keybindings toggle-message-tray =
  ['<Super>v', '<Super>m']` (opens the notification/calendar panel), and
  GNOME Shell intercepts it before custom media-keys keybindings ever see it
  — so a naive custom binding there would silently never fire, with no error
  anywhere. Confirmed the hard way (user reported Super+V opening
  notifications instead of the popup) with a hardcoded `<Super><Shift>v`
  fallback initially, then replaced with `find_binding_conflict()` in
  `setup.sh`: a `python3` heredoc that checks (a) every fixed-path gsettings
  schema whose id contains `keybinding` or `media-keys` — covers
  `org.gnome.shell.keybindings` and `org.gnome.desktop.wm.keybindings`, not
  just the `media-keys` schema this project registers into — and (b) every
  already-registered custom-keybinding slot's own `binding` value, read via
  the relocatable schema's `schema:path` syntax (not reachable through plain
  schema enumeration; had to separately walk the `custom-keybindings` array
  and query each path). Re-runs every time `setup.sh` runs (not cached), so a
  user freeing up `Super+V` later and rerunning picks it up automatically —
  verified by clearing `toggle-message-tray` via `gsettings set
  org.gnome.shell.keybindings toggle-message-tray "[]"`, rerunning, confirming
  the slot's actual `binding` key flipped to `<Super>v`, then restoring the
  original value and confirming it fell back to `<Super><Shift>v` again. The
  check uses `ast.literal_eval` + exact equality/array-membership rather than
  substring matching — a naive substring check on the candidate binding would
  false-positive on unrelated bindings that happen to contain it (e.g. a
  hypothetical `<Super>vv`).

- **Reaching the resident instance is `app.requestSingleInstanceLock()` +
  `second-instance`**, not a hand-rolled socket/D-Bus service. Every hotkey
  press launches a short-lived `electron ... --toggle-popup` process; the
  first-ever launch wins the lock and stays resident with a pre-warmed
  hidden popup window (so toggling is instant), every later press loses the
  lock, fires `second-instance` in the resident process, and exits quickly
  (~0.3s measured). Don't build a custom IPC channel for this — Electron
  already provides it.

## How it was verified

No GUI-interaction or screenshot tooling works in this dev environment
(no `xdotool`/`wmctrl`; `grim` needs the same unsupported wlroots protocol as
above; GNOME's own D-Bus screenshot API also denies access here). Verification
instead went through:
- Real `wl-copy`/`wl-paste` commands + inspecting the SQLite DB directly
  (query it via `ELECTRON_RUN_AS_NODE=1 electron script.js`, since
  `better-sqlite3`'s native binding is built against Electron's ABI and a
  plain system `node` can't load it — that env var makes the Electron binary
  behave as a matching-ABI Node runtime).
- Chrome DevTools Protocol: launch with `--remote-debugging-port=9222`, hit
  `http://127.0.0.1:9222/json/list` for the popup page's
  `webSocketDebuggerUrl`, then `Runtime.evaluate` JS directly in the page —
  since `window.clipboardAPI` is exposed via `contextBridge`, this exercises
  the exact same code path a real click would (search, selectEntry →
  clipboard write, confirmed via `wl-paste` after).
- Debug `console.log`s temporarily added to `popupWindow.ts`'s `toggle()` to
  confirm visibility state transitions, then removed once confirmed.

If revisiting verification in a similar sandboxed/headless-ish environment,
these are the tools that actually work here — don't re-waste time on
`xdotool`/`wmctrl`/`grim`/GNOME-screenshot-D-Bus, they're all dead ends.

## Known limitations (by design, not bugs)

- Text only, no images/files.
- `PRIMARY` selection (mouse-select → middle-click) is not tracked.
- No auto-paste/keystroke injection — selecting an item only puts it on the
  clipboard; the user presses Ctrl+V themselves.
- 500 most recent entries kept (unpinned); `pinned` column exists in the
  schema for future use but isn't exposed in the UI yet.
