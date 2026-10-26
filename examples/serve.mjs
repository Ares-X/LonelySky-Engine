import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png' };
const port = Number(process.env.PORT || 4180);
const server = createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    const url = new URL(request.url, 'http://localhost');
    const path = resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/examples/minimal.html' : url.pathname)}`);
    const relative = path.slice(root.length + 1);
    if (!path.startsWith(root + sep) || relative.split(sep).some(part => part.startsWith('.'))) {
      response.writeHead(404).end('Not found'); return;
    }
    const body = await readFile(path);
    response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (!['ENOENT', 'EISDIR', 'ENOTDIR', 'URIError'].includes(error.code || error.name)) console.error(error);
    response.writeHead(404).end('Not found');
  }
});
server.on('error', error => { console.error(error); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Embedding example: http://127.0.0.1:${port}/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
