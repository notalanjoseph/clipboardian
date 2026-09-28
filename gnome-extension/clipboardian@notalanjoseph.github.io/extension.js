import Gio from 'gi://Gio';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// Exported on GNOME Shell's own session-bus connection (bus name
// org.gnome.Shell). Returns the pointer in global stage coordinates; the app
// converts them to Electron DIPs (src/main/popupPlacement.ts).
const IFACE = `
<node>
  <interface name="io.github.notalanjoseph.Clipboardian">
    <method name="GetPointer">
      <arg type="i" direction="out" name="x"/>
      <arg type="i" direction="out" name="y"/>
    </method>
  </interface>
</node>`;

const OBJECT_PATH = '/io/github/notalanjoseph/Clipboardian';

export default class ClipboardianExtension extends Extension {
  enable() {
    this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, {
      GetPointer() {
        const [x, y] = global.get_pointer();
        return [x, y];
      },
    });
    this._dbus.export(Gio.DBus.session, OBJECT_PATH);
  }

  disable() {
    this._dbus?.unexport();
    this._dbus = null;
  }
}
