import assert from 'node:assert/strict';
import test from 'node:test';
import { startupStageDefines } from '../src/runtime-build.ts';
import { consumeStartupStageEndpoint } from '../src/startup-stage-observer.ts';
import { startWithWindowsAppChannel } from '../src/windows-stop.ts';

const id = '0123456789abcdef0123456789abcdef';
const selector = { GENTLE_DOT_CI_DAEMON_PHASE_PORT: '43194', GENTLE_DOT_CI_DAEMON_PHASE_ID: id };

test('runtime selector is consumed even if invalid; no partial endpoint', () => {
	for (const port of ['43194', '043194', '43195', '43194\n']) {
		for (const nonce of [id, id.toUpperCase(), `${id}\n`, '']) {
			const env = { ...selector, KEEP: 'value', GENTLE_DOT_CI_DAEMON_PHASE_PORT: port, GENTLE_DOT_CI_DAEMON_PHASE_ID: nonce };
			assert.equal(consumeStartupStageEndpoint(env), port === '43194' && nonce === id ? id : undefined);
			assert.deepEqual(env, { KEEP: 'value' });
		}
	}
});

test('default esbuild configuration is literal false unless exact hosted compile context matches', () => {
	const branch = 'refs/heads/qa/windows-staged-daemon-phases-44794993333';
	const context = {
		GENTLE_DOT_CI_DAEMON_PHASE_BUILD: '1', CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
		RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'observe',
		GITHUB_REPOSITORY: 'Gentleman-Programming/gentle-dot', GITHUB_EVENT_NAME: 'push', GITHUB_REF: branch,
		GITHUB_WORKFLOW: 'Windows staged daemon phases 44794993333',
		GITHUB_WORKFLOW_REF: `Gentleman-Programming/gentle-dot/.github/workflows/windows-staged-daemon-phases-44794993333.yml@${branch}`,
	};
	const off = { __GENTLE_DOT_DAEMON_PHASES__: 'false' };
	assert.deepEqual(startupStageDefines('win32', 'x64', selector), off);
	assert.deepEqual(startupStageDefines('win32', 'x64', context), { __GENTLE_DOT_DAEMON_PHASES__: 'true' });
	assert.deepEqual(startupStageDefines('win32', 'arm64', context), off);
	assert.deepEqual(startupStageDefines('linux', 'x64', context), off);
	for (const key of Object.keys(context)) assert.deepEqual(startupStageDefines('win32', 'x64', { ...context, [key]: 'wrong' }), off);
});

test('fd3 failure is attributed after stop admission and preserves the original rejection', async () => {
	const sentinel = new Error('inert fd3 failure');
	const events: Array<[number, boolean]> = [];
	let starts = 0;
	let closes = 0;
	await assert.rejects(startWithWindowsAppChannel('inert', async () => {
		starts++;
		throw new Error('unexpected daemon start');
	}, {
		platform: 'win32',
		loadNative: () => ({
			createStopListener: () => ({ capability: Buffer.alloc(32), close: async () => { closes++; } }),
		}),
		createAppChannel: () => { throw sentinel; },
		observeStartup: (stage, completed) => events.push([stage, completed]),
	}), (error) => error === sentinel);
	assert.deepEqual(events, [[2, true], [3, false]]);
	assert.equal(starts, 0);
	assert.equal(closes, 1);
});

test('stop admission failure never reaches fd3 or daemon startup', async () => {
	const sentinel = new Error('inert stop failure');
	const events: Array<[number, boolean]> = [];
	let channels = 0;
	let starts = 0;
	await assert.rejects(startWithWindowsAppChannel('inert', async () => {
		starts++;
		throw new Error('unexpected daemon start');
	}, {
		platform: 'win32',
		loadNative: () => ({ createStopListener: () => { throw sentinel; } }),
		createAppChannel: () => { channels++; throw new Error('unexpected fd3 adoption'); },
		observeStartup: (stage, completed) => events.push([stage, completed]),
	}), (error: unknown) => error instanceof Error && error.cause === sentinel &&
		error.message === 'Windows stop listener initialization failed: inert stop failure');
	assert.deepEqual(events, [[2, false]]);
	assert.equal(channels, 0);
	assert.equal(starts, 0);
});
