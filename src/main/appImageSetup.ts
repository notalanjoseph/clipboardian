import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app, Notification } from 'electron';

// Must match main.ts's TOGGLE_ARG.
const TOGGLE_ARG = '--toggle-popup';

const BASE = 'org.gnome.settings-daemon.plugins.media-keys';
const SLOT_NAME = 'clipboardian';
const SLOT_PATH = `/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/${SLOT_NAME}/`;
const CUSTOM_SCHEMA = `${BASE}.custom-keybinding:${SLOT_PATH}`;

const AUTOSTART_FILE = path.join(os.homedir(), '.config', 'autostart', 'clipboardian.desktop');

function autostartMarkerFile(): string {
  return path.join(app.getPath('userData'), '.autostart-managed');
}

function hotkeyMarkerFile(): string {
  return path.join(app.getPath('userData'), '.hotkey-managed');
}

// Separate from hotkeyMarkerFile(): that one means "the hotkey question is
// permanently resolved" and is deliberately never written while both
// candidates are taken, so ensureHotkey() keeps retrying every launch. This
// one tracks a narrower thing — "has the user already been told about the
// both-taken situation at least once" — so repeat launches (still
// unresolved) don't re-fire the first-run notification/Settings popup
// forever, and isHotkeyConfigured() can correctly tell main.ts this isn't a
// genuinely first-ever launch even though the hotkey itself stayed unbound.
function noFreeHotkeyNotifiedMarkerFile(): string {
  return path.join(app.getPath('userData'), '.no-free-hotkey-notified');
}

function log(message: string): void {
  console.error(`[appImageSetup] ${message}`);
  try {
    const logFile = path.join(app.getPath('userData'), 'appimage-setup.log');
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // best-effort only
  }
}

// Handles the handful of GNOME accelerator modifiers we'd ever realistically
// see — either of the two bindings we produce ourselves, or a binding the
// user manually customized via GNOME Settings' own Custom Shortcuts UI.
function humanizeBinding(binding: string): string {
  return binding
    .replace(/<Super>/g, 'Super+')
    .replace(/<Control>/g, 'Ctrl+')
    .replace(/<Shift>/g, 'Shift+')
    .replace(/<Alt>/g, 'Alt+')
    .replace(/(.)$/, (c) => c.toUpperCase());
}

function showNotification(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title, body }).show();
  } catch (err) {
    log(`notification failed: ${err}`);
  }
}

// The only feedback otherwise is a hidden log file — a packaged AppImage
// launched via the GNOME keybinding or autostart has no visible terminal,
// so this is the only way a first-time user learns what hotkey got picked
// (this matters especially for the Super+Shift+V fallback case, which they
// wouldn't otherwise know to try).
function notifyHotkeyBound(binding: string): void {
  showNotification(
    "Clipboardian installed",
    `To open clipboard history press ${humanizeBinding(binding)}`,
  );
}

function notifyNoFreeHotkey(): void {
  showNotification(
    'Clipboardian installed | Action required',
    'Could not find a free hotkey. Bind one manually in ' +
      'GNOME Settings → Keyboard → Keyboard Shortcuts → Custom Shortcuts → "Clipboardian".',
  );
}

function gget(schema: string, key: string): { ok: boolean; raw: string } {
  try {
    const raw = execFileSync('gsettings', ['get', schema, key], { encoding: 'utf8' }).trim();
    return { ok: true, raw };
  } catch {
    return { ok: false, raw: '' };
  }
}

function gset(schema: string, key: string, value: string): boolean {
  try {
    execFileSync('gsettings', ['set', schema, key, value], { encoding: 'utf8' });
    return true;
  } catch (err) {
    log(`gsettings set ${schema} ${key} failed: ${err}`);
    return false;
  }
}

// Runs a python3 script via stdin (argv-identical to setup.sh's
// `python3 - "$1" "$2" <<'PY'`), so scripts ported from setup.sh work
// unmodified. Convention: exit 0 = the condition the script checks for is
// true (stdout carries any accompanying data); exit non-zero = false.
function pyRun(script: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync('python3', ['-', ...args], { input: script, encoding: 'utf8' });
    return { ok: true, stdout: stdout.trim() };
  } catch (err) {
    const stdout = String((err as { stdout?: string }).stdout ?? '').trim();
    return { ok: false, stdout };
  }
}

