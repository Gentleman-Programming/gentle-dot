import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = new URL('../../../packages/daemon/', import.meta.url);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const sourceUrl = (name) => new URL(`src/${name}.ts`, pkg);
// Pin normalized sources as well as anchors: even a change outside an anchor needs review.
const pins = Object.freeze({
  cli: 'efb6fa8c12775f5974ef0e13d168f7f1b86d9d9fe0f99dccbd7bef6ca33a0dc3',
  'windows-stop': '7b8934089a83f6231e0838ba1e451df53774cd86aaebcc2b721c2e32766a086c',
  daemon: '123a806a3722da529c1905e94df684789eb5322982058e186d8efe76170a8c8d',
  'runtime-build': 'd033a2d578182c6b74497356dc95c3ca193267079cda991adec89d972ea05008',
});

export const phases = Object.freeze([
  'entry', 'config-start', 'config-ready', 'stop-start', 'stop-refused', 'stop-ready',
  'fd3-start', 'fd3-refused', 'fd3-ready', 'daemon-start', 'channel-refused',
  'preview-memory-start', 'preview-memory-refused', 'preview-memory-ready', 'claim-start',
  'claim-refused', 'claim-ready', 'providers-ready', 'token-ready', 'workspace-ready',
  'memory-ready', 'http-bind', 'http-refused', 'http-listening', 'startup-failed',
]);

// Serialized verbatim into the diagnostic bundle; no build-time environment is captured.
export function makePhaseTrace(env, platform, createSocket) {
  const rawPort = env.GENTLE_DOT_CI_TRACE_PORT;
  const id = env.GENTLE_DOT_CI_TRACE_ID;
  const port = Number(rawPort);
  if (platform !== 'win32' || env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' ||
      !Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== rawPort ||
      id?.length !== 32 || !/^[a-f0-9]{32}$/.test(id)) return () => {};
  let socket, last = -1, terminal = false;
  return (phase) => {
    const rank = phases.indexOf(phase);
    if (terminal || rank <= last) return;
    last = rank;
    terminal = phase.endsWith('-refused') || phase === 'startup-failed';
    try {
      if (!socket) {
        const udp = createSocket('udp4');
        udp.on('error', () => {});
        udp.unref();
        udp.bind({ address: '127.0.0.1', port: 0, exclusive: true });
        socket = udp;
      }
      socket.send(`${id} ${phase}`, port, '127.0.0.1');
    } catch { /* A missing marker is not a startup failure. */ }
  };
}

function pinned(name, source) {
  const text = source.replaceAll('\r\n', '\n');
  if (createHash('sha256').update(text).digest('hex') !== pins[name]) throw new Error('source-drift');
  return text;
}

export function instrumentSource(name, source) {
  let text = pinned(name, source);
  const replace = (anchor, replacement) => {
    const parts = text.split(anchor);
    if (parts.length !== 2) throw new Error('anchor-drift');
    text = parts.join(replacement);
  };
  const mark = (phase) => `__ciStartupPhase(${JSON.stringify(phase)});`;
  const before = (anchor, phase) => replace(anchor, `${mark(phase)}\n${anchor}`);
  const after = (anchor, phase) => replace(anchor, `${anchor}\n${mark(phase)}`);
  const refuse = (anchor, phase) => replace(anchor, `{ ${mark(phase)} ${anchor} }`);
  switch (name) {
    case 'cli': {
      const entry = 'if (process.argv.includes("--auth-helper")) serveAuthHelper();';
      replace(entry, `delete process.env.GENTLE_DOT_CI_TRACE_PORT;\ndelete process.env.GENTLE_DOT_CI_TRACE_ID;\n${mark('entry')}\n${entry}`);
      const config = 'async function main(): Promise<void> {\n\tconst config = loadConfig();';
      replace(config, config.replace('\n', `\n${mark('config-start')}\n`) + `\n${mark('config-ready')}`);
      after('main().catch((error: Error) => {', 'startup-failed');
      break;
    }
    case 'windows-stop': {
      before('\t\tconst native = (', 'stop-start');
      after('\t\tcapability = Buffer.from(listener.capability);\n\t} catch (error) {', 'stop-refused');
      before('\tfor (const frame of preinitFrames) handler.onRequest(frame);', 'stop-ready');
      const channel = '\t\t\tconst channel = options.createAppChannel\n\t\t\t\t? options.createAppChannel()\n\t\t\t\t: (new WindowsAppChannel({ exclusiveFd3Startup: true }) as unknown as C);';
      replace(channel, `${mark('fd3-start')}\nlet channel: C;\ntry {\n${channel.replace('const channel', 'channel')}\n} catch (error) {\n${mark('fd3-refused')}\nthrow error;\n}\n${mark('fd3-ready')}`);
      break;
    }
    case 'daemon': {
      after('export async function startDaemon(options: DaemonOptions): Promise<DotDaemon> {', 'daemon-start');
      refuse('throw new Error("Windows app channel requires validated production ownership before startup");', 'channel-refused');
      after('if (base.GENTLE_DOT_PREVIEW_MEMORY_ADMISSION === "1") {', 'preview-memory-start');
      refuse('throw new Error("Cannot start preview memory: private mode and engine home are required");', 'preview-memory-refused');
      after('preview = { env, memory: await privateMemory(env, options.dataDir, log, access) };', 'preview-memory-ready');
      before('const claimDirs = daemonClaimDirs(options.dataDir, options.agentHome);', 'claim-start');
      refuse('throw new Error(daemonClaimMessage(claim));', 'claim-refused');
      after('if (claim.status !== "claimed") { __ciStartupPhase("claim-refused"); throw new Error(daemonClaimMessage(claim)); }', 'claim-ready');
      after('const preparedComputer = await resolveComputerProviders({ components });', 'providers-ready');
      after('const token = ensureToken(options.dataDir);', 'token-ready');
      after('ensureMemoryProject(options.workspace, access);', 'workspace-ready');
      after(': options.agentHome ? await privateMemory(agentEnv, options.dataDir, log, access) : undefined;', 'memory-ready');
      before('await new Promise<void>((done, fail) => {\n\t\tserver.once("error", fail);', 'http-bind');
      replace('server.once("error", fail);', `server.once("error", (error) => { ${mark('http-refused')} fail(error); });`);
      before('port = (server.address() as AddressInfo).port;', 'http-listening');
      break;
    }
    default: throw new Error('source-drift');
  }
  const traceImport = 'import { trace as __ciStartupPhase } from "gentle-dot-ci-startup-phase";\n';
  return name === 'cli' ? text.replace('#!/usr/bin/env node\n', `#!/usr/bin/env node\n${traceImport}`) : traceImport + text;
}

