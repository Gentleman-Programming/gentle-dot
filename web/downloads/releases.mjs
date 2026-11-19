export const REPOSITORY = 'Gentleman-Programming/gentle-dot';
export const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
export const SOURCE_URL = `https://github.com/${REPOSITORY}`;
const empty = (state = 'unavailable') => ({ state, version: '', downloads: {}, releaseUrl: '' });

function officialUrl(value, path) {
 try {
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === path ? url.href : null;
 } catch { return null; }
}
function targetOf(name) {
 if (typeof name !== 'string' || /(?:^|[-_. ])(?:qa|nightly|preview)(?:[-_. ]|$)/i.test(name)) return null;
 const platform = /-setup\.exe$/i.test(name) ? 'windows' : /\.dmg$/i.test(name) ? 'macos' : /\.deb$/i.test(name) ? 'linux' : null;
 const x64 = /(?:^|[-_. ])(?:x64|x86_64|amd64)(?:[-_. ]|$)/i.test(name);
 const arm = /(?:^|[-_. ])(?:arm64|aarch64)(?:[-_. ]|$)/i.test(name);
 return platform && x64 !== arm ? `${platform}-${arm ? 'arm64' : 'x64'}` : null;
}

/** Accept only actual stable public release assets, never construct an executable URL. */
export function releaseCatalog(release) {
 if (!release || release.draft !== false || release.prerelease !== false || !/^[a-z\d][a-z\d._-]{0,79}$/i.test(release.tag_name ?? '') || !Array.isArray(release.assets) || release.assets.length > 500) return empty();
 const version = release.tag_name;
 const releaseUrl = officialUrl(release.html_url, `/${REPOSITORY}/releases/tag/${encodeURIComponent(version)}`);
 if (!releaseUrl || /(?:^|[-_.])(?:qa|nightly|preview)(?:[-_.]|$)/i.test(version)) return empty();
 const downloads = {}, ambiguous = new Set();
 for (const asset of release.assets) {
  if (!asset || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0) continue;
  const target = targetOf(asset.name);
  if (!target) continue;
  const url = officialUrl(asset.browser_download_url, `/${REPOSITORY}/releases/download/${encodeURIComponent(version)}/${encodeURIComponent(asset.name)}`);
  if (!url) continue;
  if (downloads[target]) ambiguous.add(target);
  downloads[target] = { name: asset.name, url, sizeBytes: asset.size };
 }
 for (const target of ambiguous) delete downloads[target];
 return Object.keys(downloads).length ? { state: 'ready', version, downloads, releaseUrl } : empty();
}

export async function loadRelease(fetcher = globalThis.fetch) {
 try {
  const response = await fetcher(RELEASE_API, {
   headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', redirect: 'error',
   referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return empty();
  if (!response.ok) return empty('error');
  return releaseCatalog(await response.json());
 } catch { return empty('error'); }
}
