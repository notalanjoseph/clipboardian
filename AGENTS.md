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
pnpm test           # build + node:test unit tests for store.ts (see below)
```

**`pnpm test` covers `store.ts` only** (`src/main/store.test.ts`) — dedup,
prune-to-500, search ordering/filtering, `touch`, `getById`, `wipeData`'s
on-disk cleanup. Everything else (Electron main-process wiring, the
renderer, real GUI interaction) still has zero automated coverage and
relies on the manual verification methodology documented in "How it was
verified" below — `store.ts` was singled out specifically because it's pure
logic with no Electron/GUI dependency, unlike the rest of this codebase.

Uses Node's built-in `node:test` + `node:assert/strict` — no new
dependency, consistent with this project's "don't add a framework/bundler
until it's actually outgrown the plain approach" stance elsewhere. Tests
run against `store.ts`'s **compiled JS output** in `build/`, not the `.ts`
source directly.

**Must run via `ELECTRON_RUN_AS_NODE=1 electron --test build`, not plain
`node --test build`** — confirmed necessary by testing, not assumption.
`better-sqlite3`'s native binding is compiled by `electron-rebuild`
(this project's own `postinstall` script) against *Electron's* Node ABI,
not the system Node's — the same ABI mismatch this project already
documented under "How it was verified" for querying the DB directly. Using
plain `node --test` hits `ERR_DLOPEN_FAILED`
(`NODE_MODULE_VERSION` mismatch) immediately; `ELECTRON_RUN_AS_NODE=1
electron` makes the Electron binary behave as a matching-ABI Node runtime,
exactly like the existing DB-inspection technique. `package.json`'s `test`
script already does this — don't invoke `node --test` directly.

**`store.ts`'s `init()` takes an optional path override
(`init(overridePath?: string)`)** specifically so tests can point it at a
temp file instead of `app.getPath('userData')` — `app` isn't a real object
outside a running Electron process (required under plain Node, the
`electron` package is just a path string), so `store.test.ts` calls
`store.init(tempFile)` to avoid ever touching `app.getPath` at all.
`main.ts`'s own `store.init()` call (no args) is unaffected.

**Test timestamps must not rely on `created_at`'s sub-millisecond
ordering** — found via a real, reproducible test failure, not
theorized. `store.ts`'s ordering/pruning queries only sort by `created_at`
(millisecond resolution); a human can never act twice within 1ms, but a
tight test loop calling `addEntry()`/`touch()` back-to-back easily can, and
SQLite's tie-breaking among equal `created_at` values isn't insertion
order. Confirmed directly: an early draft of the prune test (505
back-to-back `addEntry()` calls, no delay) intermittently kept the
*oldest* entry instead of pruning it, and the "search ordered by
created_at desc"/"touch bumps to top" tests occasionally asserted the
wrong order — all from real timestamp collisions, not flawed assertions.
**Deliberately did not "fix" this by adding an `id`-based tiebreaker to
`store.ts`'s queries** — that would be solving a problem no real user can
ever trigger (matches this project's established stance on not adding
handling for scenarios that can't happen, e.g. the CLIPBOARD-polling
same-text-twice case elsewhere in this file). Fixed the *tests* instead:
`waitForNextMs()` in `store.test.ts` synchronously busy-waits for
`Date.now()` to tick over before any call whose relative ordering is
asserted — deterministic regardless of system timer/scheduling
granularity, unlike an async `setTimeout`-based sleep (which was tried
first and is not guaranteed to exceed 1ms in practice). Verified by
re-running the full suite repeatedly with no flakes, and by deliberately
breaking an unrelated assertion to confirm the runner still fails loudly
rather than silently passing.

No linter/formatter configured.

## Architecture

```
src/main/main.ts             app bootstrap: single-instance lock, tray icon, wires everything together
src/main/clipboardWatcher.ts polls clipboard.readText() every 500ms, feeds new entries to store
src/main/store.ts            better-sqlite3: schema, insert/dedup/bump, prune, search
src/main/popupWindow.ts       the hidden/shown BrowserWindow: create, show/hide/toggle, position
src/main/ipcHandlers.ts       ipcMain handlers: search / selectEntry / hidePopup
src/main/appImageSetup.ts     packaged-AppImage-only: registers hotkey + autostart on
                              first launch, self-heals on move, respects user opt-outs
src/preload/preload.ts        contextBridge exposing window.clipboardAPI to the renderer
src/renderer/                 index.html + renderer.ts (vanilla, no framework) + styles.css
setup.sh                      user-run: pnpm install + build, registers the GNOME
                              custom keybinding (append-only), writes autostart entry
resources/icon.png            512x512 app icon, used by electron-builder for the AppImage
                              (separate from src/renderer/tray-icon.png, the small tray icon)
