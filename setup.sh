#!/usr/bin/env bash
# Full setup: installs deps, builds, registers a GNOME custom keybinding
# that toggles the clipboard history popup, and installs an autostart entry
# so the app launches on login. The keybinding step appends to the existing
# custom-keybindings array rather than overwriting it, so any shortcuts you
# already have stay intact.
#
# Hotkey: Super+V is used if it's free on this system, otherwise falls back
# to Super+Shift+V (Super+V is a built-in GNOME shortcut on many Ubuntu
# installs — toggles the notification/calendar panel — so it's often taken).
# If both are already taken, the hotkey is left unbound rather than silently
# assigning a binding something else already owns. Pass an explicit binding
# as $1 to skip auto-detection entirely.
set -euo pipefail

BASE="org.gnome.settings-daemon.plugins.media-keys"
SLOT_NAME="clipboardian"
SLOT_PATH="/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/${SLOT_NAME}/"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_BIN="${REPO_DIR}/node_modules/.bin/electron"

# Prints the schema/key (or custom-keybinding path) already holding $1, if
# any, and exits 1; exits 0 with no output if $1 is free. Checks both fixed
# schemas (org.gnome.shell.keybindings, .desktop.wm.keybindings, media-keys)
# and every already-registered custom-keybinding slot's own binding (read via
# the relocatable schema's schema:path syntax, since those aren't reachable
# through plain schema enumeration). $2 is a slot path to exclude from the
# custom-keybinding scan (this project's own slot, so a previous run's
# binding never flags as a false conflict against itself).
find_binding_conflict() {
  python3 - "$1" "$2" <<'PY'
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
# Settings was stored as "<Shift><Super>v", which a naive `val == candidate`
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
PY
}

if [[ -n "${1:-}" ]]; then
  BINDING="$1"
elif holder="$(find_binding_conflict '<Super>v' "$SLOT_PATH")"; then
  BINDING='<Super>v'
  echo "Super+V is free on this system — using it."
elif holder2="$(find_binding_conflict '<Super><Shift>v' "$SLOT_PATH")"; then
  BINDING='<Super><Shift>v'
  echo "Super+V is already bound to: $holder"
  echo "Using Super+Shift+V instead. Free up Super+V and rerun ./setup.sh to switch."
else
  BINDING=''
  echo "Super+V is already bound to: $holder"
  echo "Super+Shift+V is already bound to: $holder2"
  echo "Could not find a free hotkey for Clipboardian — leaving it unbound."
  echo "Please bind one manually via:"
  echo "  GNOME Settings -> Keyboard -> Keyboard Shortcuts -> Custom Shortcuts -> 'Clipboardian'"
fi

echo "Installing dependencies..."
(cd "$REPO_DIR" && pnpm install)

echo "Building..."
(cd "$REPO_DIR" && pnpm run build)

if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "error: $ELECTRON_BIN not found after 'pnpm install' — check for install errors above." >&2
  exit 1
fi

CMD="${ELECTRON_BIN} --no-sandbox ${REPO_DIR} --toggle-popup"

current="$(gsettings get "$BASE" custom-keybindings)"

if [[ "$current" != *"$SLOT_PATH"* ]]; then
  new="$(python3 - "$current" "$SLOT_PATH" <<'PY'
import ast
import sys

current, slot_path = sys.argv[1], sys.argv[2]
arr = ast.literal_eval(current)
if slot_path not in arr:
    arr.append(slot_path)
print(arr)
PY
)"
  gsettings set "$BASE" custom-keybindings "$new"
  echo "Registered new custom keybinding slot: $SLOT_PATH"
else
  echo "Custom keybinding slot already registered: $SLOT_PATH"
fi

gsettings set "${BASE}.custom-keybinding:${SLOT_PATH}" name 'Clipboardian'
gsettings set "${BASE}.custom-keybinding:${SLOT_PATH}" command "$CMD"
gsettings set "${BASE}.custom-keybinding:${SLOT_PATH}" binding "$BINDING"

if [[ -n "$BINDING" ]]; then
  echo "Hotkey bound to: $BINDING"
else
  echo "Hotkey left unbound (see above) — set one manually via GNOME Settings, then"
  echo "this slot ('Clipboardian') will already be there waiting for a binding."
fi
echo "Command: $CMD"
echo "To rebind manually, use:"
echo "  GNOME Settings -> Keyboard -> Keyboard Shortcuts -> Custom Shortcuts -> 'Clipboardian'"

AUTOSTART_DIR="${HOME}/.config/autostart"
AUTOSTART_FILE="${AUTOSTART_DIR}/clipboardian.desktop"
mkdir -p "$AUTOSTART_DIR"
cat > "$AUTOSTART_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Clipboardian
Comment=Background clipboard history watcher and hotkey popup
Exec=${ELECTRON_BIN} --no-sandbox ${REPO_DIR}
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF
echo "Installed autostart entry: $AUTOSTART_FILE (will launch on next login)"

echo "Setup complete. Run 'pnpm start' to try it now, or log out/in to pick up autostart."

if [[ -z "$BINDING" ]] && command -v gnome-control-center &>/dev/null; then
  echo "Opening GNOME Settings so you can bind one manually..."
  XDG_CURRENT_DESKTOP=GNOME gnome-control-center keyboard shortcuts >/dev/null 2>&1 &
fi
