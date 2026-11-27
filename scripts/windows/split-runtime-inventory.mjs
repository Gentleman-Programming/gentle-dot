import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { REQUIRED } from './split-runtime-files.mjs';

const USAGE = 'Usage: node scripts/windows/split-runtime-inventory.mjs emit ROOT PLAN EXPECTED_PLAN_SHA256';
const MAX_JSON = 16 * 1024 * 1024;
const TUPLE = { schema: 1, target: 'windows-x64', shell: '5.0.0', pi: '1.6.0' };
const WINDOWS = process.platform === 'win32';
// Match the offline verifier's portable member-name policy.
const DEVICE = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9]|lpt[0-9])$/i;
const FORBIDDEN = /^(?:\.env(?:[._-]|$)|\.git(?:-credentials|config)?$|\.(?:ssh|gnupg|aws|azure|kube|docker|config|npmrc|netrc|pypirc|pi|gentle-shell)$|id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-]|$)|(?:credentials?|secrets?|passwords?|tokens?|private[-_]?keys?|auth|account|accounts|audit|users|appdata|profiles?|sessions?)(?:[._-]|$))|\.(?:pem|key|ppk|pfx|p12|kdbx|zip|7z|rar|tar|tgz|gz)$/i;

class Refusal extends Error {}
function requireRule(condition, message) {
  if (!condition) throw new Refusal(message);
}

function safeName(name, host = false) {
  return name.length > 0 && (host || name.length <= 120) &&
    !(host ? /[^A-Za-z0-9._@+ -]/ : /[^A-Za-z0-9._@+-]/).test(name) &&
    !/^ |[. ]$/.test(name) && !DEVICE.test(name.split('.')[0].trimEnd()) && !FORBIDDEN.test(name);
}

