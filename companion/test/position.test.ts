import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeWindow } from '../electron/position.ts';

const size = { width: 420, height: 520 };
const main = { x: 0, y: 25, width: 1512, height: 920 };
const right = { x: 1512, y: 0, width: 1920, height: 1080 };
// The pet sits at window offset (284, 390), 120 px square.
const petAt = (p: { x: number; y: number }) => ({ x: p.x + 284, y: p.y + 390 });

test('without a saved spot the window opens bottom right of the primary display', () => {
  assert.deepEqual(placeWindow(null, size, [main], main), { x: 1084, y: 425 });
  assert.deepEqual(placeWindow({ x: 'a' }, size, [main], main), { x: 1084, y: 425 });
});

test('a saved spot on screen is kept, including the pet flush at the left edge', () => {
  assert.deepEqual(placeWindow({ x: 300, y: 200 }, size, [main], main), { x: 300, y: 200 });
  assert.deepEqual(placeWindow({ x: -284, y: 200 }, size, [main], main), { x: -284, y: 200 });
});

test('a spot partly off screen is pulled in until the whole pet shows', () => {
  assert.deepEqual(petAt(placeWindow({ x: 1300, y: 700 }, size, [main], main)), { x: 1392, y: 825 });
  assert.deepEqual(petAt(placeWindow({ x: -500, y: -600 }, size, [main], main)), { x: 0, y: 25 });
});

test('a spot on an unplugged monitor moves to the nearest remaining display', () => {
  assert.deepEqual(petAt(placeWindow({ x: 2600, y: 300 }, size, [main], main)), { x: 1392, y: 690 });
});

test('with two displays the pet stays on the one it overlaps most', () => {
  assert.deepEqual(petAt(placeWindow({ x: 1200, y: 300 }, size, [main, right], main)), { x: 1512, y: 690 });
  assert.deepEqual(petAt(placeWindow({ x: 1140, y: 300 }, size, [main, right], main)), { x: 1392, y: 690 });
});
