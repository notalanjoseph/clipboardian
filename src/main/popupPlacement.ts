// Pure placement math for the cursor-relative popup, kept free of Electron
// imports so popupPlacement.test.ts can cover every HiDPI mode — the dev
// machine only has scale-1 displays, so the tests are the only check the
// non-1 cases get.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Converts GNOME Shell's stage coordinates (global.get_pointer(), from the
// bundled extension) into Electron's DIPs. Electron runs under XWayland,
// where DIP = X11 pixel / electronScale (one global scale factor on X11,
// from Xft.dpi):
// - Logical layout (scale-monitor-framebuffer, i.e. fractional scaling on):
//   stage and X11 are both logical pixels and Xft.dpi stays 96, so
//   electronScale is 1 — identity.
// - Physical layout (plain integer scaling, GNOME's default): stage and X11
//   are both physical pixels and Xft.dpi is scaled (192 at 200%), so divide.
// - Logical + xwayland-native-scaling (GNOME 47+ opt-in): stage is logical
//   but X11 is physical (stage × scale) and Xft.dpi is scaled, so the two
//   cancel out — identity.
export function stageToDip(p: Point, electronScale: number, xwaylandNativeScaling: boolean): Point {
  if (xwaylandNativeScaling || !(electronScale > 0)) return p;
  return { x: p.x / electronScale, y: p.y / electronScale };
}

// Top-left corner at the cursor, like a context menu; flipped to the other
// side of the cursor near the right/bottom edge, then clamped so it never
// leaves the work area.
export function placeAtCursor(cursor: Point, workArea: Rect, width: number, height: number): Point {
  let x = cursor.x;
  let y = cursor.y;
  if (x + width > workArea.x + workArea.width) x = cursor.x - width;
  if (y + height > workArea.y + workArea.height) y = cursor.y - height;
  x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width);
  y = Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height);
  return { x: Math.round(x), y: Math.round(y) };
}
