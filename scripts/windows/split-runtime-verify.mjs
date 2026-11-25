import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { REQUIRED } from './runtime-integrity.mjs';

const USAGE = 'Usage: node scripts/windows/split-runtime-verify.mjs verify ROOT MANIFEST EXPECTED_SHA256';
const MAX_MANIFEST = 16 * 1024 * 1024;
const DEVICE = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9]|lpt[0-9])$/i;
const FORBIDDEN = /^(?:\.env(?:[._-]|$)|\.git(?:-credentials|config)?$|\.(?:ssh|gnupg|aws|azure|kube|docker|config|npmrc|netrc|pypirc|pi|gentle-shell)$|id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-]|$)|(?:credentials?|secrets?|passwords?|tokens?|private[-_]?keys?|auth|account|accounts|audit|users|appdata|profiles?|sessions?)(?:[._-]|$))|\.(?:pem|key|ppk|pfx|p12|kdbx|zip|7z|rar|tar|tgz|gz)$/i;

class Refusal extends Error {}
function requireRule(condition, message) {
  if (!condition) throw new Refusal(message);
}

function isDigest(value) {
  return typeof value === 'string' && value.length === 64 && !/[^0-9a-f]/.test(value);
}

function safeName(name, host = false) {
  return name.length > 0 && (host || name.length <= 120) &&
    !(host ? /[^A-Za-z0-9._@+ -]/ : /[^A-Za-z0-9._@+-]/).test(name) &&
    !/^ |[. ]$/.test(name) && !DEVICE.test(name.split('.')[0].trimEnd()) && !FORBIDDEN.test(name);
}

function localPath(input) {
  // Reject ambiguous spellings before resolve() can normalize them away.
  const windows = process.platform === 'win32';
  const separators = windows ? /[\\/]/ : /\//;
  const bad = 'unsafe input path';
  if (windows) requireRule(!/^[\\/]{2}|^[a-z]:(?![\\/])/i.test(input), bad);
  const names = path => (windows ? path.replace(/^[a-z]:/i, '') : path).split(separators).filter(Boolean);
  requireRule(names(input).every(name => name === '.' || name === '..' || safeName(name, true)), bad);
  const absolute = resolve(input);
  requireRule(absolute !== parse(absolute).root && (!windows || /^[a-z]:\\/i.test(absolute)) &&
    names(absolute).every(name => safeName(name, true)), bad);
  return absolute;
}

function plainDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function singleFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
}

function checkParents(path, message) {
  const parents = [];
  for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) parents.push(parent);
  for (const parent of parents.reverse()) requireRule(plainDirectory(lstatSync(parent)), message);
}

function exactKeys(object, keys) {
  return object !== null && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
}

function admitManifest(raw) {
  let data, text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    data = JSON.parse(text);
  } catch {
    throw new Refusal('manifest is not valid UTF-8 JSON');
  }
  // JSON.parse keeps only the last value for duplicate names. Scan the already
  // validated JSON tokens so the pinned bytes cannot hide an overwritten field.
  const objects = [];
  for (const [token, key] of text.matchAll(/("(?:[^"\\]|\\.)*")(?=\s*:)|"(?:[^"\\]|\\.)*"|[{}]/g)) {
    if (token === '{') objects.push(new Set());
    else if (token === '}') objects.pop();
    else if (key !== undefined) {
      const fields = objects.at(-1);
      const name = JSON.parse(key);
      requireRule(!fields.has(name), 'duplicate manifest field');
      fields.add(name);
    }
  }
  requireRule(exactKeys(data, ['schema', 'target', 'shell', 'pi', 'files']) && data.schema === 1 &&
    data.target === 'windows-x64' && data.shell === '5.0.0' && data.pi === '1.6.0' && Array.isArray(data.files),
  'invalid manifest schema or runtime tuple');

  const folded = new Map();
  const inventory = new Map();
  for (const file of data.files) {
    requireRule(exactKeys(file, ['path', 'type', 'size', 'sha256']) && file.type === 'file' &&
      Number.isSafeInteger(file.size) && file.size >= 0 && isDigest(file.sha256), 'invalid manifest file record');
    requireRule(typeof file.path === 'string' && file.path.length <= 240, 'unsafe manifest path');
    const names = file.path.split('/');
    requireRule(names.every(name => safeName(name)), 'unsafe manifest path');
    let relative = '';
    for (const [index, name] of names.entries()) {
      relative = relative ? `${relative}/${name}` : name;
      const record = index === names.length - 1 ? file : null;
      const key = relative.toLowerCase();
      if (folded.has(key)) {
        requireRule(folded.get(key) === relative && inventory.get(relative) === null && record === null,
          'manifest path collision');
      } else {
        folded.set(key, relative);
        inventory.set(relative, record);
      }
    }
  }
  requireRule(REQUIRED.every(path => inventory.get(path)), 'manifest omits a required runtime file');
  return inventory;
}