function localPath(input) {
  const bad = 'unsafe input path';
  if (WINDOWS) requireRule(!/^[\\/]|^[a-z]:(?![\\/])/i.test(input), bad);
  const names = path => WINDOWS ? path.replace(/^[a-z]:[\\/]/i, '').split(/[\\/]/) : path.replace(/^\//, '').split('/');
  requireRule(names(input).every(name => safeName(name, true)), bad);
  const absolute = resolve(input);
  requireRule((!WINDOWS || /^[a-z]:\\/i.test(absolute)) && names(absolute).every(name => safeName(name, true)), bad);
  return absolute;
}

const plainDirectory = stat => stat.isDirectory() && !stat.isSymbolicLink();
const singleFile = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;

function inspectPath(path, admit, message) {
  const parts = [];
  for (let part = path; part !== parse(part).root; part = dirname(part)) parts.push(part);
  for (const part of parts.reverse()) {
    const stat = lstatSync(part);
    requireRule((part === path ? admit : plainDirectory)(stat), message);
    const canonical = realpathSync.native(part);
    requireRule(WINDOWS ? canonical.toLowerCase() === part.toLowerCase() : canonical === part, 'unsafe input path');
    if (part === path) return stat;
  }
}

function parsePlan(raw) {
  let data, text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    data = JSON.parse(text);
  } catch {
    throw new Refusal('plan is not valid UTF-8 JSON');
  }
  // Inspect validated tokens before accepting JSON.parse's last-value semantics.
  const objects = [];
  for (const [token, key] of text.matchAll(/("(?:[^"\\]|\\.)*")(?=\s*:)|"(?:[^"\\]|\\.)*"|[{}]/g)) {
    if (token === '{') objects.push(new Set());
    else if (token === '}') objects.pop();
    else if (key !== undefined) {
      const fields = objects.at(-1);
      const name = JSON.parse(key);
      requireRule(!fields.has(name), 'duplicate plan field');
      fields.add(name);
    }
  }
  requireRule(data && typeof data === 'object' && Object.keys(data).length === 5 && Array.isArray(data.files) &&
    Object.entries(TUPLE).every(([key, value]) => Object.hasOwn(data, key) && data[key] === value),
  'invalid plan schema or runtime tuple');
  return data.files;
}

function admitLayout(paths) {
  const expected = new Map();
  const folded = new Map();
  for (const path of paths) {
    requireRule(typeof path === 'string' && path.length <= 240, 'unsafe plan path');
    const names = path.split('/');
    requireRule(names.every(name => safeName(name)), 'unsafe plan path');
    let relative = '';
    for (const [index, name] of names.entries()) {
      relative = relative ? `${relative}/${name}` : name;
      const file = index === names.length - 1;
      const key = relative.toLowerCase();
      if (folded.has(key)) {
        requireRule(folded.get(key) === relative && !expected.get(relative) && !file, 'plan path collision');
      } else {
        folded.set(key, relative);
        expected.set(relative, file);
      }
    }
  }
  requireRule(REQUIRED.every(path => expected.get(path)), 'plan omits a required runtime file');
  return expected;
}

function inspectTree(root, expected) {
  inspectPath(root, plainDirectory, 'runtime root is not a plain directory');
  const directories = [''];
  const sizes = new Map();
  let seen = 0;
  while (directories.length) {
    const directory = directories.pop();
    for (const name of readdirSync(join(root, directory)).sort()) {
      const relative = directory ? `${directory}/${name}` : name;
      // Only exact, pre-admitted names may be statted or traversed.
      requireRule(expected.has(relative), 'unexpected runtime entry');
      seen++;
      const stat = lstatSync(join(root, relative));
      if (expected.get(relative)) {
        requireRule(singleFile(stat), 'runtime entry is not a regular single-linked file');
        requireRule(Number.isSafeInteger(stat.size) && stat.size >= 0, 'runtime file size is out of range');
        sizes.set(relative, stat.size);
      } else {
        requireRule(plainDirectory(stat), 'runtime entry is not a plain directory');
        directories.push(relative);
      }
    }
  }
  requireRule(seen === expected.size, 'runtime tree is missing a plan entry');
  return sizes;
}

async function emit(rootArg, planArg, digest) {
  requireRule(digest.length === 64 && !/[^0-9a-f]/.test(digest), 'expected plan SHA-256 must be 64 lowercase hex characters');
  const root = localPath(rootArg);
  const plan = localPath(planArg);
  requireRule(plan.toLowerCase() !== root.toLowerCase() && !plan.toLowerCase().startsWith(root.toLowerCase() + sep),
    'plan must be outside the runtime tree');
  const stat = inspectPath(plan, singleFile, 'plan path is not a plain regular single-linked file');
  requireRule(stat.size <= MAX_JSON, 'plan exceeds 16 MiB');
  const raw = readFileSync(plan);
  requireRule(raw.length <= MAX_JSON, 'plan exceeds 16 MiB');
  requireRule(createHash('sha256').update(raw).digest('hex') === digest, 'plan SHA-256 mismatch');
  const sizes = inspectTree(root, admitLayout(parsePlan(raw)));

  const files = [];
  for (const path of [...sizes.keys()].sort()) {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(join(root, path))) {
      size += chunk.length;
      hash.update(chunk);
    }
    requireRule(size === sizes.get(path), 'runtime file size changed while reading');
    files.push({ path, type: 'file', size, sha256: hash.digest('hex') });
  }
  const manifest = JSON.stringify({ ...TUPLE, files }) + '\n';
  requireRule(Buffer.byteLength(manifest) <= MAX_JSON, 'inventory exceeds 16 MiB');
  process.stdout.write(manifest);
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(`${USAGE}\nEmit an inventory from an exclusively owned runtime tree and an independently pinned layout plan.`);
} else if (args.length === 4 && args[0] === 'emit' && args.slice(1).every(Boolean)) {
  try {
    await emit(...args.slice(1));
  } catch (error) {
    const message = error instanceof Refusal ? error.message : 'could not read runtime tree or plan';
    console.error(`Windows split runtime inventory refused: ${message}`);
    process.exitCode = 1;
  }
} else {
  console.error(USAGE);
  process.exitCode = 2;
}
