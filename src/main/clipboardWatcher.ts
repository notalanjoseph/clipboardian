import { clipboard } from 'electron';

// wl-paste --watch (event-driven) only works on wlroots-based compositors
// (Sway, Hyprland, ...) via the zwlr_data_control protocol. GNOME's Mutter
// does not implement that protocol, so on GNOME/Wayland the only reliable
// option is polling clipboard.readText() directly.
const POLL_INTERVAL_MS = 500;
const MAX_ENTRY_BYTES = 200 * 1024; // guard against pasting huge blobs
const SELF_WRITE_TTL_MS = 2000;

let timer: ReturnType<typeof setInterval> | null = null;
let lastSeenText = '';

let lastWrittenByUs: string | null = null;
let lastWrittenAt = 0;

export function markSelfWritten(text: string): void {
  lastWrittenByUs = text;
  lastWrittenAt = Date.now();
  lastSeenText = text;
}

function isSelfWrite(text: string): boolean {
  return lastWrittenByUs === text && Date.now() - lastWrittenAt < SELF_WRITE_TTL_MS;
}

function isPlausibleText(text: string): boolean {
  if (!text) return false;
  return Buffer.byteLength(text, 'utf8') <= MAX_ENTRY_BYTES;
}

function poll(onEntry: (text: string) => void): void {
  const text = clipboard.readText();
  if (text === lastSeenText) return;
  lastSeenText = text;
  if (isSelfWrite(text)) return;
  if (!isPlausibleText(text)) return;
  onEntry(text);
}

export function start(onEntry: (text: string) => void): void {
  lastSeenText = clipboard.readText();
  timer = setInterval(() => poll(onEntry), POLL_INTERVAL_MS);
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
