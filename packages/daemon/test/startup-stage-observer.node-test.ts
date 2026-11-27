import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { join, win32 } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { admitPreviewMemory, privateMemory } from '../src/isolation.ts';
import { startupStageDefines } from '../src/runtime-build.ts';
import { consumeStartupStageEndpoint, type PrivateMemoryFailure, startupStageMarker } from '../src/startup-stage-observer.ts';
import { startWithWindowsAppChannel } from '../src/windows-stop.ts';

const id = '0123456789abcdef0123456789abcdef';
const selector = { GENTLE_DOT_CI_DAEMON_PHASE_PORT: '43194', GENTLE_DOT_CI_DAEMON_PHASE_ID: id };
const previewMemory = { GENTLE_DOT_ENGRAM: 'private', GENTLE_DOT_PREVIEW_MEMORY_ADMISSION: '1' };
const refusal = 'Cannot start preview memory: listener ownership is unverified';
const invalidPort = 'Cannot start private memory: port must be an integer from 1 to 65535';
const result = (stdout = '', code = 0, stderr = '') => ({ code, stdout, stderr });
const one = result('42');
const other = result('43');
const ambiguous = result('42\r\n43');
const stderr = result('42', 0, 'inert stderr');
const parse = result('inert invalid data');
const rejected = new Error('inert rejection');
const unexpected = () => assert.fail('unexpected memory effect');

for (const [reason, queue, message, reads, healthReads, instance, healthId] of [
	['invalid-port', [], invalidPort, 0, 0, 'owned', 'owned'],
	['query-spawn', [rejected], refusal, 0, 0, 'owned', 'owned'],
	['query-nonzero', [result('42', 1, 'inert')], refusal, 0, 0, 'owned', 'owned'],
	['query-stderr', [stderr], refusal, 0, 0, 'owned', 'owned'],
	['query-parse', [parse], refusal, 0, 0, 'owned', 'owned'],
	['multiple-listeners', [ambiguous], refusal, 0, 0, 'owned', 'owned'],
	['identity-missing', [one], refusal, 1, 0, undefined, 'owned'],
	['identity-missing', [one], refusal, 1, 1, 'owned', undefined],
	['identity-mismatch', [one], refusal, 1, 1, 'owned', 'other'],
	['recheck-changed', [one, other], refusal, 1, 1, 'owned', 'owned'],
	['recheck-changed', [one, result()], refusal, 1, 1, 'owned', 'owned'],
	['recheck-unverified', [one, ambiguous], refusal, 1, 1, 'owned', 'owned'],
	['recheck-unverified', [one, stderr], refusal, 1, 1, 'owned', 'owned'],
] as const) {
	test(`preview ${reason} preserves rejection, lookup and side effects with or without projection`, async () => {
		for (const observe of [false, true]) {
			const reasons: string[] = [], logs: string[] = [];
			let queries = 0, actualReads = 0, actualHealth = 0, kills = 0;
			const env = reason === 'invalid-port' ? { ...previewMemory, GENTLE_DOT_ENGRAM_PORT: '65536' } : previewMemory;
			await assert.rejects(privateMemory(env, 'inert', line => logs.push(line), <T>() => {
				actualReads++;
				if (!instance) throw rejected;
				return instance as T;
			}, {
				platform: 'win32',
				runListenerCommand: async () => {
					const response = queue[queries++];
					if (response instanceof Error) throw response;
					assert.ok(response);
					return response;
				},
				health: async () => { actualHealth++; return { instance_id: healthId }; },
				kill: () => { kills++; },
				...(observe ? { onFailure: (value: string) => reasons.push(value) } : {}),
			}), { name: 'Error', message });
			assert.deepEqual([queries, actualReads, actualHealth, kills, logs, reasons], [queue.length, reads, healthReads, 0, [], observe ? [reason] : []]);
		}
	});
}