```

`pnpm run dist` packages the app into `dist/Clipboardian-<version>.AppImage` via
`electron-builder` (config in `package.json`'s `"build"` field) — see the
"Packaging" section below for the gotchas involved.

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

  **Correction — the original fallback logic had a real gap: it never
  checked whether `<Super><Shift>v` was ALSO taken before assigning it.**
  If both were claimed by something else, `setup.sh`/`appImageSetup.ts`
  would still happily `gsettings set ... binding '<Super><Shift>v'` — no
  error, but the binding would silently never fire (GNOME's key-grabbing is
  first-come-first-served; whatever registered it first keeps getting the
  real key press), reproducing the exact same class of silent failure this
  project already hit once for `<Super>v` vs. `toggle-message-tray`, just
  for the fallback instead. Fixed by running `find_binding_conflict()` a
  second time against `<Super><Shift>v` before assigning it; if that's
  *also* taken, the binding is deliberately left unset (never written)
  rather than assigning something unusable, with a log message (and, in
  `appImageSetup.ts`, a `notifyNoFreeHotkey()` desktop notification) telling
  the user to bind one manually. Verified directly by simulating both
  conflicts at once (clearing nothing — `toggle-message-tray` claims
  `<Super>v`, a temporary fake custom-keybinding slot claims
  `<Super><Shift>v`) and confirming the slot's `binding` key stayed `''`.

  **`appImageSetup.ts`'s retry-every-launch behavior for this case needed
  one more check to avoid a self-inflicted bug**: since no marker gets
  written when both are taken, every subsequent launch retries the
  conflict check — but if the user acts on the notification and binds one
  manually via GNOME Settings in the meantime, a naive retry would
  overwrite their manual choice the next time `ensureHotkey()` runs. Fixed
  by reading the slot's *current* `binding` value first; if it's already
  non-empty (the user's own choice, or a still-taken value that somehow
  became set), the code marks the slot as managed and leaves it alone
  instead of re-deciding. Verified by simulating a manual bind
  (`<Control><Alt>v`) after a "both taken" run, relaunching, and confirming
  the log shows `hotkey already bound to <Control><Alt>v; leaving as-is`
  rather than overwriting it — and that `currentBindingLabel()`'s
  humanizer correctly renders arbitrary user-chosen modifiers too (not just
  the two bindings this project assigns itself), confirmed via that same
  custom binding showing up correctly as "Ctrl+Alt+V" in the next launch's
  notification.

  **Correction — `find_binding_conflict()`/`PY_FIND_CONFLICT`'s conflict
  check itself had a gap: it compared accelerator strings with plain
  `val == candidate`, but GNOME/GTK accelerator strings aren't
  modifier-order-stable.** The same key combination can be stored as
  `<Super><Shift>v` or `<Shift><Super>v` depending on how it was set — GNOME
  Settings' own Custom Shortcuts UI writes modifiers in GTK's canonical
  bit-order (Shift before Super), while this project's own candidate
  strings use Super-first. Found via real-world use, not synthetically: a
  user rebound GNOME's Quick Settings panel to Super+Shift+V, which GNOME
  Settings stored as `gsettings get org.gnome.shell.keybindings
  toggle-quick-settings` → `['<Shift><Super>v']`; `find_binding_conflict`'s
  exact-string check against `<Super><Shift>v` never matched, so the
  "both taken" logic above missed the conflict, assigned
  `<Super><Shift>v` anyway, and — since GNOME's key-grabbing is
  first-come-first-served and Quick Settings already owned the actual key
  press — the hotkey silently never fired at all, while the app confidently
  notified the user to press it. Fixed by normalizing both sides before
  comparing: `normalize_accel()` extracts the `<Mod>` tags with regex,
  dedupes, sorts them by a fixed canonical order
  (`Shift, Control, Alt, Super, Hyper, Meta, Primary`), and re-joins with
  the lowercased key — applied to both the candidate and every value read
  from gsettings, for both plain strings and array membership. Ported to
  both `setup.sh`'s `find_binding_conflict()` and `appImageSetup.ts`'s
  `PY_FIND_CONFLICT` (kept in sync per this project's usual convention).
  One packaging gotcha hit while porting: `PY_FIND_CONFLICT` is itself a JS
  template literal (backtick-delimited) — an early draft of the explanatory
  Python comment used backticks around `val == candidate`, which silently
  terminated the JS string early and broke `tsc` with a `',' expected`
  error nowhere near the real problem; fixed by just not using backticks
  inside that comment. Verified by reproducing the user's exact machine
  state (`toggle-message-tray = ['<Super>v', '<Super>m']`,
  `toggle-quick-settings = ['<Shift><Super>v']`), clearing the
  already-wrongly-set `<Super><Shift>v` binding and the `.hotkey-managed`
  marker so the fixed logic would re-decide, relaunching the rebuilt
  AppImage, and confirming the log now correctly reads `could not find a
  free hotkey: Super+V and Super+Shift+V are both taken` with the binding
  left `''` — instead of wrongly claiming `<Super><Shift>v`.

- **The tray menu's hotkey label opens GNOME's own Keyboard Shortcuts
  settings (`gnome-control-center keyboard shortcuts`) rather than a custom
  in-app key-capture dialog.** Consistent with this project's broader
  stance of leaning on native GNOME functionality instead of reinventing it
  (gsettings custom-keybindings instead of Electron's `globalShortcut`,
  GNOME's own Custom Shortcuts UI as the documented way to rebind) —
  building a custom key-capture UI would duplicate GNOME's own shortcut
  editor and its conflict detection, for no real benefit.
  `keyboard shortcuts` (the two args together) is a **documented**
  `gnome-control-center` invocation, confirmed via the actual Ubuntu man
  page text, not just a search-engine summary: "You can open this panel on
  a specific tab by passing typing or shortcuts as extra argument." Also
  confirmed to actually launch on this machine (process stayed alive under
  a `timeout` wrapper, no immediate crash). **Real limitation, not fixable
  via CLI**: GNOME doesn't support deep-linking to a *specific* custom
  shortcut row — only to the shortcuts tab as a whole — so the user still
  scrolls to "Custom Shortcuts" → "Clipboardian" themselves, same as this
  project's own README instructions.

  **The tray menu doesn't auto-refresh after the user rebinds via
  Settings** — Electron's own bundled type docs confirm `Tray` emits a
  `'click'` event on Linux, but with this exact caveat: "this event is
  emitted when the tray icon receives an activation, which might not
  necessarily be left mouse click." A `tray.on('click', ...)` handler that
  rebuilds the menu was added anyway since it's cheap and harmless even if
  it never fires as hoped, but its actual timing relative to the OS
  auto-showing the attached context menu was **not verified** — this
  sandboxed dev environment has no GUI interaction tooling (see "How it was
  verified" below), so this is a best-effort addition, not a confirmed
  live-refresh. If it turns out not to work in practice, the menu still
  self-corrects at the next natural rebuild point (app restart).

  **Correction — confirmed by the user in real use that `tray.on('click',
  ...)` does not work: changing or unsetting the hotkey via GNOME Settings
  left the tray label stale until the app was quit and relaunched.**
  Exactly the risk flagged as unverified above — GNOME's tray protocol
  (StatusNotifierItem/AppIndicator) shows whatever `Menu` was last passed
  to `setContextMenu()` directly, with no reliable hook for Electron to
  rebuild it first. Replaced with a `setInterval` poll (3s) that re-reads
  `currentBindingLabel()` and only calls `setContextMenu()` when the value
  actually changed (not on every tick, to avoid redundant D-Bus menu
  re-exports). `buildTrayMenu()` was refactored to take the binding as a
  parameter instead of reading it internally, so the poll and the two
  startup call sites all share one source of truth
  (`lastKnownBinding`) instead of each re-querying gsettings separately.
  Verified directly using this project's established temporary-debug-log
  technique (see "How it was verified" below): ran a dev-mode instance,
  changed the real gsettings binding externally (`gsettings set ...`,
  exactly what GNOME Settings does under the hood) to `<Control><Alt>v`,
  confirmed the poll logged the rebuild with the correctly humanized
  `Ctrl+Alt+V` within one interval tick, then cleared the binding
  entirely and confirmed the same for the `null`/"not set" case — before
  removing the debug log and rebuilding.

  **Correction — clicking the menu item showed the fallback notification
  instead of opening Settings, confirmed via `appimage-setup.log`'s actual
  error text, not assumed.** The log showed
  `gnome-control-center` itself exiting immediately with `Running
  gnome-control-center is only supported under GNOME and Unity, exiting`
  — its own startup check refuses to run unless it sees `GNOME` or `Unity`
  in `XDG_CURRENT_DESKTOP`. Confirmed directly: the *running app's own
  process* had **no `XDG_CURRENT_DESKTOP` set at all**
  (`cat /proc/<pid>/environ`), unlike a normal interactive shell/session
  (which has `ubuntu:GNOME`) — however this app itself gets launched
  (hotkey press, AppImage bootstrap) doesn't reliably carry that variable
  through, so `execFile()`'s spawned child inherited the same gap. Fixed
  by explicitly forcing `XDG_CURRENT_DESKTOP: 'GNOME'` in the env passed to
  `execFile()` — safe to hardcode since this project already assumes a
  GNOME session everywhere else (the gsettings schemas it reads/writes).
  Verified by reproducing the exact failure first (spawning
  `gnome-control-center` with `XDG_CURRENT_DESKTOP` stripped via `env -u`
  hit the identical error), then confirming the forced-env version actually
  launches and stays running under the same stripped-env condition.

  **Correction — the 3s tray-refresh poll's real cost was quoted wrong when
  the user asked directly whether it was resource-intensive.** Answered
  "~3ms per tick" based on timing a bare `gsettings get` call alone — but
  `currentBindingLabel()` (what the poll actually calls) also spawns a
  `python3` subprocess via `pyRun(PY_VALUE_OR_EMPTY, ...)` to parse that
  output, found later by code review, not from re-checking the original
  answer. Measured the real, complete cost directly: ~21-25ms per tick
  (`gsettings get` + `python3 -c ...` back to back), confirmed via `strace
  -f -e trace=execve` showing both processes actually exec'd once per call.
  Still genuinely negligible in absolute terms (~0.7% of one core), but the
  original answer undersold it by ~7x by only benchmarking half the actual
  code path. Fixed the underlying cost rather than just correcting the
  number: added `unquoteGVariantString()`, a narrow, JS-only unquoter for
  this one specific value shape (gsettings' GVariant string-literal output
  is always empty or a simple accelerator string here, never anything
  needing real escape-sequence handling) — used *only* in
  `currentBindingLabel()`, since that's the one call site that's polled
  forever rather than called once per launch; every other
  `PY_VALUE_OR_EMPTY`/`ast.literal_eval` call site in this file is
  untouched, since a one-shot per-launch python3 spawn was never the
  concern. Verified with the same `strace` technique: confirmed `python3`
  is exec'd zero times now, `currentBindingLabel()` still correctly returns
  `Super+V` for a real bound value and `null` for an empty one, and the
  per-tick cost is back down to ~5ms (matching what a bare `gsettings get`
  alone actually costs).

- **Both `setup.sh` and `ensureHotkey()` (AppImage) automatically open
  GNOME's Keyboard Shortcuts settings — but only in the "both taken, left
  unbound" case, not on a successful auto-bind.** Reuses the same
  `openHotkeySettings()`/`gnome-control-center keyboard shortcuts`
  mechanism as the tray menu item above. Deliberately scoped narrower than
  first implemented: an early version opened Settings on *every* outcome
  (including a successful Super+V/Super+Shift+V auto-bind), but that's
  unnecessary friction — a successful bind needs no follow-up action from
  the user. It's specifically the "couldn't find a free hotkey" message
  that already tells the user to bind one manually via Settings, so
  automatically opening it right there removes that friction where it
  actually matters. In `ensureHotkey()`, this lives in the same
  `else` branch as `notifyNoFreeHotkey()`; in `setup.sh`, it's gated on
  `[[ -z "$BINDING" ]]` at the very end of the script (backgrounded, with
  `XDG_CURRENT_DESKTOP=GNOME` forced the same way as the fix above, as
  cheap insurance even though a normal interactive terminal session
  already carries it correctly).

  **Correction — quitting while both hotkeys were taken, then relaunching,
  showed `notifyNoFreeHotkey()`'s "Clipboardian installed | Action
  required" notification again instead of `notifyRelaunched()`'s
  "Clipboardian | Started"**, reported directly by the user hitting this
  in real use, not theorized. Root cause: `isHotkeyConfigured()` (which
  `main.ts` uses to decide "is this a genuinely first-ever launch, or a
  later relaunch") only checked `hotkeyMarkerFile()` — the marker meaning
  "the hotkey question is *resolved*", which is deliberately never written
  while both candidates stay taken (so `ensureHotkey()` keeps retrying
  every launch, by design). That made every single relaunch
  indistinguishable from a true first-ever launch, so
  `ensureHotkeyAndAutostart()`'s own first-run notification kept re-firing
  — with a title that says "installed" even on the tenth relaunch — and
  `notifyRelaunched()` never got a chance to run at all. Fixed by adding a
  second, narrower marker (`noFreeHotkeyNotifiedMarkerFile()`,
  `.no-free-hotkey-notified`) that tracks "has the user been told about
  this at least once" separately from "is it resolved" — gating
  `notifyNoFreeHotkey()`/`openHotkeySettings()` behind it (write once, skip
  on every later launch) and OR-ing it into `isHotkeyConfigured()`'s check.
  Deliberately did **not** just reword `notifyNoFreeHotkey()`'s title —
  the real bug was the missing "already notified" tracking, not the text;
  once fixed, the existing "installed" title is accurate again for the one
  launch it's actually allowed to fire on. Verified directly against this
  project's own real machine state, which happened to already be in
  exactly this bug's condition (`binding` empty, `toggle-message-tray`
  claiming Super+V, neither marker present): confirmed `isHotkeyConfigured()`
  flips `false` → `true` after the first simulated launch, and that a
  second simulated launch no longer re-spawns `gnome-control-center`
  (i.e. no duplicate notification/Settings-open), while the underlying
  retry-until-resolved log line still fires every time as designed.

  **Correction — the fix above introduced its own bug: Uninstall, then
  reinstalling by relaunching the AppImage, showed `notifyRelaunched()`
  ("Clipboardian | Started") instead of the correct fresh-install
  notification**, reported directly by the user, not theorized. Root
  cause: `uninstall()`'s marker cleanup list
  (`[hotkeyMarkerFile(), autostartMarkerFile()]`) predates
  `noFreeHotkeyNotifiedMarkerFile()` and was never updated to include it —
  so uninstalling left the stale "already notified" marker sitting in
  `userData`, and the next launch's `isHotkeyConfigured()` read it as
  "this isn't a first-ever launch" even though the user had just
  deliberately uninstalled and was reinstalling fresh. Fixed by adding
  `noFreeHotkeyNotifiedMarkerFile()` to that same cleanup list. General
  lesson for this file: **any new marker file needs a corresponding entry
  in `uninstall()`'s cleanup list**, or it silently survives an uninstall
  and corrupts the next install's first-run detection — this is the
  second time a marker has been added to this file
  (`noFreeHotkeyNotifiedMarkerFile` itself), so check this list first when
  adding a third. Verified directly: called `uninstall()` for real on this
  machine and confirmed via `ls` that all three marker files
  (`.hotkey-managed`, `.autostart-managed`, `.no-free-hotkey-notified`) were
  actually removed, then confirmed `isHotkeyConfigured()` correctly read
  `false` again before the simulated reinstall ran.

  **Correction — found by code review (not user report this time), then
  confirmed real: a launch that both "relaunches" (per the sticky
  `isHotkeyConfigured()` above) *and* newly resolves the hotkey in the same
  run showed two contradictory notifications back to back** —
  `notifyRelaunched()`'s stale "Change Hotkey to start using Clipboardian"
  immediately followed by `notifyHotkeyBound()`'s "Clipboardian installed —
  press Super+V". Root cause: `alreadyConfigured` (and thus the
  `notifyRelaunched()` decision) is computed in `main.ts` *before*
  `ensureHotkeyAndAutostart()` runs, so it can't know whether *this exact
  launch* is about to also fire its own notification. Fixed by having
  `ensureHotkey()`/`ensureHotkeyAndAutostart()` return whether they fired a
  notification this run, and deferring the `notifyRelaunched()` decision in
  `main.ts` until after `ensureHotkeyAndAutostart()` completes — gated on
  `!notifiedByHotkeySetup`. This required reordering `main.ts`'s
  `whenReady()` (`ensureHotkeyAndAutostart()` no longer strictly "runs
  last"), but `popupWindow.toggle()` for a hotkey-triggered launch still
  fires first/unblocked beforehand, so the reordering doesn't reintroduce
  the startup-delay concern the original "run last" comment was about —
  only the non-performance-critical relaunch-notification decision moved.
  Verified directly: simulated the exact bug scenario (marker says
  "already notified about both-taken", binding empty, then freed up
  Super+V before the next launch) and confirmed `ensureHotkeyAndAutostart()`
  now returns `true` (correctly suppressing `notifyRelaunched()`), then
  re-ran with nothing changed and confirmed it returns `false` (so the
  normal steady-state relaunch notification is unaffected).

- **Reaching the resident instance is `app.requestSingleInstanceLock()` +
  `second-instance`**, not a hand-rolled socket/D-Bus service. Every hotkey
  press launches a short-lived `electron ... --toggle-popup` process; the
  first-ever launch wins the lock and stays resident with a pre-warmed
  hidden popup window (so toggling is instant), every later press loses the
  lock, fires `second-instance` in the resident process, and exits quickly
  (~0.3s measured). Don't build a custom IPC channel for this — Electron
  already provides it.

- **Rounded corners on the popup window (`BrowserWindow` `transparent: true`
  + CSS `border-radius`) were attempted and reverted — genuinely doesn't
  work on this machine (GNOME 46 / Mutter), confirmed by exhausting every
  documented fix, not given up on prematurely.** Symptom, reported directly
  by the user with an exaggerated diagnostic style (40px radius + solid red
  4px outline ring, to make any partial success unambiguous): the **top**
  two corners stayed perfectly square/opaque, while the **bottom** two
  showed the red curve — but with **solid black**, not the desktop, filling
  the area outside the curve. That asymmetry matters: `border-radius`/
  `box-shadow` are the same CSS rule applied uniformly to the whole
  element, so a pure page-rendering bug can't explain top behaving
  differently from bottom — this pointed at window-compositor-level
  interference, not a CSS mistake, which is exactly what made this worth
  chasing across several distinct mechanisms rather than assuming failure
  after the first attempt.

  Verified independently, via tools that turned out to work despite this
  project's documented general GUI-testing limitations (see "How it was
  verified" below) — this app happens to run as an **XWayland** client by
  default (real X11 surface, `DISPLAY=:0` set), which made `xwininfo`
  usable even though `grim`/GNOME's screenshot D-Bus API are both
  confirmed dead ends as always: `xwininfo` showed the window genuinely
  had a 32-bit `TrueColor` ARGB-capable visual, and Chrome DevTools
  Protocol confirmed the computed CSS was 100% correct (`border-radius`,
  `box-shadow`, `html { background: rgba(0,0,0,0) }` all present) on the
  exact running instance. A `Page.captureScreenshot` CDP test was tried and
  found **unreliable** for this specific question — it returned
  byte-identical output regardless of `Emulation.setDefaultBackgroundColorOverride`,
  suggesting CDP screenshots don't faithfully reflect real window-compositor
  alpha at all; don't trust that API for this again.

  Five independent fixes were tried, **each individually confirmed to
  actually take effect** (not silently ignored) before being ruled out —
  none changed the visual result even slightly:
  1. `backgroundColor: '#00000000'` alongside `transparent: true` (the most
     commonly cited fix for Linux — explicit zero-alpha RGBA, not the
     string `'transparent'`).
  2. `app.disableHardwareAcceleration()` (the single most-cited historical
     fix for this class of bug — alpha lost in the GPU present path).
  3. Forcing native Wayland instead of XWayland
     (`--ozone-platform=wayland`). **Important finding while testing
     this**: `app.commandLine.appendSwitch('ozone-platform', 'wayland')`
     from within the app's own JS **does not work** — confirmed via
     `xwininfo` still finding an X11 surface afterward, and via the
     renderer subprocess's own args never actually containing
     `--ozone-platform=wayland`. Only passing it as a genuine CLI argument
     at process-spawn time actually forced native Wayland (confirmed via
     `xwininfo` then finding *nothing* — the window was no longer an X11
     surface at all). Some Ozone/platform decisions are made too early in
     Chromium's native startup for `app.commandLine.appendSwitch()` calls
     to influence, even when called before `app.whenReady()`. Despite
     genuinely being native Wayland this time (confirmed, not assumed),
     the visual result was — per the user directly — "exact same as
     before."
  4. `--enable-transparent-visuals` combined with `--disable-gpu` (per the
     research pairing warning: this flag alone, without disabling GPU, is
     reported elsewhere to cause unintended semi-transparency on *all*
     windows — tried only paired with #2, still no change).
  5. `hasShadow: false` — a different hypothesis entirely (that the solid
     black might be a GNOME/Mutter-added window-manager shadow, not
     Chromium's own page rendering, since the asymmetry pointed away from
     anything page-level). Also no change.

  That level of consistency — zero visual difference across GPU on/off,
  XWayland vs. confirmed-genuine native Wayland, shadow on/off, and every
  documented transparency flag — is itself the real finding: this isn't a
  missing-flag problem. It points to something more fundamental in how
  this specific Mutter version composites frameless/transparent Electron
  windows that isn't addressable from the app side with current knowledge.
  **Reverted cleanly** (`git diff` against the last commit was empty after
  reverting — byte-perfect, confirmed via `git status`) rather than left in
  a half-broken state, since partial failure (black corner triangles) looks
  worse than the plain rectangular popup that shipped before this attempt.
  Don't re-attempt without new information — e.g. a different Electron/
  Chromium version, a Mutter update, or an actual root-cause explanation
  found in a future upstream bug report, not just retrying the same five
  mechanisms.

## Packaging (AppImage via electron-builder)

- **`electron` must be a `devDependency`, not a regular `dependency`.**
  electron-builder refuses to build otherwise ("Package electron is only
  allowed in devDependencies") — it treats `electron` as a build-time tool it
  bundles itself, not a runtime dependency of your app code. Moved it during
  this project; `better-sqlite3` stays a real `dependency` since it's an
  actual native module the packaged app requires at runtime.

- **`app.commandLine.appendSwitch('no-sandbox')` does NOT work for baking
  `--no-sandbox` into a packaged build — confirmed by testing, not assumption.**
  Added it as the first line of `main.ts` and it still hit the same FATAL
  `chrome-sandbox` crash as running with no flag at all. The sandbox
  decision happens natively, before any of the app's JS executes — by the
  time our code runs, it's too late to influence it from within the same
  process.

  **Correction — `linux.executableArgs: ["--no-sandbox"]` was tried next and
  looked confirmed working, but that was a false positive.** Every test of
  it happened only via `--appimage-extract-and-run` in this sandboxed dev
  environment (the only way to run an AppImage here at all, since it lacks
  FUSE) — `ps` showing `--no-sandbox` in that mode was actually *not* coming
  from `executableArgs`. Direct testing on a real machine (FUSE present,
  genuine double-click/direct execution — see below) proved
  `executableArgs` only gets baked into the **embedded `.desktop` file's
  `Exec=` line** (`Exec=AppRun --no-sandbox %U`), which is *only* read when
  a desktop-integration tool creates a menu entry from it — plain direct
  execution or double-click invokes `AppRun` directly with zero args and
  never touches that `.desktop` file at all.

  **What's actually responsible for correct sandboxing on every launch path:
  AppRun's own built-in adaptive check**, bundled generically by
  electron-builder into every AppImage — before exec'ing the real binary it
  runs `unshare -Ur true` as a heuristic (does this kernel/context support
  unprivileged user namespaces?) and only adds `--no-sandbox` itself if that
  heuristic fails, otherwise leaving the real Chromium sandbox enabled. This
  is *why* every test in this dev sandbox (where the heuristic reliably
  fails) showed `--no-sandbox` regardless of whether `executableArgs` was
  set — and why a real end-user machine may run with the sandbox genuinely
  enabled (no `--no-sandbox` anywhere in `ps`) without crashing, which was
  observed directly: a real double-click launch on GNOME 46 ran with zero
  `--no-sandbox` flags anywhere in the process tree and worked fine, while a
  second launch moments later (different invocation context) had AppRun add
  `--no-sandbox` on its own — the check is genuinely per-invocation, not a
  fixed property of the machine. **Given this, `executableArgs` was removed
  from `package.json` entirely** — it was inert for the launch paths that
  matter and, for the one path where it *did* apply (a
  Gear-Lever/AppImageLauncher-created menu entry), it would have forced
  `--no-sandbox` unconditionally, defeating AppRun's better, adaptive
  per-launch decision for no benefit. Don't re-add it without a concrete
  reason tied to that specific desktop-integration path.

- **`directories.buildResources` must be overridden away from electron-builder's
  default (`build/`)** — this project already uses `build/` for `tsc`'s
  compiled output, so left at the default it would collide with our own
  build directory. Set to `resources/` instead, with the app icon at
  `resources/icon.png` (512x512, separate from the small tray-icon.png the
  running app itself uses for the tray).

- **The custom `"files"` array (`["build/**/*", "package.json"]`) does NOT
  break native module bundling.** It looked like it might exclude
  `node_modules` (and thus `better-sqlite3`'s compiled binding) since the
  glob doesn't mention it — but electron-builder separately auto-detects and
  bundles production `dependencies` regardless of the `files` filter.
  Confirmed by inspecting the packaged output:
  `resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`
  is present, and the packaged app successfully read/wrote the real SQLite
  DB when tested.

- **Testing the built AppImage in this sandboxed dev environment needs
  `--appimage-extract-and-run`.** Running it directly fails with
  `dlopen(): error loading libfuse.so.2` — FUSE isn't available here (common
  in containers). Real end-user desktops typically have FUSE, so this is a
  dev-environment-only workaround, not a fix shipped in the app itself. When
  verifying future packaging changes here, use
  `./dist/Clipboardian-*.AppImage --appimage-extract-and-run` instead of
  wasting time trying to get FUSE working in this environment.

- **The AppImage registers its own hotkey/autostart in-process
  (`src/main/appImageSetup.ts`), gated entirely on `process.env.APPIMAGE`
  being set** (confirmed present even under `--appimage-extract-and-run`, not
  assumed) — so `pnpm start`/dev-mode `electron .` never has this var set and
  is completely unaffected; that flow still relies on `setup.sh`. Called as
  the *last* line inside `main.ts`'s `whenReady()`, after tray creation and
  `popupWindow.createHidden()`, since every step is a blocking
  `execFileSync` call and shouldn't delay the tray icon or the popup
  appearing.

  - **Three independently-stale gsettings values need independent
    read-before-write checks, not one gate.** `custom-keybindings` array
    membership and the slot's `name`/`command` are always safe to self-heal
    (e.g. after the AppImage file is moved/renamed — verified by literally
    moving the built AppImage and confirming `command` and the autostart
    file's `Exec=` line both updated to the new path on the next launch).
    `binding` is different: this code runs **automatically on every login
    with no user action**, unlike `setup.sh` which only ever runs when a
    user deliberately invokes it — so blindly re-deciding `binding` whenever
    something else needed fixing would silently clobber a binding the user
    changed via GNOME Settings' own Custom Shortcuts UI.

  - **An empty `binding` value is ambiguous and a marker file is the only
    fix.** GNOME's Custom Shortcuts UI clears a shortcut by setting
    `binding` to `''`, not by deleting the custom-keybinding slot — so
    "never assigned yet" and "user deliberately disabled it" are
    indistinguishable from the gsettings value alone. First implementation
    got this wrong (checked only whether `binding` currently reads empty,
    ORed with "slot was just created") and a test simulating a user clearing
    the binding after a successful run proved it: the next launch
    silently reassigned it. Fixed with a `.hotkey-managed` marker file in
    `app.getPath('userData')` — the binding is only ever decided when the
    slot was just newly created *or* the marker doesn't exist yet (truly
    first-ever), never merely because it currently reads empty. Verified by
    the same test after the fix: binding stayed cleared. The autostart file
    has the same shape of problem and the same fix — a `.autostart-managed`
    marker distinguishes "never created" (create it) from "user deleted it
    on purpose" (leave deleted), matching the README's documented "safe to
    delete that file if you don't want autostart" promise.

  - **Every gsettings-value comparison is routed through a shared `python3`
    `ast.literal_eval` helper** (`PY_VALUE_MATCHES`), not just the
    conflict-detection logic — never hand-parse or hand-construct GVariant
    literal text in JS/TS. Scripts are invoked via
    `execFileSync('python3', ['-', ...args], { input: script })`, which is
    argv-identical to `setup.sh`'s `python3 - "$1" "$2" <<'PY'`, so
    `find_binding_conflict()` and the array-append logic port over
    verbatim with zero translation risk.

  - Hotkey registration and autostart-file handling run in **two separate
    try/catch blocks** — a failure in one (e.g. `gsettings`/`python3`
    missing from `PATH`) doesn't skip the other, and doesn't crash the app;
    confirmed by temporarily shadowing both binaries with always-failing
    stand-ins on `PATH` and observing the app still started fully (tray,
    popup, clipboard watcher) with the failure only visible in
    `console.error` and a small `appimage-setup.log` file in
    `app.getPath('userData')` — necessary because a packaged AppImage
    launched via the GNOME keybinding or autostart has no visible terminal
    for `console.error` to reach otherwise.

  - **A native `Notification` fires when the hotkey binding is first
    decided** (`notifyHotkeyBound()` in `appImageSetup.ts`) — the log file
    is useless for telling an actual first-time user what shortcut they got
    (especially the `<Super><Shift>v` fallback case, which they'd otherwise
    have no way to discover). Only fires exactly once, in the same
    `slotWasMissing || !everManaged` branch that decides the binding itself
    — never on later self-heal runs. Guarded with `Notification.isSupported()`
    and a try/catch, consistent with this file's best-effort error handling
    elsewhere; confirmed the `org.freedesktop.Notifications` D-Bus service
    is genuinely present and responds on the target desktop (`gdbus call
    ... GetCapabilities`), not just that the call didn't throw.

  - **Double-clicking the AppImage a second time also notifies, in both
    directions** (`notifyAlreadyRunning()`/`notifyRelaunched()`) — a plain
    double-click (no `--toggle-popup`) with a resident instance already
    running previously did nothing visible at all (the losing process just
    quits; the resident's `second-instance` handler only acted on the
    hotkey's own toggle arg). Now the resident's `second-instance` handler
    has an `else` branch for exactly this case. Symmetrically, a plain
    double-click that *revives* a quit app doesn't show the popup either
    (only the hotkey arg does that) — `notifyRelaunched()` covers that case
    from `whenReady()`'s own `else` branch. Both read the hotkey's *current*
    live value via a new `currentBindingLabel()` (not just the two values
    this project assigns — also handles a binding the user rebound manually
    via GNOME Settings), and both are gated on `process.env.APPIMAGE` like
    `ensureHotkeyAndAutostart`, so dev-mode `pnpm start` stays exactly as
    quiet as before.

    **Avoiding a double-notification on a genuine first-ever launch took an
    explicit guard, not just careful ordering.** `alreadyConfigured =
    appImageSetup.isHotkeyConfigured()` is captured at the very top of
    `whenReady()`, *before* `ensureHotkeyAndAutostart()` runs — reusing the
    existing `.hotkey-managed` marker file check. Without it, a true first
    launch would fire both `notifyRelaunched()` (from the `else` branch,
    since `--toggle-popup` isn't in argv) *and* `notifyHotkeyBound()` (from
    `ensureHotkeyAndAutostart()` moments later) back to back. Verified
    directly via a temporary debug counter on `showNotification()`: exactly
    one call on a genuine cold start, exactly one call each on a
    steady-state relaunch and an already-running double-click.

- **Correction — "double-clicking does nothing" was misdiagnosed as a
  missing-mimetype-handler problem; it was actually just missing FUSE.**
  First diagnosis: `xdg-mime query default application/vnd.appimage`
  returned empty and `gio open <file>` (what Nautilus does internally on
  double-click) launched nothing, concluded from that alone that Nautilus
  has no AppImage handler and would need a separate tool
  (AppImageLauncher/Gear Lever). That test ran on a machine that *also*
  lacked FUSE at the time — two confounded variables, one wrong conclusion.
  After `libfuse2` was installed, real double-click on the same GNOME
  46/Nautilus desktop **worked immediately, with no AppImage integration
  tool installed at all**. Lesson: isolate variables before attributing a
  failure — the `gio open` "launches nothing" result was actually the
  `libfuse.so.2` crash happening invisibly, not evidence of a missing
  handler. Gear Lever/AppImageLauncher may still be worth having for proper
  app-menu integration, but they are **not required** just to make
  double-click launch the app, contrary to what was first documented here
  and in the README.

- **Tray "Uninstall..." (`appImageSetup.uninstall()`) is deliberately NOT
  gated on `process.env.APPIMAGE`**, unlike `ensureHotkeyAndAutostart()`.
  `setup.sh` (dev mode) and the AppImage's own first-run setup both write
  into the exact same gsettings slot name/path, so one cleanup function
  correctly reverses either — gating it to AppImage-only would leave
  dev-mode users with no way to clean up via the tray at all.

  **Real race condition found and fixed during testing, not assumed away:**
  the popup window's renderer calls `search` once on its own initial page
  load, regardless of visibility (it's pre-warmed hidden, per
  `popupWindow.ts`). Wiring the "also delete clipboard history" checkbox as
  `appImageSetup.uninstall()` → `store.wipeData()` → `app.quit()` hit this
  directly: `store.wipeData()` closes the DB, and if that renderer's
  initial `search` IPC call hadn't resolved yet, `ipcHandlers.ts`'s
  `search` handler threw `TypeError: The database connection is not open`
  — reproduced directly via a temporary CLI test hook, not theorized. Fix:
  call `popupWindow.destroy()` **before** `store.wipeData()`, not after —
  killing the renderer first structurally eliminates the race (no live IPC
  sender left), rather than adding defensive null-checks in `store.ts`'s
  query functions to paper over it.

  **The "Quit" menu item got the same checkbox and the same fix** — a user
  may want to wipe history without also tearing down the hotkey/autostart
  (that distinction is the whole point of having two separate menu items).
  Its handler mirrors `Uninstall...`'s exactly (`clipboardWatcher.stop()` →
  `popupWindow.destroy()` → `store.wipeData()` if checked → `app.quit()`)
  minus the `appImageSetup.uninstall()` call — re-verified via the same
  temporary-test-hook approach that the DB actually gets wiped, no race
  error appears, and critically that the gsettings hotkey registration is
  left completely untouched (Quit must never call `uninstall()`).

  **`store.wipeData()` closes the DB before deleting its files, not
  after** — it's opened in WAL mode (`store.ts`'s `init()`), so unlinking
  `clipboardian.db` out from under a still-open connection risks
  corruption/lock errors; `close()` (a thin `db.close()` wrapper) is called
  first.

  **The confirmation dialog must use the async `dialog.showMessageBox`,
  not `showMessageBoxSync`** — only the async form's resolved result
  includes `checkboxChecked`; the sync form only returns the button index.

- **The registered hotkey command points at a self-regenerating wrapper
  script (`toggle-wrapper.sh` in `app.getPath('userData')`), not the
  `.AppImage` file directly** — added after the user noticed the AppImage
  build's hotkey popup was ~1.5-2s slower than the source/`setup.sh` build's
  (<1s). Root cause: every hotkey press re-triggers the *entire* AppImage
  bootstrap (FUSE-mount the squashfs, run `AppRun`'s bash script — env var
  exports plus its `unshare -Ur true` sandbox heuristic — then finally exec
  the real `clipboardian` binary) even when a resident instance is already
  running and the press is just going to lose
  `app.requestSingleInstanceLock()` and exit. Confirmed via web research
  this is a known, unavoidable-at-the-AppImage-level limitation — AppImage's
  own maintainers explicitly rejected generic "reuse an existing mount"
  schemes as fragile
  ([AppImage/type2-runtime discussion #1327](https://github.com/orgs/AppImage/discussions/1327)),
  and their stated preferred pattern is exactly what this project already
  does: "keep the main application running as a parent process... rather
  than launching independent AppImage instances." A related
  electron-builder issue confirmed the specific mechanism works
  ([electron-builder #1727](https://github.com/electron-userland/electron-builder/issues/1727)):
  executing the Electron binary directly from inside the already-mounted
  `/tmp/.mount_XXXX/` directory is fast and skips the slow outer bootstrap
  entirely.

  `ensureFastToggleWrapper()` in `appImageSetup.ts` exploits this
  automatically: since AppImage's mount lifecycle is refcounted to
  processes from that mount, `process.execPath` inside the running resident
  (e.g. `/tmp/.mount_XXXX/clipboardian`) is a live, already-mounted binary
  the whole time the resident is alive — confirmed directly via `ps -ef`
  showing the resident's actual running path. The wrapper script is
  rewritten **unconditionally on every startup** (unlike the gsettings
  binding/marker logic elsewhere in this file, which deliberately writes
  once) since the mount path is different every launch:
  ```sh
  if [ -x "$MOUNT_BIN" ]; then
    exec "$MOUNT_BIN" --no-sandbox --toggle-popup
  else
    exec "$APPIMAGE_PATH" --toggle-popup
  fi
  ```
  When a resident is already running (the overwhelming majority of hotkey
  presses), this skips the FUSE mount and `AppRun` entirely. When no
  resident is running (first launch, or after Quit — the old mount is
  already torn down since nothing from it is still alive), it falls through
  to the unchanged, already-tested cold-start path: the real `.AppImage`
  file, which becomes the new resident and rewrites the wrapper with its
  own fresh mount path on its next startup.

  **`--no-sandbox` on the mount-bin branch is required, confirmed by a real
  crash during testing, not assumed.** The first version omitted it,
  reasoning (wrongly) that a losing instance calls
  `app.requestSingleInstanceLock()`/`app.quit()` before creating any
  window, so sandboxing wouldn't matter. In practice the crash happens
  *before any of that JS runs at all* — Chromium's sandbox init happens
  natively during process startup. Bypassing `AppRun` also bypasses its own
  `unshare -Ur true` heuristic (the thing that decides whether to add
  `--no-sandbox`), so a direct exec hit the exact FATAL `chrome-sandbox`
  crash this project already ruled out for every *other* invocation path
  (`pnpm start`, `setup.sh`'s hotkey command, the autostart entry — all of
  which hardcode `--no-sandbox` unconditionally, per this project's
  documented decision that the real sandbox doesn't work in this project's
  target environment and deliberately avoids requiring the `sudo
  chown`/`chmod` fix). Reproduced directly: invoking the wrapper without the
  flag crashed with `FATAL:setuid_sandbox_host.cc... aborting now` every
  time; adding `--no-sandbox` to just that branch fixed it, verified by
  invoking the wrapper directly multiple times and confirming it correctly
  signals the existing resident (same renderer PID throughout, no
  duplicate window) rather than crashing or spawning a second instance.
  Timing measured directly on this machine: full `.AppImage` invocation
  ~2.4-2.6s, wrapper invocation ~0.5-0.6s — closing almost all of the gap
  the user originally reported.

  **Verification**: contrary to this project's earlier assumption that this
  sandboxed dev environment lacks FUSE entirely (see the AppImage-testing
  note elsewhere in this file), a genuine FUSE mount (`/tmp/.mount_XXXX`,
  visible in `mount` as `type fuse.Clipboardian-1.0.0.AppImage`) was
  actually obtained here on a plain direct launch (no
  `--appimage-extract-and-run` needed) — so the full fast-path/fallback
  cycle was verified end-to-end, not just reasoned about: (1) fast path
  measured at ~0.5-0.6s vs. ~2.4-2.6s for the full `.AppImage` invocation,
  same resident renderer PID throughout, no crash, no duplicate window;
  (2) killing every process from the mount confirmed the mount and its
  `/tmp/.mount_XXXX` directory both disappear on their own (`mount | grep
  clipboardian` empty, directory gone) — confirming the refcounted
  auto-unmount behavior the fallback design depends on; (3) invoking the
  wrapper with no resident alive correctly fell through to
  `$APPIMAGE_PATH`, which relaunched, mounted fresh at a new
  `/tmp/.mount_XXXX` path, became the new resident, and rewrote the wrapper
  with its own new mount path on startup — confirming the self-healing
  cycle closes correctly. (Whether this particular dev sandbox actually has
  working FUSE seems to vary by invocation/session — not worth chasing
  further here, since it happened to work for this verification pass.)

## Releasing

`.github/workflows/release.yml` builds the AppImage and publishes a GitHub
Release automatically whenever a tag matching `v*` is pushed. To cut a
release:

```bash
pnpm version patch   # or minor/major — bumps package.json, commits, tags locally
git push              # push the commit to main on its own
git push --follow-tags   # main is already up to date, so this sends only the new tag
```

`pnpm version` (same as `npm version`) is the right tool for the
version-bump step specifically because it keeps `package.json`'s version
and the git tag in sync automatically — it bumps, commits, and creates an
annotated tag pointing at that commit in one step, so there's no separate
"remember to tag the same version" step to get out of sync. (For the very
first release, where `package.json` already holds the target version and
there's nothing to bump *from*, just tag directly instead:
`git tag vX.Y.Z`, then push it the same two-step way below.)

The workflow does the rest once the tag lands on GitHub (`pnpm install`,
`pnpm test`, `pnpm run dist`, then `gh release create` with the built
`.AppImage` attached, using GitHub's auto-generated release notes from
commit history). The `pnpm test` step means a release build never ships
if `store.ts`'s tests fail — see "Dev commands" above for what that suite
does and doesn't cover. Nothing enforces the tag matching `package.json`'s
version automatically when tagging directly (bypassing `pnpm version`);
keep them in sync by convention so the release title and the `.AppImage`
filename (`Clipboardian-<version>.AppImage`, derived from `package.json`)
make sense together.

**Correction — `git push --follow-tags` as a single, first push (branch
and tag bundled together in one invocation) did not trigger
`release.yml`, confirmed directly while cutting v1.0.0, not assumed.**
After `pnpm version 1.0.0` followed immediately by `git push
--follow-tags`, `git ls-remote --tags origin` confirmed the tag genuinely
reached GitHub, yet the Actions tab showed **0 workflow runs** for
`release.yml` — checked both via `WebFetch` and, after that looked
unreliable for GitHub's JS-heavy Actions UI, confirmed directly by the
user in their own authenticated browser. Fixed by deleting and re-pushing
the tag as its own standalone push (`git push --delete origin vX.Y.Z`,
then `git tag vX.Y.Z && git push origin vX.Y.Z`) — this time the workflow
run showed up immediately. **The exact root cause (a "combined ref push"
theory) was never 100% confirmed** — this is a working empirical pattern,
not a fully explained one. The two-step flow above (`git push` for the
branch, then a *separate* `git push --follow-tags` call) achieves the same
"tag pushed on its own" effect, since by the time the second command runs
the branch has nothing new to send — but until this has proven reliable
across a few more releases, glance at the Actions tab right after pushing
a tag rather than assuming it fired.

**Correction — electron-builder's own implicit publish-on-tag behavior
broke the first real CI run, confirmed via the actual failed run's log,
not assumed.** `pnpm run dist`'s `electron-builder` step failed in CI
(worked fine locally) with `⨯ GitHub Personal Access Token is not set,
neither programmatically, nor using env "GH_TOKEN"`, preceded by `•
Implicit publishing triggered by git tag. This behavior will be disabled
in electron-builder v27.` — electron-builder detects a CI environment
building from a git tag ref and assumes you want *it* to publish the
release itself via its own built-in GitHub provider, which needs a
`GH_TOKEN` env var this project never set (deliberately — `release.yml`
already does its own explicit `gh release create` step afterward, so a
second, electron-builder-driven publish would be redundant even if
configured). Fixed by adding `--publish never` to the `dist` script in
`package.json` (`"dist": "pnpm run build && electron-builder --linux
AppImage --publish never"`) — opts out explicitly rather than relying on
electron-builder's implicit-CI-detection default, which is being removed
in v27 anyway. Verified by re-running the build in CI after this fix.

No FUSE needed on the runner — packaging the AppImage doesn't require
running it. `permissions: contents: write` is required at the workflow
level for the default `GITHUB_TOKEN` to be allowed to create a release;
without it the token is read-only and the release step fails. Works on a
free GitHub account either way (public repos get unlimited free Actions
minutes; private repos get 2,000 free minutes/month, far more than an
occasional release build needs) — GitHub Releases themselves are free
regardless of repo visibility or plan.

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
