import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageToDip, placeAtCursor } from './popupPlacement';

test('stageToDip: logical layout (Electron scale 1) is identity', () => {
  assert.deepEqual(stageToDip({ x: 2718, y: 708 }, 1, false), { x: 2718, y: 708 });
});

test('stageToDip: physical layout at 200% divides by the scale', () => {
  assert.deepEqual(stageToDip({ x: 1600, y: 900 }, 2, false), { x: 800, y: 450 });
});

test('stageToDip: xwayland-native-scaling is identity even with a scaled Electron', () => {
  assert.deepEqual(stageToDip({ x: 1600, y: 900 }, 2, true), { x: 1600, y: 900 });
});

test('stageToDip: a nonsensical scale factor is ignored rather than dividing by it', () => {
  assert.deepEqual(stageToDip({ x: 10, y: 20 }, 0, false), { x: 10, y: 20 });
});

const WA = { x: 0, y: 0, width: 1920, height: 1080 };

test('placeAtCursor: top-left corner at the cursor when it fits', () => {
  assert.deepEqual(placeAtCursor({ x: 100, y: 200 }, WA, 480, 360), { x: 100, y: 200 });
});

test('placeAtCursor: flips left and up near the bottom-right edge', () => {
  assert.deepEqual(placeAtCursor({ x: 1800, y: 1000 }, WA, 480, 360), { x: 1320, y: 640 });
});

test('placeAtCursor: clamps into a second monitor offset from the origin', () => {
  // eDP-1 on the dev machine: 1536x864 at +1920+216.
  const edp = { x: 1920, y: 216, width: 1536, height: 864 };
  assert.deepEqual(placeAtCursor({ x: 1930, y: 220 }, edp, 480, 360), { x: 1930, y: 220 });
  assert.deepEqual(placeAtCursor({ x: 2100, y: 400 }, edp, 480, 700), { x: 2100, y: 216 });
});
