// Packaging preflight uses the same inventory and payload rules as staging.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verify } from './runtime-integrity.mjs';

export function validateRuntime(root) {
  let expected;
  try {
    expected = JSON.parse(readFileSync(join(root, 'WINDOWS-INTEGRITY.json'), 'utf8'));
  } catch {
    throw new Error('Missing or invalid WINDOWS-INTEGRITY.json');
  }
  verify(root, expected);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: package-plan.mjs RUNTIME');
    validateRuntime(process.argv[2]);
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