for (const [reason, mode, home, badConfig] of [
	['config-reread', 'private', 'inert', true],
	['preview-prerequisites', 'private', undefined, false],
	['preview-prerequisites', 'shared', 'inert', false],
] as const) {
	test(`preview admission ${reason} (${mode}, home=${Boolean(home)}) preserves its original failure`, async () => {
		const original = { existsSync: fs.existsSync, readFileSync: fs.readFileSync };
		const path = join('inert', 'config.json');
		let reads = 0;
		fs.existsSync = (input) => { assert.equal(input, path); return badConfig; };
		fs.readFileSync = ((input: unknown) => { assert.equal(input, path); reads++; throw rejected; }) as typeof fs.readFileSync;
		syncBuiltinESMExports();
		try {
			for (const observe of [false, true]) {
				const reasons: string[] = [];
				reads = 0;
				await assert.rejects(admitPreviewMemory({ ...previewMemory, GENTLE_DOT_ENGRAM: mode }, 'inert', home,
					unexpected, unexpected, { runListenerCommand: unexpected, kill: unexpected, health: unexpected,
						...(observe ? { onFailure: (value: string) => reasons.push(value) } : {}),
					}), { name: 'Error', message: badConfig ? `Invalid ${path}: inert rejection` : 'Cannot start preview memory: private mode and engine home are required' });
				assert.deepEqual([reads, reasons], [Number(badConfig), observe ? [reason] : []]);
			}
		} finally {
			Object.assign(fs, original);
			syncBuiltinESMExports();
		}
	});
}

test('Windows queries CIM for only owning PIDs at the validated port and accepts successful zero rows', async () => {
	const original = childProcess.execFile;
	const calls: unknown[] = [];
	childProcess.execFile = ((command: string, args: string[], options: object,
		callback: (error: null, stdout: string, stderr: string) => void) => {
		calls.push([command, args, options]);
		callback(null, '', '');
	}) as unknown as typeof original;
	syncBuiltinESMExports();
	try {
		for (const [port, numeric] of [['00001', 1], ['65535', 65535]] as const) {
			const handle = await privateMemory({ ...previewMemory, GENTLE_DOT_ENGRAM_PORT: port }, 'inert', unexpected, unexpected, {
				platform: 'win32', onFailure: unexpected, kill: unexpected, health: unexpected,
			});
			assert.ok(handle);
			assert.deepEqual(calls.splice(0), [[
				win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
				['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
					`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; try { Get-CimInstance -Namespace root/StandardCimv2 -Query 'SELECT OwningProcess FROM MSFT_NetTCPConnection WHERE LocalPort = ${numeric} AND State = 2' -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`],
				{ encoding: 'utf8', timeout: 15_000, windowsHide: true },
			]]);
		}
	} finally {
		childProcess.execFile = original;
		syncBuiltinESMExports();
	}
});

