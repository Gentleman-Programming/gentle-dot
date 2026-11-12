// Inert source contracts only. Never compiles Rust, starts the app, or accesses an OS store.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const read=p=>readFileSync(new URL('../../../'+p,import.meta.url),'utf8');
const shell=()=>read('apps/desktop/src-tauri/src/shell.rs');
const section=(text,start,end)=>text.slice(text.indexOf(start),text.indexOf(end,text.indexOf(start)));

test('preview is compile-time opt-in and normal product identity remains unchanged',()=>{
 const cargo=read('apps/desktop/src-tauri/Cargo.toml');
 assert.match(cargo,/\[features\]\s+default = \[\]\s+local-preview = \[\]/);
 const normal=JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json'));
 assert.equal(normal.identifier,'dev.gentleman.gentle-dot');assert.equal(normal.productName,'Gentle Dot');assert.equal(normal.bundle.active,true);
 const preview=JSON.parse(read('apps/desktop/src-tauri/tauri.preview.conf.json'));
 assert.equal(preview.identifier,'dev.gentleman.gentle-dot.preview');assert.equal(preview.productName,'Gentle Dot Preview');assert.equal(preview.bundle.active,false);assert.deepEqual(preview.app.windows,[]);
});
test('identity and fresh-root admission precede configuration, plugins, stores and startup',()=>{
 const run=shell().slice(shell().indexOf('pub fn run()'));
 assert.ok(run.indexOf('crate::preview::prepare(')>=0);
 assert.ok(run.indexOf('crate::preview::prepare(')<run.indexOf('config::load_preview_config('));
 assert.ok(run.indexOf('config::load_preview_config(')<run.indexOf('tauri::Builder::default()'));
 assert.match(run,/crate::windows_process::private_directory\(root\)/);
 assert.match(run,/\.build\(context\)/);
});
test('preview selects MemoryStore without constructing the production backend',()=>{
 const s=shell();
 assert.match(s,/#\[cfg\(feature = "local-preview"\)\]\s+let secrets: Box<dyn SecretStore> = Box::new\(secure_store::MemoryStore::new\(\)\);/);
 assert.match(s,/#\[cfg\(not\(feature = "local-preview"\)\)\]\s+let secrets = secure_store::connector_store\(\);/);
});
test('both centralized windows use the same owned WebView directory and visible preview title',()=>{
 const s=section(shell(),'fn build_windows(','/// The tray menu');
 assert.equal([...s.matchAll(/\.data_directory\(app\.state::<crate::preview::OwnedRoot>\(\)\.webview_dir\(\)\)/g)].length,2);
 assert.equal([...s.matchAll(/\.title\(crate::preview::PRODUCT_NAME\)/g)].length,2);
 assert.equal([...s.matchAll(/\.decorations\(true\)/g)].length,2);
});
test('single-instance, global-shortcut and autostart plugins are excluded together in preview',()=>{
 const run=shell().slice(shell().indexOf('pub fn run()'));
 assert.match(run,/#\[cfg\(not\(feature = "local-preview"\)\)\]\s+let builder = builder\s*\/\/[\s\S]*?\.plugin\(tauri_plugin_single_instance/);
 assert.ok(run.includes('.plugin(tauri_plugin_global_shortcut::Builder::new().build())'));
 assert.ok(run.includes('.plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))'));
 const tray=section(shell(),'fn build_tray(','fn rose_hidden_state(');
 assert.match(tray,/#\[cfg\(not\(feature = "local-preview"\)\)\]\s+let autostart = app.autolaunch\(\)/);
 assert.match(shell(),/fn toggle_autostart[\s\S]*?#\[cfg\(feature = "local-preview"\)\]\s+return Err\(crate::preview::DISABLED.into\(\)\);/);
});
test('IPC gate precedes dispatch and preview does not start native provider or voice helpers',()=>{
 const s=shell();assert.match(s,/crate::preview::blocked_command\(invoke.message.command\(\)\)/);
 assert.match(s,/#\[cfg\(not\(feature = "local-preview"\)\)\]\s+let computer = computer::start/);
 assert.match(s,/#\[cfg\(not\(feature = "local-preview"\)\)\]\s+\{\s+let \(voice_input, voice_model\) = voice::start/);
 assert.match(s,/memory == "shared"[\s\S]*?return Err\(crate::preview::DISABLED.into\(\)\)/);
});
test('production configuration reads remain present only outside preview; preview never reads an old config',()=>{
 const config=read('apps/desktop/src-tauri/src/config.rs');
 assert.match(config,/#\[cfg\(not\(feature = "local-preview"\)\)\]\s+pub fn load_config\(\)/);
 const preview=section(config,'pub fn load_preview_config(','pub const INVALID_CONFIG');
 assert.ok(preview.includes('crate::preview::port('));assert.ok(preview.includes('save_memory('));assert.ok(preview.includes('MemoryMode::Private'));
 assert.doesNotMatch(preview,/read_to_string|resolve_data_dir|home_dir/);
 assert.match(config,/let dir = resolve_data_dir\(crate::platform::Os::CURRENT/);
});
test('policy remains std-only, exclusively creates roots, rejects aliases and preserves native guards',()=>{
 const policy=read('apps/desktop/src-tauri/src/preview.rs');
 assert.match(policy,/std::fs::create_dir\(root\)/);assert.match(policy,/Component::ParentDir/);assert.match(policy,/metadata.file_attributes\(\) & 0x400/);
 assert.doesNotMatch(policy,/create_dir_all|remove_dir|remove_file|std::env::var|connector_store|CredentialStore|tauri::/);
 const launch=read('apps/desktop/src-tauri/src/daemon/launch.rs');assert.ok(launch.includes('dir.is_absolute() && holds_git(dir)'));
 const daemon=read('apps/desktop/src-tauri/src/daemon.rs');assert.ok(daemon.includes('windows::open_private_log(data_dir)'));
});
