import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function renderQaLauncher(template, repository, digest) {
	if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(repository)) {
		throw new Error('Expected a GitHub owner/repository');
	}
	if (!/^[a-f\d]{64}$/i.test(digest)) {
		throw new Error('Expected a SHA-256 digest');
	}
	const values = { __QA_REPOSITORY__: repository, __QA_WINDOWS_SHA256__: digest.toLowerCase() };
	for (const [placeholder, value] of Object.entries(values)) {
		if (template.split(placeholder).length !== 2) {
			throw new Error(`Expected exactly one ${placeholder} placeholder`);
		}
		template = template.replace(placeholder, value);
	}
	return template.replace(/\r?\n/g, '\r\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const template = readFileSync(new URL('../windows/preview/Gentle-Dot-QA.cmd', import.meta.url), 'utf8');
	process.stdout.write(renderQaLauncher(template, process.argv[2], process.argv[3]));
}
