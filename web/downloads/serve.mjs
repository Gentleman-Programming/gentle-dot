// Local preview only; fixed public-file allowlist, no directory traversal or listing.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const files = new Map([
 ['/', ['index.html','text/html']], ['/index.html',['index.html','text/html']],
 ['/styles.css',['styles.css','text/css']], ['/app.mjs',['app.mjs','text/javascript']],
 ['/releases.mjs',['releases.mjs','text/javascript']], ['/hero.png',['hero.png','image/png']],
]);
const server = createServer(async (request, response) => {
 const file = files.get(request.url);
 if (request.method !== 'GET' || !file) { response.writeHead(404, {'Content-Type':'text/plain'}); response.end('Not found\n'); return; }
 try {
  const data = await readFile(new URL(file[0], import.meta.url));
  response.writeHead(200, {'Content-Type':file[1].startsWith('image/')?file[1]:`${file[1]}; charset=utf-8`, 'X-Content-Type-Options':'nosniff', 'Cache-Control':'no-store'}); response.end(data);
 } catch { response.writeHead(500, {'Content-Type':'text/plain'}); response.end('Preview file unavailable\n'); }
});
server.listen(4173, '127.0.0.1', () => console.log('Gentle Dot downloads: http://127.0.0.1:4173'));
server.on('error', error => { console.error(`Preview failed: ${error.code ?? 'unknown'}`); process.exitCode = 1; });
