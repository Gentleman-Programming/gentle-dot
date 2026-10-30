import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inputControlOverlayForClient } from '../inputcontrol-theme.mjs';

// Minimal upstream-shape fixture: no native code is imported or executed.
const original = `from __future__ import annotations

class WindowsOverlayHost:
    def paint(self, hdc):
        pen = self._gdi32.CreatePen(self._PS_SOLID, 3, 0x00FFFF00)
        self._verify_indicator(pen)
        return pen

    def stop(self):
        self._cancel.set()
        self._release_pressed_keys()
`;

test('Dot variant uses the Gentleman pink on the hands indicator without changing other code', () => {
  const expected = `from __future__ import annotations

class WindowsOverlayHost:
    def paint(self, hdc):
        pen = self._gdi32.CreatePen(self._PS_SOLID, 3, 0x00C895F0)
        self._verify_indicator(pen)
        return pen

    def stop(self):
        self._cancel.set()
        self._release_pressed_keys()
`;
  assert.equal(inputControlOverlayForClient(original, { client: 'gentle-dot' }), expected);
  assert.equal(original.includes('0x00FFFF00'), true);
});

test('the upstream provider source remains byte-for-byte unchanged without Dot opt-in', () => {
  assert.equal(inputControlOverlayForClient(original), original);
});
