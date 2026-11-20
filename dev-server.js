// Local preview with the real API handlers and an in-memory database. Nothing is saved between runs.
// Usage: npm run dev  →  http://localhost:3000  (admin password: dev)
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dev.invalid';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'dev-only-not-a-credential';
process.env.PIN_TO_WIN_ADMIN_PASSWORD = process.env.PIN_TO_WIN_ADMIN_PASSWORD || 'dev';
process.env.PIN_TO_WIN_ADMIN_SESSION_SECRET = process.env.PIN_TO_WIN_ADMIN_SESSION_SECRET || 'dev-session-secret';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const mock = require('./tests/helpers/mock-supabase').createMock();
global.fetch = mock.fetch;
const root = __dirname;
const routes = { '/api/game': require('./api/game'), '/api/eoi': require('./api/eoi'), '/api/admin-scores': require('./api/admin-scores'), '/api/eoi-admin': require('./api/eoi-admin') };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'), handler = routes[url.pathname];
  if (handler) {
    let raw = ''; req.on('data', c => raw += c); req.on('end', async () => {
      req.query = Object.fromEntries(url.searchParams); req.body = raw ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : undefined;
      res.status = code => { res.statusCode = code; return res; };
      // Secure cookies are not stored over plain http on some browsers; drop the flag for local preview only.
      const setHeader = res.setHeader.bind(res); res.setHeader = (k, v) => setHeader(k, k.toLowerCase() === 'set-cookie' ? String(v).replace('; Secure', '') : v);
      try { await handler(req, res); } catch (e) { console.error(e); res.statusCode = 500; res.end('{}'); }
    });
    return;
  }
  const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(root + path.sep) || file.includes(`${path.sep}tests${path.sep}`)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); res.end('Not found'); return; } res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); res.end(data); });
}).listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Pin to Win dev preview with in-memory API: http://localhost:' + (process.env.PORT || 3000)));
