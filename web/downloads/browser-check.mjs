// Uses an installed browser with a NEW retained profile, never an existing user profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
import { RELEASE_API, REPOSITORY } from './releases.mjs';
const root = resolve('build/download-page-checks'); mkdirSync(root, { recursive:true });
const run = mkdtempSync(join(root,'browser-')); const downloads = join(run,'downloads'); mkdirSync(downloads);
const executable = process.env.GENTLE_DOT_TEST_BROWSER;
assert.ok(executable, 'Set GENTLE_DOT_TEST_BROWSER to an existing Chromium/Edge executable; no browser will be downloaded.');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC|TEMP|TMP|NODE_OPTIONS)$/i.test(key)));
const child = spawn(executable, ['--headless=new','--remote-debugging-port=0',`--user-data-dir=${join(run,'profile')}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--disable-component-update','about:blank'], { env, stdio:['ignore','ignore','pipe'] });
writeFileSync(join(run,'owner.json'),JSON.stringify({pid:child.pid,purpose:'isolated download-page browser check',retained:true}));
const exited = once(child,'exit'); let browser, session;
try {
 const endpoint = await new Promise((accept,reject) => {
  const timer = setTimeout(()=>reject(Error('Browser startup deadline exceeded')),15_000); let output='';
  child.once('error',reject); child.stderr.on('data',bytes=>{output+=bytes.toString(); const match=output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if(match){clearTimeout(timer);accept(match[1]);}});
 });
 browser = await chromium.connectOverCDP(endpoint); session = await browser.newBrowserCDPSession();
 await session.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads,eventsEnabled:true});
 const context = browser.contexts()[0]; const page = await context.newPage(); page.setDefaultTimeout(5000);
 const device = await context.newCDPSession(page);
 const setUserAgent = userAgent => device.send('Emulation.setUserAgentOverride', {userAgent});
 await setUserAgent('Gentle Dot Browser Fixture');
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 let mode='loading', releaseLoading, calls=0, releaseStarted;
 const firstRequest=new Promise(done=>{releaseStarted=done;});
 const tag='v0.1.0', names=['gentle-dot-windows-x64-setup.exe','gentle-dot-windows-arm64-setup.exe','gentle-dot-macos-x64.dmg','gentle-dot-macos-arm64.dmg','gentle-dot-linux-x64.deb','gentle-dot-linux-arm64.deb'];
 const assets=names.map(name=>({name,state:'uploaded',size:2048,browser_download_url:`https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`}));
 const release={tag_name:tag,draft:false,prerelease:false,html_url:`https://github.com/${REPOSITORY}/releases/tag/${tag}`,assets};
 await context.route(RELEASE_API,async route=>{
  calls++;releaseStarted();
  if(mode==='loading') await new Promise(done=>{releaseLoading=done;});
  if(mode==='missing')return route.fulfill({status:404,json:{message:'Not Found'}});
  if(mode==='error')return route.fulfill({status:403,json:{message:'rate limited'}});
  if(mode==='malformed')return route.fulfill({status:200,contentType:'application/json',body:'not json'});
  if(mode==='partial')return route.fulfill({status:200,json:{...release,assets:[assets[0]]}});
  return route.fulfill({status:200,json:release});
 });
 await context.route(`https://github.com/${REPOSITORY}/releases/download/**`,route=>route.fulfill({status:200,headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="fixture.txt"'},body:'synthetic launcher fixture\n'}));
 const url='http://127.0.0.1:4173';
 const officialReleases=`https://github.com/${REPOSITORY}/releases`;
 const status=page.locator('#status'), retry=page.locator('#retry'), downloadLink=page.locator('#download');
 const processor=page.locator('#architecture'), selected=page.locator('[data-platform][aria-pressed=true]');
 const releaseLink=page.getByRole('link',{name:/View official releases/});
 const loadingText='Checking the latest public release…';
 const selectionText='Choose your system and processor to see the installer.';
 const errorText='We couldn’t check for installers. Try again or visit the official releases page.';
 const waitForState=state=>page.waitForFunction(value=>document.getElementById('downloads').dataset.state===value,state);
 const checkNoDownload=async()=>{
  assert.equal(await downloadLink.isVisible(),false);
  assert.equal(await downloadLink.getAttribute('href'),null);
 };
 await page.goto(url); await firstRequest; await waitForState('loading');
 assert.equal(await page.locator('#unavailable').count(),0,'No disabled download CTA');
 assert.equal(await page.locator('.download-action #status[role=status][aria-live=polite]').count(),1);
 assert.equal(await page.locator('[aria-live]').count(),1);
 assert.equal(await status.locator('xpath=ancestor::*[@aria-busy="true"]').count(),0);
 assert.equal(await status.isVisible(),true);
 assert.equal(await status.innerText(),loadingText);
 await checkNoDownload();assert.equal(await retry.getAttribute('aria-disabled'),'true');
 assert.equal(await releaseLink.getAttribute('href'),officialReleases);
 const initialHtml=await (await page.request.get(url)).text();
 assert.ok(initialHtml.includes(loadingText));assert.doesNotMatch(initialHtml,/No (?:stable )?installer (?:release is published|has been published)/);
 assert.equal(await selected.count(),0);assert.equal(await processor.inputValue(),'');
 assert.equal(await processor.getAttribute('aria-describedby'),'processor-help');
 mode='ready';releaseLoading();await waitForState('ready');
 assert.equal(await status.innerText(),selectionText);await checkNoDownload();
 await page.selectOption('#architecture','x64');
 assert.equal(await status.innerText(),selectionText);await checkNoDownload();
 await page.selectOption('#architecture','');
 assert.equal(await releaseLink.getAttribute('href'),release.html_url);
 await status.evaluate(element=>{
  new MutationObserver(()=>{element.dataset.mutated='true';}).observe(element,{childList:true,characterData:true,subtree:true});
 });
 await page.getByRole('button',{name:'Windows',exact:true}).click();
 assert.equal(await status.innerText(),selectionText);await checkNoDownload();
 assert.equal(await status.getAttribute('data-mutated'),null,'Unchanged status is not rewritten');
 assert.match(await selected.evaluate(element=>getComputedStyle(element,'::before').content),/✓/);
 assert.match(await page.locator('#processor-help').innerText(),/Debian\/Ubuntu packages \(\.deb\)/);
 for(const platform of ['windows','macos','linux'])for(const arch of ['x64','arm64']){
  await page.locator(`[data-platform="${platform}"]`).click();
  assert.deepEqual(await processor.locator('option').allTextContents(), ['Choose your processor',...(platform==='macos'
   ? ['Intel Mac · x64','Apple silicon · arm64'] : ['Intel / AMD · x64','ARM · arm64'])]);
  await page.selectOption('#architecture',arch);
  const item=assets.find(asset=>asset.name.includes(`${platform}-${arch}`));
  assert.equal(await page.locator('#download').getAttribute('href'),item.browser_download_url);
  assert.equal(await page.locator('#download').isVisible(),true);
  assert.equal(await status.innerText(),'Available from the official release. Read the release notes before installing.');
 }
 await page.locator('[data-platform="windows"]').click();await page.selectOption('#architecture','x64');
 const waiting=page.waitForEvent('download');await page.locator('#download').click();const download=await waiting;
 assert.equal(download.url(),assets[0].browser_download_url);assert.equal(download.suggestedFilename(),'fixture.txt');
 assert.equal(await download.failure(),null); // await fake bytes, never execute them
 const received=readFileSync(join(downloads,'fixture.txt'),'utf8');assert.equal(received,'synthetic launcher fixture\n');
 console.log('PASS loading, six target selections and intercepted fixture download');
 mode='partial';await retry.click();await waitForState('ready');
 await page.locator('[data-platform="linux"]').click();await page.selectOption('#architecture','arm64');
 await checkNoDownload();assert.equal(await status.innerText(),'This release has no installer for Linux arm64. Try another build or read the release notes.');
 assert.equal(await releaseLink.getAttribute('href'),release.html_url);
 mode='missing';await page.reload();await waitForState('unavailable');await checkNoDownload();
 assert.equal(await status.innerText(),selectionText);
 await page.locator('[data-platform="linux"]').click();await page.selectOption('#architecture','arm64');
 await checkNoDownload();assert.equal(await status.innerText(),'No installer has been published yet. Check the official releases page for updates.');
 assert.equal(await releaseLink.getAttribute('href'),officialReleases);
 mode='error';await page.reload();await waitForState('error');await checkNoDownload();
 assert.equal(await status.innerText(),errorText);assert.equal(await releaseLink.getAttribute('href'),officialReleases);
 await page.locator('[data-platform="linux"]').click();await page.selectOption('#architecture','arm64');
 mode='loading';releaseLoading=undefined;const beforeRetry=calls;
 await retry.focus();await page.keyboard.press('Enter');await waitForState('loading');
 await page.waitForFunction(()=>document.activeElement?.id==='retry');
 assert.equal(await retry.getAttribute('aria-disabled'),'true');assert.equal(await status.innerText(),loadingText);await checkNoDownload();
 await page.keyboard.press('Enter');
 for(let attempt=0; !releaseLoading && attempt<100; attempt++) await new Promise(done=>setTimeout(done,10));
 assert.equal(typeof releaseLoading,'function','Retry reached the release API fixture');
 mode='ready';releaseLoading();await waitForState('ready');
 assert.equal(calls,beforeRetry+1);assert.equal(await retry.isDisabled(),false);
 assert.equal(await page.locator(':focus').getAttribute('id'),'retry');
 assert.equal(await processor.inputValue(),'arm64');assert.equal(await selected.getAttribute('data-platform'),'linux');
 assert.equal(await downloadLink.getAttribute('href'),assets[5].browser_download_url);
 mode='malformed';await page.reload();await waitForState('error');await checkNoDownload();assert.equal(await status.innerText(),errorText);
 console.log('PASS no matching asset, unavailable, malformed, rate-limit and retry preserving focus and selection');
 mode='ready';
 for(const [ua, platform, architecture] of [
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)','windows','x64'],
  ['Mozilla/5.0 (Windows NT 10.0)','windows',''],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)','macos',''],
  ['Mozilla/5.0 (Macintosh; arm64 Mac OS X 14_0)','macos',''],
  ['Mozilla/5.0 (X11; Linux aarch64)','linux','arm64'],
  ['Mozilla/5.0 (Linux; Android 14; arm64)',null,''],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',null,''],
  ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',null,''],
 ]){
  await setUserAgent(ua);await page.reload();await waitForState('ready');
  assert.deepEqual(await selected.evaluateAll(items=>items.map(item=>item.dataset.platform)),platform?[platform]:[],ua);
  assert.equal(await processor.inputValue(),architecture,ua);
  if(!platform || !architecture){assert.equal(await status.innerText(),selectionText);await checkNoDownload();}
 }
 console.log('PASS processor labels and conservative OS/CPU suggestions');
 await setUserAgent('Gentle Dot Browser Fixture');await page.reload();await waitForState('ready');
 for(const width of [320,768,1024,1440]){
  await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`No overflow at ${width}`);
  assert.equal(await page.locator('header').getByRole('link',{name:'How to install'}).isVisible(),true);
  await page.screenshot({path:join(run,`page-${width}.png`),fullPage:true});
 }
 const windowsButton=page.getByRole('button',{name:'Windows',exact:true});
 await windowsButton.click();
 const outline=element=>getComputedStyle(element).outlineWidth;
 const controls=page.locator('.platforms button, #architecture, #retry');
 const boundaryRatios=await controls.evaluateAll(elements=>{
  const channels=color=>color.match(/[\d.]+/g).map(Number);
  const luminance=rgb=>rgb.slice(0,3).map(value=>value/255)
   .map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4)
   .reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
  return elements.map(element=>{
   const style=getComputedStyle(element);
   const border=luminance(channels(style.borderTopColor));
   const panel=channels(getComputedStyle(element.closest('#downloads')).backgroundColor);
   const [r,g,b,alpha=1]=channels(style.backgroundColor);
   const fill=luminance([r,g,b].map((value,index)=>value*alpha+panel[index]*(1-alpha)));
   return Math.min(...[fill,luminance(panel)].map(background=>(Math.max(border,background)+0.05)/(Math.min(border,background)+0.05)));
  });
 });
 assert.ok(boundaryRatios.every(ratio=>ratio>=3),`Control boundaries reach 3:1: ${boundaryRatios.join(', ')}`);
 await page.emulateMedia({forcedColors:'active'});
 assert.match(await windowsButton.evaluate(element=>getComputedStyle(element,'::before').content),/✓/);
 await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
 assert.equal(await windowsButton.evaluate(element=>element.matches(':focus-visible')),true);
 assert.equal(await windowsButton.evaluate(outline),'3px');
 await page.emulateMedia({forcedColors:'none',contrast:'more'});
 assert.equal(await processor.evaluate(element=>getComputedStyle(element).borderTopWidth),'2px');
 await page.emulateMedia({contrast:'no-preference'});
 await page.goto(url);await page.keyboard.press('Tab');assert.equal(await page.locator(':focus').innerText(),'Skip to downloads');
 assert.equal(await page.locator('.brand .rose').count(),1);assert.deepEqual(errors,[]);assert.ok(calls>=6);
 assert.equal((await page.request.get(`${url}/not-an-asset`)).status(),404);
 assert.equal((await page.request.get(`${url}/releases.test.mjs`)).status(),404);
 console.log('PASS control contrast, forced colors, responsive widths, keyboard entry, rose, no uncaught browser errors and preview allowlist');
 writeFileSync(join(run,'result.json'),JSON.stringify({state:'pass',calls,screenshots:[320,768,1024,1440],fixtureDownloadOnly:true,retained:true}));
 console.log(`RETAINED=${run}`);
} catch(error) {
 writeFileSync(join(run,'result.json'),JSON.stringify({state:'failed',message:error.message,retained:true}));console.error(error);process.exitCode=1;
} finally {
 if(session){await session.send('Browser.close').catch(()=>{});await exited;}
 else if(child.pid){child.kill();await exited;}
 if(browser)await browser.close().catch(()=>{});
}