// Ported verbatim from setup.sh's find_binding_conflict(): same schema
// enumeration, same custom-keybinding-array walk, same ast.literal_eval
// matching. Exit 0 + no output = binding free; exit 1 + holder description
// on stdout = already taken.
const PY_FIND_CONFLICT = `
import ast
import re
import subprocess
import sys

candidate, exclude_path = sys.argv[1], sys.argv[2]

# GNOME/GTK accelerator strings aren't modifier-order-stable: the exact same
# key combination can be stored as "<Super><Shift>v" or "<Shift><Super>v"
# depending on how it was set (e.g. GNOME Settings' own UI writes modifiers
# in GTK's canonical bit-order, Shift before Super, while this project's own
# candidates historically used Super-first) — confirmed directly on a real
# machine: a Quick Settings shortcut rebound to Super+Shift+V via GNOME
# Settings was stored as "<Shift><Super>v", which a naive val == candidate
# comparison against "<Super><Shift>v" never matches, silently missing a
# real conflict. Normalize modifier order before comparing so this class of
# false-negative can't happen again, regardless of which order either side
# happens to use.
_MODIFIER_ORDER = ['Shift', 'Control', 'Alt', 'Super', 'Hyper', 'Meta', 'Primary']


def normalize_accel(accel):
    if not isinstance(accel, str) or not accel:
        return accel
    mods = re.findall(r'<([^>]+)>', accel)
    key = re.sub(r'(<[^>]+>)+', '', accel)
    mods_sorted = sorted(
        set(mods),
        key=lambda m: _MODIFIER_ORDER.index(m) if m in _MODIFIER_ORDER else 999,
    )
    return ''.join(f'<{m}>' for m in mods_sorted) + key.lower()


def sh(*args):
    r = subprocess.run(args, capture_output=True, text=True)
    return r.returncode, r.stdout.strip()


def matches(raw):
    try:
        val = ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        return False
    if isinstance(val, str):
        return normalize_accel(val) == normalize_accel(candidate)
    if isinstance(val, (list, tuple)):
        return any(
            isinstance(v, str) and normalize_accel(v) == normalize_accel(candidate)
            for v in val
        )
    return False


rc, out = sh('gsettings', 'list-schemas')
schemas = sorted(
    s for s in out.splitlines()
    if 'keybinding' in s.lower() or 'media-keys' in s.lower()
)
for schema in schemas:
    rc, keys_out = sh('gsettings', 'list-keys', schema)
    if rc != 0:
        continue
    for key in keys_out.splitlines():
        rc, raw = sh('gsettings', 'get', schema, key)
        if rc == 0 and matches(raw):
            print(f"{schema} {key}")
            sys.exit(1)

rc, arr_raw = sh(
    'gsettings', 'get',
    'org.gnome.settings-daemon.plugins.media-keys', 'custom-keybindings',
)
try:
    paths = ast.literal_eval(arr_raw) if rc == 0 else []
except (ValueError, SyntaxError):
    paths = []

for path in paths:
    if path == exclude_path:
        continue
    rc, raw = sh(
        'gsettings', 'get',
        f'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:{path}',
        'binding',
    )
    if rc == 0 and matches(raw):
        print(f"custom-keybinding {path}")
        sys.exit(1)

sys.exit(0)
`;

// Exit 0 = item is a member of the array (or array unparseable -> treated
// as absent, exit 1).
const PY_ARRAY_CONTAINS = `
import ast
import sys

raw, item = sys.argv[1], sys.argv[2]
try:
    arr = ast.literal_eval(raw)
except (ValueError, SyntaxError):
    arr = []
sys.exit(0 if item in arr else 1)
`;

// Prints the array with item appended (if not already present). Ported
// verbatim from setup.sh's array-ensure heredoc.
const PY_ARRAY_APPEND = `
import ast
import sys

current, item = sys.argv[1], sys.argv[2]
arr = ast.literal_eval(current)
if item not in arr:
    arr.append(item)
print(arr)
`;

// Prints the array with item removed (if present).
const PY_ARRAY_REMOVE = `
import ast
import sys

current, item = sys.argv[1], sys.argv[2]
arr = ast.literal_eval(current)
if item in arr:
    arr.remove(item)
print(arr)
`;