test('actual execFile callback distinguishes timeout, spawn, and nonzero without executing a command', async () => {
	const original = childProcess.execFile;
	try {
		for (const [error, expected] of [
			[{ killed: true, signal: 'SIGTERM', code: null }, 'query-timeout'],
			[{ killed: false, code: 'ENOENT' }, 'query-spawn'],
			[{ killed: false, code: 7 }, 'query-nonzero'],
			[{ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'query-spawn'],
		] as const) {
			let runs = 0;
			childProcess.execFile = ((command: string, _args: string[], options: { timeout: number },
				callback: (error: object, stdout: string, stderr: string) => void) => {
				runs++;
				assert.match(command, /\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
				assert.equal(options.timeout, 15_000);
				// Even a nonzero result with no rows or diagnostics is not an empty lookup.
				callback(error, '', expected === 'query-nonzero' ? '' : 'inert stderr');
			}) as unknown as typeof original;
			syncBuiltinESMExports();
			const reasons: string[] = [];
			await assert.rejects(privateMemory(previewMemory, 'inert', unexpected, unexpected, {
				platform: 'win32', onFailure: value => reasons.push(value), kill: unexpected, health: unexpected,
			}), { name: 'Error', message: refusal });
			assert.deepEqual([runs, reasons], [1, [expected]]);
		}
	} finally {
		childProcess.execFile = original;
		syncBuiltinESMExports();
	}
});

test('only classified stage four failures get a fixed status byte', () => {
	const reasons = ['config-reread','preview-prerequisites','invalid-port','query-spawn','query-timeout','query-nonzero',
		'query-stderr','query-parse','multiple-listeners','identity-missing','identity-mismatch','recheck-changed','recheck-unverified'] as const;
	for (const [i, reason] of reasons.entries()) {
		assert.equal(startupStageMarker(4, false, reason), 'ABCDEFGHIJKLM'[i]);
		assert.equal(startupStageMarker(3, false, reason), '-');
		assert.equal(startupStageMarker(4, true, reason), '+');
	}
	for (const untrusted of [undefined, '', 'A', 'identity-missing\n', 'constructor', 'toString', '__proto__', 1, {}])
		assert.equal(startupStageMarker(4, false, untrusted as PrivateMemoryFailure), '-');
});

test('confirmed empty or stable owned memory admits without a diagnostic failure', async () => {
	for (const queue of [[result()], [one, one]]) {
		let query = 0, identity = 0, health = 0;
		const memory = await privateMemory(previewMemory, 'inert', unexpected, <T>() => {
			identity++;
			return 'owned' as T;
		}, {
			platform: 'win32',
			runListenerCommand: async () => { const response = queue[query++]; assert.ok(response); return response; },
			health: async () => { health++; return { instance_id: 'owned' }; },
			kill: unexpected, onFailure: unexpected,
		});
		const owned = queue.length === 2;
		assert.deepEqual([Boolean(memory), query, identity, health], [!owned, queue.length, Number(owned), Number(owned)]);
	}
});

test('ordinary shared/private bootstrap and cleanup preserve their exact decisions and logs', async () => {
	const privateEnv = { GENTLE_DOT_ENGRAM: 'private' };
	for (const [env, platform, queue, claimed, logs, kills] of [
		[{}, 'win32', [], false, [], []],
		[privateEnv, 'win32', [stderr], false, ['cannot verify private memory listener on port 7438 (failed lookup); will not stop it'], []],
		[privateEnv, 'win32', [ambiguous], false, ['cannot verify private memory listener on port 7438 (ambiguous lookup); will not stop it'], []],
		[privateEnv, 'linux', [result('', 1), one, one], true, ['stopped the private memory server (pid 42)'], [[42, 'SIGTERM']]],
		[privateEnv, 'win32', [result(), one, other], true, ['the private memory listener changed on port 7438; left running'], []],
	] as const) {
		const actualLogs: string[] = [];
		const actualKills: Array<[number, string]> = [];
		let queries = 0;
		const handle = await privateMemory(env, 'inert', line => actualLogs.push(line), <T>() => 'owned' as T, {
			platform,
			runListenerCommand: async () => { const next = queue[queries++]; assert.ok(next); return next; },
			health: async () => ({ instance_id: 'owned' }),
			kill: (pid, signal) => { actualKills.push([pid, signal]); },
		});
		await handle?.stop();
		assert.deepEqual([Boolean(handle), queries, actualLogs, actualKills], [claimed, queue.length, logs, kills]);
	}
	await assert.rejects(privateMemory({ ...privateEnv, GENTLE_DOT_ENGRAM_PORT: '0' }, 'inert', unexpected, unexpected, {
		runListenerCommand: unexpected, health: unexpected, kill: unexpected,
	}), { name: 'Error', message: invalidPort });
});

test('runtime selector is consumed even if invalid; no partial endpoint', () => {
	for (const port of ['43194', '043194', '43195', '43194\n']) {
		for (const nonce of [id, id.toUpperCase(), `${id}\n`, '']) {
			const env = { ...selector, KEEP: 'value', GENTLE_DOT_CI_DAEMON_PHASE_PORT: port, GENTLE_DOT_CI_DAEMON_PHASE_ID: nonce };
			assert.equal(consumeStartupStageEndpoint(env), port === '43194' && nonce === id ? id : undefined);
			assert.deepEqual(env, { KEEP: 'value' });
		}
	}
});

const phaseBranch = 'refs/heads/qa/windows-private-memory-reasons-45201908966';
const phaseWorkflowRef = (ref: string) => `Gentleman-Programming/gentle-dot/.github/workflows/windows-staged-daemon-phases-44794993333.yml@${ref}`;
const phaseCompileContext = (branch: string) => ({
	GENTLE_DOT_CI_DAEMON_PHASE_BUILD: '1', CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
	RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'observe',
	GITHUB_REPOSITORY: 'Gentleman-Programming/gentle-dot', GITHUB_EVENT_NAME: 'push', GITHUB_REF: branch,
	GITHUB_WORKFLOW: 'Windows staged daemon phases 44794993333', GITHUB_WORKFLOW_REF: phaseWorkflowRef(branch),
});

const phaseOff = { __GENTLE_DOT_DAEMON_PHASES__: 'false' };

test('esbuild enables phases for the fresh exact hosted ref', () => {
	assert.deepEqual(startupStageDefines('win32', 'x64', phaseCompileContext(phaseBranch)), { __GENTLE_DOT_DAEMON_PHASES__: 'true' });
});

for (const ref of ['refs/heads/qa/windows-staged-daemon-phases-44794993333', 'refs/heads/main']) {
	test(`esbuild refuses phase compilation for ${ref}`, () => {
		assert.deepEqual(startupStageDefines('win32', 'x64', phaseCompileContext(ref)), phaseOff);
	});
}

test('esbuild retains the default-off platform and hosted identity checks', () => {
	const context = phaseCompileContext(phaseBranch);
	const off = phaseOff;
	assert.deepEqual(startupStageDefines('win32', 'x64', selector), off);
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
