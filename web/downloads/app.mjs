import { loadRelease } from './releases.mjs';
const $ = id => document.getElementById(id);
const labels = { windows:'Windows', macos:'macOS', linux:'Linux' };
const help = {
 windows:'Open the downloaded setup executable and review the Windows prompts. Check the release notes and publisher before allowing installation.',
 macos:'Open the downloaded DMG, then follow its installation instructions. Check the release notes for signing and notarization information.',
 linux:'Open the Debian package with your package manager and review its prompts. These downloads are for Debian/Ubuntu-compatible systems.',
};
function detectPlatform(userAgent) {
 if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return null;
 if (/Windows/i.test(userAgent)) return 'windows';
 if (/Macintosh|Mac OS/i.test(userAgent)) return 'macos';
 if (/Linux/i.test(userAgent)) return 'linux';
 return null;
}
function detectArchitecture(userAgent, platform) {
 if (!platform || platform === 'macos') return '';
 if (/\b(?:aarch64|arm64)\b/i.test(userAgent)) return 'arm64';
 if (/\b(?:x64|x86_64|amd64)\b/i.test(userAgent)) return 'x64';
 return '';
}
const userAgent = navigator.userAgent;
let platform = detectPlatform(userAgent);
const processor = $('architecture');
processor.value = detectArchitecture(userAgent, platform);
const installHelp = $('install-help');
const defaultHelp = installHelp.textContent;
const releaseLink = $('release-link');
const officialReleases = releaseLink.href;
const status = $('status');
let catalog = { state:'loading', downloads:{} };
let pending = false;
function statusText(item, architecture) {
 if (catalog.state === 'loading') return 'Checking the latest public release…';
 if (catalog.state === 'error') return 'We couldn’t check for installers. Try again or visit the official releases page.';
 if (!platform || !architecture) return 'Choose your system and processor to see the installer.';
 if (catalog.state !== 'ready') return 'No installer has been published yet. Check the official releases page for updates.';
 if (!item) return `This release has no installer for ${labels[platform]} ${architecture}. Try another build or read the release notes.`;
 return 'Available from the official release. Read the release notes before installing.';
}
function render() {
 document.querySelectorAll('[data-platform]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.platform === platform)));
 const architecture = processor.value;
 const item = catalog.state === 'ready' && platform && architecture && catalog.downloads[`${platform}-${architecture}`];
 processor.querySelector('[value="x64"]').textContent = platform === 'macos' ? 'Intel Mac · x64' : 'Intel / AMD · x64';
 processor.querySelector('[value="arm64"]').textContent = platform === 'macos' ? 'Apple silicon · arm64' : 'ARM · arm64';
 $('downloads').dataset.state = catalog.state;
 $('version').textContent = catalog.version || 'Public releases';
 $('retry').setAttribute('aria-disabled', String(pending));
 installHelp.textContent = help[platform] || defaultHelp;
 const download = $('download');
 const assetDetail = $('asset-detail');
 download.hidden = assetDetail.hidden = !item;
 if (item) {
  download.href = item.url;
  download.textContent = `Download for ${labels[platform]} ↓`;
  download.setAttribute('aria-label', `Download Gentle Dot for ${labels[platform]} ${architecture}`);
  assetDetail.textContent = `${item.name} · ${(item.sizeBytes / 1024 / 1024).toFixed(1)} MB`;
 } else {
  download.removeAttribute('href');
  assetDetail.textContent = '';
 }
 const message = statusText(item, architecture);
 if (status.textContent !== message) status.textContent = message;
 releaseLink.href = catalog.releaseUrl || officialReleases;
}
async function refresh() {
 if (pending) return;
 pending = true; catalog = { state:'loading', downloads:{} }; render();
 catalog = await loadRelease(); pending = false; render();
}
document.querySelectorAll('[data-platform]').forEach(button => button.addEventListener('click', () => { platform = button.dataset.platform; render(); }));
processor.addEventListener('change', render);
$('retry').addEventListener('click', refresh);
refresh();