// Exit 0 = the GVariant value parses to exactly the expected string.
// Centralizes all gsettings-value comparisons through ast.literal_eval so
// nothing hand-parses or hand-constructs GVariant literal text in JS/TS.
const PY_VALUE_MATCHES = `
import ast
import sys

raw, expected = sys.argv[1], sys.argv[2]
try:
    val = ast.literal_eval(raw)
except (ValueError, SyntaxError):
    sys.exit(1)
sys.exit(0 if val == expected else 1)
`;

// Prints the parsed string value, or nothing if empty/unset/unparseable.
const PY_VALUE_OR_EMPTY = `
import ast
import sys

raw = sys.argv[1]
try:
    val = ast.literal_eval(raw)
except (ValueError, SyntaxError):
    val = ''
print(val if isinstance(val, str) else '')
`;

// Unquotes a GVariant string literal (what `gsettings get` prints for a
// string-typed key, e.g. `'<Super>v'` or `''`) without spawning python3.
// Everywhere else in this file uses PY_VALUE_OR_EMPTY/ast.literal_eval for
// this, which is the right call for one-shot per-launch reads — but
// currentBindingLabel() is polled every few seconds for as long as the app
// is resident (main.ts's tray-refresh interval), so avoiding a second
// subprocess spawn on every tick is worth the narrower parsing logic here.
// Safe specifically because this key's value is always either empty or a
// simple accelerator string (only ever written by our own gset() calls or
// GNOME Settings' own UI) — never anything containing quotes/newlines that
// would need real escape-sequence handling. Falls back to '' for anything
// that isn't cleanly quote-delimited, mirroring PY_VALUE_OR_EMPTY's own
// fallback for unparseable input.
function unquoteGVariantString(raw: string): string {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if (trimmed.length >= 2 && (quote === "'" || quote === '"') && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return '';
}

// Reads whatever the hotkey binding *currently* is — the default we picked,
// or something the user rebound manually via GNOME Settings — for display
// in launch notifications and the tray menu. Returns null if unset/unreadable.
// Not gated on process.env.APPIMAGE: setup.sh (dev mode) and this file's own
// first-run setup both write into the same gsettings slot, so a plain read
// works correctly regardless of which one configured it.
export function currentBindingLabel(): string | null {
  const raw = gget(CUSTOM_SCHEMA, 'binding');
  if (!raw.ok) return null;
  const value = unquoteGVariantString(raw.raw);
  return value ? humanizeBinding(value) : null;
}

// Opens GNOME's own Keyboard Shortcuts settings so the user can rebind
// manually — reuses GNOME's real shortcut editor (with its own conflict
// detection/UI) rather than building a custom key-capture dialog. "keyboard
// shortcuts" is a documented gnome-control-center invocation (confirmed via
// the actual man page, not just assumed) that opens directly to the
// shortcuts tab; it can't deep-link any further to the specific
// "Clipboardian" row within Custom Shortcuts — GNOME doesn't expose that
// level of navigation via the CLI, so the user still scrolls to it
// themselves, same as this project's own README instructions. Not gated on
// process.env.APPIMAGE, matching currentBindingLabel() — this is a general
// runtime action, not a first-run setup step.
//
// XDG_CURRENT_DESKTOP is forced to 'GNOME' explicitly, confirmed necessary
// by testing, not assumption: gnome-control-center refuses to start at all
// ("Running gnome-control-center is only supported under GNOME and Unity,
// exiting") unless it sees that variable — and however this app itself got
// launched (hotkey press, AppImage bootstrap), its own process environment
// doesn't reliably carry it, even though a real interactive desktop session
// has it set. Reproduced directly: spawning gnome-control-center with
// XDG_CURRENT_DESKTOP stripped hit this exact error; forcing it back fixed
// it. Safe to hardcode 'GNOME' since this project already assumes a GNOME
// session everywhere else (the gsettings schemas it reads/writes).
export function openHotkeySettings(): void {
  execFile(
    'gnome-control-center',
    ['keyboard', 'shortcuts'],
    { env: { ...process.env, XDG_CURRENT_DESKTOP: 'GNOME' } },
    (err) => {
      if (err) {
        log(`failed to open GNOME Settings: ${err}`);
        showNotification(
          'Clipboardian | Action required',
          'Could not open GNOME Settings automatically — open it manually: ' +
            'Settings → Keyboard → View and Customize Shortcuts → Custom Shortcuts.',
        );
      }
    },
  );
}

function wrapperScriptFile(): string {
  return path.join(app.getPath('userData'), 'toggle-wrapper.sh');
}

// The registered hotkey command normally invokes the .AppImage file itself,
// which is slow: every press re-triggers the full AppImage bootstrap (FUSE
// mount, AppRun's env-var exports, its `unshare -Ur true` sandbox heuristic)
// even when a resident instance is already running and the press is just
// going to lose the single-instance lock and exit. AppImage's own mount
// lifecycle is refcounted to processes from that mount — while the resident
// is alive, `process.execPath` (e.g. `/tmp/.mount_XXXX/clipboardian`) is a
// live, already-mounted binary we can exec directly, skipping that whole
// bootstrap. Rewritten unconditionally on every startup (unlike the
// gsettings binding/marker logic) since the mount path is different every
// launch. Falls back to the real .AppImage path (which becomes the new
// resident and rewrites this wrapper with its own fresh mount path) when no
// resident is running and the old mount is gone.
//
// The mount-bin branch passes --no-sandbox explicitly, confirmed necessary
// by testing, not assumption: bypassing AppRun also bypasses its own
// `unshare -Ur true` heuristic that decides whether to add --no-sandbox,
// so a direct exec hit the exact FATAL chrome-sandbox crash this project
// already ruled out elsewhere ("Electron runs with --no-sandbox") for
// every other invocation path (pnpm start, setup.sh's hotkey command, the
// autostart entry) — all of which hardcode the flag unconditionally rather
// than relying on a per-invocation heuristic, because this project already
// decided the real sandbox doesn't work here and deliberately avoids the
// sudo chown/chmod fix. The fallback branch is left alone (still goes
// through the real AppImage/AppRun, whose own heuristic runs as normal)
// since it's unchanged, already-tested cold-start behavior.
function ensureFastToggleWrapper(appimagePath: string): string {
  const wrapperPath = wrapperScriptFile();
  const content = [
    '#!/bin/sh',
    '# Auto-regenerated by Clipboardian on every launch — do not edit by hand.',
    `MOUNT_BIN="${process.execPath}"`,
    `APPIMAGE_PATH="${appimagePath}"`,
    'if [ -x "$MOUNT_BIN" ]; then',
    `  exec "$MOUNT_BIN" --no-sandbox ${TOGGLE_ARG}`,
    'else',
    `  exec "$APPIMAGE_PATH" ${TOGGLE_ARG}`,
    'fi',
    '',
  ].join('\n');
  fs.writeFileSync(wrapperPath, content);
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

// Returns whether this call fired a notification (notifyHotkeyBound or
// notifyNoFreeHotkey) — main.ts uses this to avoid also firing
// notifyRelaunched() in the same launch, which would otherwise show two
// contradictory notifications back to back on a launch where a previously
// unresolvable hotkey becomes bindable (see AGENTS.md correction).
function ensureHotkey(appimagePath: string): boolean {
  const expectedCommand = ensureFastToggleWrapper(appimagePath);

  const arrResult = gget(BASE, 'custom-keybindings');
  const rawArray = arrResult.ok ? arrResult.raw : '[]';

  const alreadyMember = pyRun(PY_ARRAY_CONTAINS, [rawArray, SLOT_PATH]).ok;
  let slotWasMissing = false;
  if (!alreadyMember) {
    const appended = pyRun(PY_ARRAY_APPEND, [rawArray, SLOT_PATH]);
    if (!appended.ok) {
      log('could not parse custom-keybindings array; skipping hotkey setup');
      return false;
    }
    if (!gset(BASE, 'custom-keybindings', appended.stdout)) return false;
    slotWasMissing = true;
    log(`registered new custom keybinding slot: ${SLOT_PATH}`);
  }

  const nameRaw = gget(CUSTOM_SCHEMA, 'name');
  const nameMatches = nameRaw.ok && pyRun(PY_VALUE_MATCHES, [nameRaw.raw, 'Clipboardian']).ok;
  if (!nameMatches) gset(CUSTOM_SCHEMA, 'name', 'Clipboardian');

  const cmdRaw = gget(CUSTOM_SCHEMA, 'command');
  const cmdMatches = cmdRaw.ok && pyRun(PY_VALUE_MATCHES, [cmdRaw.raw, expectedCommand]).ok;
  if (!cmdMatches) {
    if (gset(CUSTOM_SCHEMA, 'command', expectedCommand)) {
      log(`updated hotkey command to: ${expectedCommand}`);
    }
  }

  // Only ever decide the binding once, ever — UNLESS neither candidate was
  // free last time, in which case nothing got written, so there's no user
  // choice to protect yet and it's safe (and desirable) to retry on every
  // launch until one frees up or the user sets one manually. An empty
  // binding can otherwise mean two very different things: "never assigned"
  // (should assign) or "the user deliberately cleared it via GNOME
  // Settings' own Custom Shortcuts UI, which sets binding to '' rather
  // than removing the slot" (must not reassign). Both look identical at
  // the gsettings level, so a marker file is the only way to tell them
  // apart — this runs automatically on every login with no user action,
  // unlike setup.sh which only runs when a user deliberately invokes it,
  // so we must never clobber a user's own choice.
  const marker = hotkeyMarkerFile();
  const everManaged = fs.existsSync(marker);
  if (slotWasMissing || !everManaged) {
    const bindingRaw = gget(CUSTOM_SCHEMA, 'binding');
    const currentBinding = bindingRaw.ok ? pyRun(PY_VALUE_OR_EMPTY, [bindingRaw.raw]).stdout : '';

    if (currentBinding) {
      // Something already set a binding since the last (failed) attempt —
      // most likely the user, manually, in response to notifyNoFreeHotkey().
      // Respect it and stop retrying rather than overwriting it later.
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, '');
      log(`hotkey already bound to ${currentBinding}; leaving as-is`);
      return false;
    }

    const superVFree = pyRun(PY_FIND_CONFLICT, ['<Super>v', SLOT_PATH]).ok;
    let binding: string | null = null;
    if (superVFree) {
      binding = '<Super>v';
    } else if (pyRun(PY_FIND_CONFLICT, ['<Super><Shift>v', SLOT_PATH]).ok) {
      binding = '<Super><Shift>v';
    }

    if (binding) {
      if (gset(CUSTOM_SCHEMA, 'binding', binding)) {
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, '');
        log(`hotkey bound to ${binding}`);
        notifyHotkeyBound(binding);
        return true;
      }
    } else {
      // Both candidates taken — don't write an unusable binding. The
      // *resolved* marker is deliberately NOT written, so this keeps
      // retrying every future launch until one frees up or the user binds
      // one manually.
      log('could not find a free hotkey: Super+V and Super+Shift+V are both taken');
      // But only notify/open Settings the first time this is discovered —
      // otherwise every single relaunch (e.g. via autostart on login) would
      // re-fire the same notification and re-pop Settings open forever.
      const noFreeHotkeyMarker = noFreeHotkeyNotifiedMarkerFile();
      if (!fs.existsSync(noFreeHotkeyMarker)) {
        fs.mkdirSync(path.dirname(noFreeHotkeyMarker), { recursive: true });
        fs.writeFileSync(noFreeHotkeyMarker, '');
        notifyNoFreeHotkey();
        // Only pop open Settings when the user actually needs to act —
        // a successful auto-bind above needs no follow-up, but this message
        // already tells them to bind one manually, so opening it directly
        // removes that friction entirely.
        openHotkeySettings();
        return true;
      }
    }
  }
  return false;
}