function scratchDir(arg) {
  try {
    if (!isAbsolute(arg) || resolve(arg) !== arg || !/^gentle-dot-startup-trace-[a-f0-9]{32}$/.test(basename(arg)))
      throw new Error();
    const temp = realpathSync(tmpdir());
    const parent = realpathSync(dirname(arg));
    const fromRepo = relative(realpathSync(repo), temp);
    const outsideRepo = isAbsolute(fromRepo) || fromRepo === '..' || fromRepo.startsWith(`..${sep}`);
    if (parent !== temp || !outsideRepo) throw new Error();
    const out = join(temp, basename(arg));
    try { lstatSync(out); } catch (error) { if (error.code === 'ENOENT') return out; }
  } catch { /* Fixed refusal below, without path/error details. */ }
  throw new Error('scratch-refused');
}

export async function buildDiagnosticBundle(arg, testBuild) {
  const out = scratchDir(arg);
  const outfile = join(out, 'startup-phase-cli.mjs');
  const names = ['cli', 'windows-stop', 'daemon'];
  const transformed = new Map(names.map((name) => [name, instrumentSource(name, readFileSync(sourceUrl(name), 'utf8'))]));
  pinned('runtime-build', readFileSync(sourceUrl('runtime-build'), 'utf8'));
  const { lockedDependencies } = await import(sourceUrl('runtime-build').href);
  const options = {
    entryPoints: [fileURLToPath(sourceUrl('cli'))], outfile,
    bundle: true, platform: 'node', format: 'esm', target: 'node24',
    external: Object.keys(lockedDependencies()), logLevel: 'silent',
    // Diagnostic deltas: suppress raw errors, keep output in memory, and overlay pinned inputs.
    write: false,
    plugins: [{ name: 'startup-phase', setup(builder) {
      builder.onResolve({ filter: /^gentle-dot-ci-startup-phase$/ }, () => ({ path: 'trace', namespace: 'startup-phase' }));
      builder.onLoad({ filter: /^trace$/, namespace: 'startup-phase' }, () => ({ contents: `
        import { createSocket } from 'node:dgram';
        const phases = ${JSON.stringify(phases)};
        export const trace = (${makePhaseTrace})(process.env, process.platform, createSocket);
      ` }));
      builder.onLoad({ filter: /[\\/](cli|windows-stop|daemon)\.ts$/, namespace: 'file' }, ({ path }) => {
        const name = basename(path, '.ts');
        if (relative(fileURLToPath(sourceUrl(name)), path) !== '') return;
        return { contents: transformed.get(name), loader: 'ts', resolveDir: dirname(path) };
      });
    } }],
  };
  let result;
  try {
    const build = testBuild ?? createRequire(new URL('package.json', pkg))('esbuild').build;
    result = await build(options);
  } catch { throw new Error('build-failed'); }
  if (result.outputFiles.length !== 1 || result.outputFiles[0].path !== outfile) throw new Error('build-failed');
  try {
    mkdirSync(out);
    writeFileSync(outfile, result.outputFiles[0].contents, { flag: 'wx' });
  } catch { throw new Error('scratch-refused'); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [option, arg, ...rest] = process.argv.slice(2);
  if (option !== '--out-dir' || !arg || rest.length) {
    process.stderr.write('usage: startup-phase-bundle.mjs --out-dir <new absolute trace scratch directory>\n');
    process.exitCode = 2;
  } else {
    try {
      await buildDiagnosticBundle(arg);
      process.stdout.write('STARTUP_PHASE_BUNDLE: ok\n');
    } catch (error) {
      const category = ['scratch-refused', 'source-drift', 'anchor-drift'].includes(error.message) ? error.message : 'build-failed';
      process.stderr.write(`STARTUP_PHASE_BUNDLE: ${category}\n`);
      process.exitCode = 1;
    }
  }
}
