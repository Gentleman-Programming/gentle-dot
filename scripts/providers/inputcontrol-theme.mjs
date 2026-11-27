// InputControl 0.2.1, upstream commit bac26c6061b2dcb81f1466aec153b33869882d85.
// GDI COLORREF is BGR: Gentleman Programming's #f095c8 becomes 0x00C895F0.
const originalPen = 'self._gdi32.CreatePen(self._PS_SOLID, 3, 0x00FFFF00)';
const dotPen = 'self._gdi32.CreatePen(self._PS_SOLID, 3, 0x00C895F0)';

/**
 * Build a separately identified Dot source variant after verifying upstream provenance.
 * This changes neither installed providers nor session/indicator-health/Stop guards.
 * Non-Dot builds retain upstream source bytes, including its original indicator color.
 */
export function inputControlOverlayForClient(source, { client = 'upstream' } = {}) {
  if (typeof source !== 'string') throw new TypeError('Expected InputControl overlay source');
  if (client !== 'gentle-dot') return source;
  if (source.split(originalPen).length !== 2) {
    throw new Error('Unsupported InputControl overlay source: expected one upstream pen');
  }
  return source.replace(originalPen, dotPen);
}