function writeAutostartFile(appimagePath: string): void {
  fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Clipboardian',
    'Comment=Background clipboard history watcher and hotkey popup',
    `Exec=${appimagePath}`,
    'X-GNOME-Autostart-enabled=true',
    'NoDisplay=true',
    '',
  ].join('\n');
  fs.writeFileSync(AUTOSTART_FILE, content);
}

function ensureAutostart(appimagePath: string): void {
  const expectedExecLine = `Exec=${appimagePath}`;
  const marker = autostartMarkerFile();
  const everManaged = fs.existsSync(marker);
  const fileExists = fs.existsSync(AUTOSTART_FILE);

  if (!fileExists) {
    if (everManaged) {
      log('autostart entry was previously removed by the user; not recreating');
      return;
    }
    writeAutostartFile(appimagePath);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
    log(`installed autostart entry: ${AUTOSTART_FILE}`);
    return;
  }

  const content = fs.readFileSync(AUTOSTART_FILE, 'utf8');
  const execLine = content.split('\n').find((l) => l.startsWith('Exec='));
  if (execLine !== expectedExecLine) {
    writeAutostartFile(appimagePath);
    log(`updated stale autostart entry exec path: ${AUTOSTART_FILE}`);
  }
}

// Whether the hotkey question has already been addressed once before (i.e.
// this isn't a genuinely first-ever launch) — used by main.ts to decide
// whether a plain double-click relaunch should get its own notification, or
// whether ensureHotkeyAndAutostart's one-time first-run notification already
// covers it (avoids showing both back to back on true first launch). Checks
// both markers since "addressed" has two distinct shapes: successfully
// bound (hotkeyMarkerFile), or discovered-and-reported-unbound at least once
// (noFreeHotkeyNotifiedMarkerFile) — without the second check, a permanently
// unresolved "both taken" launch would (bug, found via testing) look
// identical to a genuinely first-ever launch on every single relaunch,
// since the resolved marker is deliberately never written in that case.
export function isHotkeyConfigured(): boolean {
  return fs.existsSync(hotkeyMarkerFile()) || fs.existsSync(noFreeHotkeyNotifiedMarkerFile());
}

