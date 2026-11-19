import { loadRelease } from './releases.mjs';
const $ = id => document.getElementById(id);
const labels = { windows:'Windows', macos:'macOS', linux:'Linux' };
const help = {
 windows:'Open the downloaded setup executable and review the Windows prompts. Check the release notes and publisher before allowing installation.',
 macos:'Open the downloaded DMG, then follow its installation instructions. Check the release notes for signing and notarization information.',
 linux:'Open the Debian package with your package manager and review its prompts. These downloads are for Debian/Ubuntu-compatible systems.',
};
const userAgent = navigator.userAgent;
let platform = /Windows/i.test(userAgent) ? 'windows' : /Macintosh|Mac OS/i.test(userAgent) ? 'macos' : /Linux/i.test(userAgent) ? 'linux' : 'windows';
let architecture = /aarch64|arm64/i.test(userAgent) ? 'arm64' : 'x64';
let catalog = { state:'loading', downloads:{} };
let pending = false;
$('architecture').value = architecture;
function render() {
 document.querySelectorAll('[data-platform]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.platform === platform)));
 const item = catalog.downloads[`${platform}-${architecture}`];
 $('downloads').setAttribute('aria-busy', String(pending));
 $('downloads').dataset.state = catalog.state;
 $('version').textContent = catalog.version || 'Public releases';
 $('retry').disabled = pending;
 $('install-help').textContent = help[platform];
 $('download').hidden = !item;
 $('unavailable').hidden = Boolean(item);
 $('download').removeAttribute('href');
 if (item) {
  $('download').href = item.url;
  $('download').textContent = `Download for ${labels[platform]} ↓`;
  $('download').setAttribute('aria-label', `Download Gentle Dot for ${labels[platform]} ${architecture}`);
  $('asset-detail').textContent = `${item.name} · ${(item.sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  $('status').textContent = 'Available from the official public release. Review the release notes before installing.';
 } else {
  $('asset-detail').textContent = '';
  $('unavailable').textContent = pending ? 'Checking release availability…' : 'Installer not available';
  $('status').textContent = catalog.state === 'error' ? 'We could not check releases. Your selection is saved. Check again or view official releases below.'
   : pending ? 'Checking the latest public release…'
   : catalog.state === 'ready' ? `This release has no unambiguous installer for ${labels[platform]} ${architecture}. Choose another build or view the release notes.`
   : 'No stable installer release is published yet. Downloads will appear automatically when native CI outputs are published as release assets.';
 }
 $('release-link').href = catalog.releaseUrl || 'https://github.com/Gentleman-Programming/gentle-dot/releases';
}
async function refresh() {
 if (pending) return;
 pending = true; catalog = { state:'loading', downloads:{} }; render();
 catalog = await loadRelease(); pending = false; render();
}
document.querySelectorAll('[data-platform]').forEach(button => button.addEventListener('click', () => { platform = button.dataset.platform; render(); }));
$('architecture').addEventListener('change', event => { architecture = event.target.value; render(); });
$('retry').addEventListener('click', refresh);
render();
refresh();
