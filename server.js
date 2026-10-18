// Static server on localhost (needed for the mic), proxies /api/* to Ollama and saves participant logs to results/.
import { createServer, request } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = +(process.env.PORT || 8000), OLLAMA = process.env.OLLAMA || 'http://127.0.0.1:11434';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.csv': 'text/csv' };
const root = import.meta.dirname;

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const up = request(OLLAMA + url.pathname, { method: req.method, headers: { 'content-type': 'application/json' } }, r => {
      res.writeHead(r.statusCode, { 'content-type': r.headers['content-type'] || 'application/json' });
      r.pipe(res);
    });
    up.on('error', e => { res.writeHead(502); res.end(JSON.stringify({ error: `Ollama not reachable: ${e.message}` })); });
    return req.pipe(up);
  }
  if (url.pathname === '/save' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const { name, content } = JSON.parse(body);
    await mkdir(join(root, 'results'), { recursive: true });
    await writeFile(join(root, 'results', name.replace(/[^\w.-]/g, '_')), content);
    return res.end('ok');
  }
  const path = normalize(join(root, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!path.startsWith(root)) return res.writeHead(403).end();
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404).end('not found'); }
}).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}`));
