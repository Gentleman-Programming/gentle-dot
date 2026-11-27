import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/qa-release.yml');
const launcher = read('scripts/windows/preview/Gentle-Dot-QA.cmd');
const repo = 'Gentleman-Programming/gentle-dot';
const digest = 'a'.repeat(64);

test('only a manual run on the QA ref can publish the verified SHA as a prerelease', () => {
	assert.match(workflow, /^on:\r?\n  workflow_dispatch:\r?\npermissions:/m);
	assert.match(workflow, /github\.ref == 'refs\/heads\/qa\/native-preview'/);
	assert.match(workflow, /branch=qa\/native-preview -f head_sha="\$GITHUB_SHA" -f event=push/);
	assert.match(workflow, /if \[\[ "\$run" != .*success \]\]; then/);
	assert.match(workflow, /needs: verify/);
	assert.match(workflow, /gh release create .*--target "\$GITHUB_SHA" --prerelease --latest=false/);
});

test('publisher renders the launcher from the verified Windows ZIP before hashing release assets', () => {
	const coverage = workflow.indexOf('verify-qa-manifest.mjs windows SHA256SUMS.txt Gentle-Dot-Preview-x64.zip');
	const verify = workflow.indexOf('sha256sum --strict -c SHA256SUMS.txt');
	assert.ok(coverage >= 0 && coverage < verify);
	assert.match(workflow, /verify-qa-manifest\.mjs "\$name" SHA256SUMS\r?\n\s*\(cd "\$name" && sha256sum --strict -c SHA256SUMS\)/);
	const render = workflow.indexOf('node scripts/package/render-qa-launcher.mjs');
	const hash = workflow.indexOf('sha256sum * > SHA256SUMS.txt');
	assert.ok(verify >= 0 && verify < render && render < hash);
	assert.match(workflow, /"\$GITHUB_REPOSITORY" "\$digest" > assets\/Gentle-Dot-QA\.cmd/);
});

test('the launcher binds a local ZIP to this release and uses asset metadata for online updates', async () => {
	const { renderQaLauncher } = await import('../render-qa-launcher.mjs');
	const rendered = renderQaLauncher(launcher, repo, digest);
	assert.match(rendered, /\$repo = 'Gentleman-Programming\/gentle-dot'/);
	assert.match(rendered, new RegExp(`\\$expected = '${digest}'`));
	assert.match(rendered, /\$expected = \$asset\[0\]\.digest\.Substring\(7\)/);
	assert.match(rendered, /if \(\$hash -ne \$expected\) \{ throw 'Unexpected QA ZIP checksum\.' \}/);
	assert.doesNotMatch(rendered, /__QA_|Maicololiveras|Could not unpack the GitHub artifact/);
	assert.ok(rendered.includes('\r\n'));
	assert.doesNotMatch(rendered.replace(/\r\n/g, ''), /[\r\n]/);
	assert.throws(() => renderQaLauncher(launcher, "bad/'repo", digest), /repository/);
	assert.throws(() => renderQaLauncher(launcher, repo, 'invalid'), /digest/);
});

test('download docs point to the official release channel instead of expiring fork artifacts', () => {
	const downloads = read('README.md').split('## Downloads')[1].split('\n## ')[0];
	assert.match(downloads, /github\.com\/Gentleman-Programming\/gentle-dot\/releases/);
	assert.doesNotMatch(downloads, /Maicololiveras|\/artifacts\//);
});
