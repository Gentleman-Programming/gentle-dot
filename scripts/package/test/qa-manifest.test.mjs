import assert from 'node:assert/strict';
import test from 'node:test';

test('QA checksum coverage is exact and includes the Windows ZIP when selected', async () => {
	const { validateQaManifest } = await import('../verify-qa-manifest.mjs');
	const line = (name) => `${'a'.repeat(64)}  ${name}\n`;
	const zip = 'Gentle-Dot-Preview-x64.zip';
	assert.doesNotThrow(() => validateQaManifest(line(zip), [zip], zip));
	assert.doesNotThrow(() => validateQaManifest(line('Gentle Dot.dmg'), ['Gentle Dot.dmg']));
	assert.throws(() => validateQaManifest(line('extra.zip'), [zip, 'extra.zip'], zip), /missing/);
	assert.throws(() => validateQaManifest(line('known.deb'), ['known.deb', 'unlisted.deb']), /coverage/);
	assert.throws(() => validateQaManifest(line('known.deb') + line('known.deb'), ['known.deb']), /duplicate/);
	assert.throws(() => validateQaManifest(line('../outside'), ['outside']), /invalid/);
	assert.throws(() => validateQaManifest('', []), /empty/);
});
