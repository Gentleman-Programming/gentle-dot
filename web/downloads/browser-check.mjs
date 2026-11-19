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
  return route.fulfill({status:200,json:release});
 });
 await context.route(`https://github.com/${REPOSITORY}/releases/download/**`,route=>route.fulfill({status:200,headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="fixture.txt"'},body:'synthetic launcher fixture\n'}));
 const url='http://127.0.0.1:4173';
 await page.goto(url); await firstRequest; await page.waitForFunction(()=>document.getElementById('downloads').dataset.state==='loading');
 assert.equal(await page.locator('#download').isVisible(),false);assert.equal(await page.locator('#retry').isDisabled(),true);
 mode='ready';releaseLoading();await page.waitForFunction(()=>document.getElementById('downloads').dataset.state==='ready');
 for(const platform of ['windows','macos','linux'])for(const arch of ['x64','arm64']){
  await page.locator(`[data-platform="${platform}"]`).click();await page.selectOption('#architecture',arch);
  const item=assets.find(asset=>asset.name.includes(`${platform}-${arch}`));
  assert.equal(await page.locator('#download').getAttribute('href'),item.browser_download_url);
  assert.equal(await page.locator('#download').isVisible(),true);
 }
 await page.locator('[data-platform="windows"]').click();await page.selectOption('#architecture','x64');
 const waiting=page.waitForEvent('download');await page.locator('#download').click();const download=await waiting;
 assert.equal(download.url(),assets[0].browser_download_url);assert.equal(download.suggestedFilename(),'fixture.txt');
 assert.equal(await download.failure(),null); // await fake bytes, never execute them
 const received=readFileSync(join(downloads,'fixture.txt'),'utf8');assert.equal(received,'synthetic launcher fixture\n');
 console.log('PASS loading, six target selections and intercepted fixture download');
 mode='missing';await page.reload();await page.waitForFunction(()=>document.getElementById('downloads').dataset.state==='unavailable');
 assert.equal(await page.locator('#download').getAttribute('href'),null);assert.match(await page.locator('#status').innerText(),/No stable installer/);
 mode='error';await page.reload();await page.waitForFunction(()=>document.getElementById('downloads').dataset.state==='error');
 await page.locator('[data-platform="linux"]').click();await page.selectOption('#architecture','arm64');mode='ready';await page.locator('#retry').click();
 await page.waitForFunction(()=>document.getElementById('downloads').dataset.state==='ready');assert.equal(await page.locator('#architecture').inputValue(),'arm64');assert.equal(await page.locator('[data-platform="linux"]').getAttribute('aria-pressed'),'true');
 mode='malformed';await page.reload();await page.waitForFunction(()=>document.getElementById('downloads').dataset.state==='error');assert.equal(await page.locator('#download').getAttribute('href'),null);
 console.log('PASS unavailable, malformed, rate-limit and retry preserving selection');
 mode='ready';await page.reload();await page.waitForFunction(()=>document.getElementById('downloads').dataset.state==='ready');
 for(const width of [320,768,1024,1440]){
  await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`No overflow at ${width}`);
  await page.screenshot({path:join(run,`page-${width}.png`),fullPage:true});
 }
 await page.goto(url);await page.keyboard.press('Tab');assert.equal(await page.locator(':focus').innerText(),'Skip to downloads');
 assert.equal(await page.locator('.brand .rose').count(),1);assert.deepEqual(errors,[]);assert.ok(calls>=6);
 assert.equal((await page.request.get(`${url}/not-an-asset`)).status(),404);
 assert.equal((await page.request.get(`${url}/releases.test.mjs`)).status(),404);
 console.log('PASS responsive widths, keyboard entry, rose, no uncaught browser errors and preview allowlist');
 writeFileSync(join(run,'result.json'),JSON.stringify({state:'pass',calls,screenshots:[320,768,1024,1440],fixtureDownloadOnly:true,retained:true}));
 console.log(`RETAINED=${run}`);
} catch(error) {
 writeFileSync(join(run,'result.json'),JSON.stringify({state:'failed',message:error.message,retained:true}));console.error(error);process.exitCode=1;
} finally {
 if(session){await session.send('Browser.close').catch(()=>{});await exited;}
 else if(child.pid){child.kill();await exited;}
 if(browser)await browser.close().catch(()=>{});
}