// Both gated on process.env.APPIMAGE, matching ensureHotkeyAndAutostart —
// these are launch-feedback notifications specific to double-clicking the
// packaged AppImage; dev-mode `pnpm start` stays quiet, same as it always
// has, so repeated dev-mode restarts don't spam notifications.
export function notifyAlreadyRunning(): void {
  if (!process.env.APPIMAGE) return;
  const label = currentBindingLabel();
  showNotification(
    "Clipboardian | Running",
    label
      ? `Clipboardian is already running in background — to open it press ${label}`
      : "Clipboardian is already running in background. Change Hotkey to start using it.",
  );
}

export function notifyRelaunched(): void {
  if (!process.env.APPIMAGE) return;
  const label = currentBindingLabel();
  showNotification(
    "Clipboardian | Started",
    label
      ? `To open clipboard history press ${label}`
      : "Change Hotkey to start using Clipboardian.",
  );
}

// Only does anything when running as a packaged AppImage (APPIMAGE is set
// by the AppImage runtime to the running .AppImage file's own absolute
// path — confirmed present even under --appimage-extract-and-run). Dev-mode
// `electron .`/`pnpm start` never has this set, so this is a no-op there;
// that flow still relies on setup.sh, unchanged.
//
// Returns whether ensureHotkey() fired a notification this run — main.ts
// uses this to decide whether notifyRelaunched() also needs to fire, so a
// launch that both relaunches *and* newly resolves the hotkey doesn't show
// two contradictory notifications back to back.
export function ensureHotkeyAndAutostart(): boolean {
  const appimagePath = process.env.APPIMAGE;
  if (!appimagePath) return false;

  let notified = false;
  try {
    notified = ensureHotkey(appimagePath);
  } catch (err) {
    log(`hotkey setup failed: ${err}`);
  }

  try {
    ensureAutostart(appimagePath);
  } catch (err) {
    log(`autostart setup failed: ${err}`);
  }

  return notified;
}

