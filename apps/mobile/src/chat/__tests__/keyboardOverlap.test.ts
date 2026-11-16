import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keyboardOverlapDp } from '../keyboardOverlap';

// Measured on the Android 16 emulator (1280x2856, 3x) on 2026-09-23. The
// keyboard's top was at 1,848 px (616 dp), the status bar 156 px (52 dp), and
// the chat container's bottom at 2,784 px, which measureInWindow reports as
// 876 dp because it counts from below the status bar.
const EMULATOR = { viewY: 147, viewHeight: 729, viewportTop: 52, keyboardTop: 616 };

describe('keyboardOverlapDp', () => {
  it('lifts the chat by the whole overlap, so the text box and Send clear the keyboard', () => {
    const overlap = keyboardOverlapDp(EMULATOR);
    assert.equal(overlap, 312);
    // The container pads by 8 dp plus the overlap; its bottom was 2,784 px.
    const chatBottomPx = 2784 - (8 + overlap) * 3;
    assert.ok(chatBottomPx <= 1848, `the chat must end above the keyboard (ended at ${chatBottomPx})`);
  });

  it('without the status bar height it comes out 52 dp short, which was the fault', () => {
    const short = keyboardOverlapDp({ ...EMULATOR, viewportTop: 0 });
    assert.equal(short, 260);
    assert.equal(2784 - (8 + short) * 3, 1980, 'the 1,980 px measured on the emulator');
  });

  it('is nothing on a phone whose window already shrinks for the keyboard', () => {
    // The container then ends at the keyboard's top edge.
    assert.equal(keyboardOverlapDp({ viewY: 147, viewHeight: 417, viewportTop: 52, keyboardTop: 616 }), 0);
  });

  it('never goes negative and ignores a measurement that did not come back', () => {
    assert.equal(keyboardOverlapDp({ viewY: 0, viewHeight: 100, viewportTop: 24, keyboardTop: 700 }), 0);
    assert.equal(keyboardOverlapDp({ viewY: Number.NaN, viewHeight: 100, viewportTop: 24, keyboardTop: 700 }), 0);
  });
});
