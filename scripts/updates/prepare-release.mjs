import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { validateManifest } from './release.mjs';

const fail = message => { throw new Error(message); };
const exact = (value, fields) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).sort().join(',') === fields.split(',').sort().join(',');
const HELP = `Prepare an UNSIGNED DRAFT release manifest (Node >=24).
Usage: node scripts/updates/prepare-release.mjs --input FILE
       node scripts/updates/prepare-release.mjs --help
Recipe: {version,artifacts:[{platform,format,file,url}]} (UTF-8 JSON, <=16 KiB).
Relative package paths resolve against the recipe directory; no scans or network.
T1 platforms/formats, canonical explicit release URLs and matching basenames only.
Success: exit 0, JSON only on stdout. Rejection: exit 1, stderr only.
No file writes, keys, signing, publication, verification or installation.
An UNSIGNED DRAFT is not a trusted release. The updater remains disabled.
`;
const stable = (a, b) => a.isFile() && b.isFile() &&
  ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(field => a[field] === b[field]);

// One owned descriptor: inspect before reading, never reopen or retry a failure.
async function readStable(path, consume, maximum, label) {
  let handle;
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) fail(`Cannot read ${label} file`);
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!stable(before, opened)) fail(`Changed ${label} file`);
    const limit = maximum(opened.size);
    const buffer = Buffer.alloc(65536);
    let count = 0;
    while (true) {
      // Read at most one byte beyond the snapshotted size, then fail closed.
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit - count + 1), null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > limit) fail(`Changed ${label} file`);
      consume(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (count !== Number(opened.size) || !stable(opened, after) || !stable(after, named))
      fail(`Changed ${label} file`);
    return count;
  } catch (error) {
    if (error.code) fail(`Cannot read ${label} file`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function prepare(input) {
  const chunks = [];
  await readStable(input, chunk => chunks.push(Buffer.from(chunk)), size => {
    if (size > 16384n) fail('Input file too large');
    return Number(size);
  }, 'input');
  let recipe;
  try { recipe = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { fail('Invalid JSON'); }
  if (!exact(recipe, 'version,artifacts')) fail('Invalid recipe');
  if (!Array.isArray(recipe.artifacts)) fail('Invalid artifacts');
  const artifacts = recipe.artifacts.map(a => {
    if (!exact(a, 'platform,format,file,url') || typeof a.file !== 'string' || !a.file || a.file.includes('\0'))
      fail('Invalid recipe artifact');
    return { platform: a.platform, format: a.format, url: a.url, sha256: '0'.repeat(64), size: 1 };
  });
  const manifest = { schemaVersion: 1, version: recipe.version, artifacts };
  // All metadata, including duplicates, is checked before opening any package.
  validateManifest(manifest);
  const paths = recipe.artifacts.map((a, i) => {
    const path = resolve(dirname(input), a.file);
    if (basename(path) !== decodeURIComponent(new URL(artifacts[i].url).pathname.split('/').at(-1)))
      fail('Artifact filename mismatch');
    return path;
  });
  for (const [i, path] of paths.entries()) {
    const hash = createHash('sha256');
    artifacts[i].size = await readStable(path, chunk => hash.update(chunk), size => {
      // Reuse T1's integrity domain instead of maintaining a second size limit.
      artifacts[i].size = Number(size);
      validateManifest(manifest);
      return artifacts[i].size;
    }, 'artifact');
    artifacts[i].sha256 = hash.digest('hex');
  }
  return validateManifest(manifest);
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(HELP); return; }
  if (args.length !== 2 || args[0] !== '--input' || !args[1] || args[1].startsWith('--'))
    fail('Invalid command or options');
  const manifest = await prepare(resolve(args[1]));
  process.stdout.write(JSON.stringify(manifest) + '\n');
}
if (import.meta.main) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
});