// Reverses whatever's registered under SLOT_PATH, regardless of whether
// setup.sh (dev mode) or ensureHotkeyAndAutostart (packaged AppImage)
// created it — both use the same slot name/path, so one cleanup path
// handles either. Not gated on process.env.APPIMAGE, since the tray menu
// (and this action) exists in both dev mode and the packaged app.
export function uninstall(): void {
  try {
    const arrResult = gget(BASE, 'custom-keybindings');
    if (arrResult.ok) {
      const contains = pyRun(PY_ARRAY_CONTAINS, [arrResult.raw, SLOT_PATH]).ok;
      if (contains) {
        const removed = pyRun(PY_ARRAY_REMOVE, [arrResult.raw, SLOT_PATH]);
        if (removed.ok && gset(BASE, 'custom-keybindings', removed.stdout)) {
          log(`removed custom keybinding slot: ${SLOT_PATH}`);
        }
      }
    }
    execFileSync('gsettings', ['reset-recursively', CUSTOM_SCHEMA], { encoding: 'utf8' });
  } catch (err) {
    log(`hotkey removal failed: ${err}`);
  }

  try {
    if (fs.existsSync(AUTOSTART_FILE)) {
      fs.unlinkSync(AUTOSTART_FILE);
      log(`removed autostart entry: ${AUTOSTART_FILE}`);
    }
  } catch (err) {
    log(`autostart removal failed: ${err}`);
  }

  try {
    for (const marker of [
      hotkeyMarkerFile(),
      autostartMarkerFile(),
      noFreeHotkeyNotifiedMarkerFile(),
    ]) {
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
    }
  } catch (err) {
    log(`marker cleanup failed: ${err}`);
  }
}