function inspectTree(root, inventory) {
  const message = 'staged root is not a plain directory';
  checkParents(root, message);
  requireRule(plainDirectory(lstatSync(root)), message);
  const files = [];
  const directories = [''];
  let seen = 0;
  while (directories.length) {
    const directory = directories.pop();
    for (const name of readdirSync(join(root, directory)).sort()) {
      const relative = directory ? `${directory}/${name}` : name;
      // Check the admitted allowlist before lstat or descent.
      requireRule(inventory.has(relative), 'unexpected staged entry');
      seen++;
      const record = inventory.get(relative);
      const path = join(root, relative);
      const stat = lstatSync(path);
      if (record === null) {
        requireRule(plainDirectory(stat), 'staged entry is not a plain directory');
        directories.push(relative);
      } else {
        requireRule(singleFile(stat), 'staged entry is not a regular single-linked file');
        requireRule(stat.size === record.size, 'staged file size mismatch');
        files.push([path, record]);
      }
    }
  }
  requireRule(seen === inventory.size, 'staged tree is missing an inventory entry');
  return files;
}

async function verify(rootArg, manifestArg, expected) {
  requireRule(isDigest(expected), 'expected SHA-256 must be 64 lowercase hex characters');
  const root = localPath(rootArg);
  const manifest = localPath(manifestArg);
  const foldedRoot = root.toLowerCase();
  const foldedManifest = manifest.toLowerCase();
  requireRule(foldedManifest !== foldedRoot && !foldedManifest.startsWith(foldedRoot + sep),
    'manifest must be outside the staged tree');

  const message = 'manifest path does not name a plain regular single-linked file';
  checkParents(manifest, message);
  const stat = lstatSync(manifest);
  requireRule(singleFile(stat), message);
  requireRule(stat.size <= MAX_MANIFEST, 'manifest exceeds 16 MiB');
  const raw = readFileSync(manifest);
  requireRule(createHash('sha256').update(raw).digest('hex') === expected, 'manifest SHA-256 mismatch');
  const inventory = admitManifest(raw);
  for (const [path, record] of inspectTree(root, inventory)) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    requireRule(hash.digest('hex') === record.sha256, 'staged file SHA-256 mismatch');
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(`${USAGE}\nVerify an exclusively owned staged tree using an independently trusted manifest SHA-256.`);
} else if (args.length === 4 && args[0] === 'verify' && args.slice(1).every(Boolean)) {
  try {
    await verify(...args.slice(1));
    console.log('Windows split runtime verified.');
  } catch (error) {
    // Never echo user-controlled names, manifest contents or filesystem error details.
    const message = error instanceof Refusal ? error.message : 'could not read staged tree or manifest';
    console.error(`Windows split runtime refused: ${message}`);
    process.exitCode = 1;
  }
} else {
  console.error(USAGE);
  process.exitCode = 2;
}
