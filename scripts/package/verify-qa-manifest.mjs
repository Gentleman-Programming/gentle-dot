import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateQaManifest(manifest, files, required) {
	const listed = new Set();
	for (const line of manifest.trimEnd().split(/\r?\n/)) {
		if (!line && !manifest.trim()) throw new Error('QA manifest is empty');
		const name = /^[a-f\d]{64} [ *]([^/\\\r\n]+)$/i.exec(line)?.[1];
		if (!name || name === '.' || name === '..') throw new Error('QA manifest has an invalid entry');
		if (listed.has(name)) throw new Error(`QA manifest has a duplicate entry: ${name}`);
		listed.add(name);
	}
	if (required && !listed.has(required)) throw new Error(`QA manifest is missing ${required}`);
	if (listed.size !== files.length || files.some((name) => !listed.has(name))) {
		throw new Error('QA manifest coverage differs from the downloaded files');
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const [, , directory, manifestName, required] = process.argv;
	const entries = readdirSync(directory, { withFileTypes: true });
	if (entries.some((entry) => !entry.isFile())) throw new Error('QA artifact contains a non-file entry');
	const files = entries.map((entry) => entry.name).filter((name) => name !== manifestName);
	validateQaManifest(readFileSync(join(directory, manifestName), 'utf8'), files, required);
}
