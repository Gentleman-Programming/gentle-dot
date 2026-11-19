#!/usr/bin/env node
// Read-only verification of the exact QA payload before prerelease upload.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const refusal = 'Windows preview payload verification failed.';
const usage = 'usage: windows-preview-release.mjs DIRECTORY SOURCE_SHA';
const requireThat = value => { if (!value) throw Error(refusal); };
function bytes(path) {
 const stat=lstatSync(path); requireThat(stat.isFile()&&!stat.isSymbolicLink());return readFileSync(path);
}
export function verifyPreview(directory, source) {
 try {
  requireThat(typeof directory==='string' && /^[a-f0-9]{40}$/.test(source??''));
  const root=resolve(directory), stat=lstatSync(root);requireThat(stat.isDirectory()&&!stat.isSymbolicLink());
  const m=JSON.parse(bytes(join(root,'QA-MANIFEST.json')));
  requireThat(m.schema===1&&m.purpose==='manual-native-qa'&&m.releaseReady===false&&m.target==='windows-x64'&&m.source===source);
  requireThat(typeof m.version==='string'&&/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(m.version)&&Array.isArray(m.files)&&m.files.length===2);
  const installer=`gentle-dot-${m.version}-windows-x64-${source}-qa-setup.exe`;
  const expected=new Map([[installer,'installer'],['runtime-manifest.json','producer-runtime-manifest']]);
  const names=m.files.map(f=>f.name);
  requireThat(new Set(names).size===2&&names.every(name=>expected.has(name)));
  requireThat(JSON.stringify(readdirSync(root).sort())===JSON.stringify([...names,'QA-MANIFEST.json'].sort()));
  for(const f of m.files){
   requireThat(f.role===expected.get(f.name)&&Number.isSafeInteger(f.sizeBytes)&&f.sizeBytes>0&&/^[a-f0-9]{64}$/.test(f.sha256));
   const content=bytes(join(root,f.name));requireThat(content.length===f.sizeBytes&&createHash('sha256').update(content).digest('hex')===f.sha256);
  }
  requireThat(JSON.parse(bytes(join(root,'runtime-manifest.json'))).platform==='win32-x64');
  return {target:'windows-x64',source,version:m.version,files:[installer,'runtime-manifest.json','QA-MANIFEST.json'].map(name=>join(root,name))};
 }catch{throw Error(refusal);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 if(args.length===1&&args[0]==='--help')console.log(usage);
 else try{requireThat(args.length===2);console.log(JSON.stringify(verifyPreview(...args)));}
 catch(error){console.error(`preview-release: ${error.message}`);process.exitCode=2;}
}
