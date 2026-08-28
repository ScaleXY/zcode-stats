'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { loadMeta, queryTable, getCell } = require('./db');

const INDEX_HTML = path.join(__dirname, '..', 'ui', 'index.html');

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** Collect per-column filters from `f.<column>=value` search params. */
function parseColumnFilters(url) {
  const filters = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (k.startsWith('f.')) filters[k.slice(2)] = v;
  }
  return filters;
}

function createApp({ db, meta: initialMeta, buildStats, onShutdown }) {
  let meta = initialMeta; // mutable so ?refresh=1 can recompute table counts
  let indexHtml = null;
  let indexLoadedAt = 0;
  // Shutdown requires this token in a custom header, so only the UI served by
  // this server (same-origin) can trigger it; a cross-origin page would need
  // a CORS preflight, which this server never grants.
  const shutdownToken = randomUUID();

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return json(res, 400, { error: 'bad url' });
    }
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    try {
      if (url.pathname === '/api/shutdown') {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        if (req.headers['x-shutdown-token'] !== shutdownToken) {
          return json(res, 403, { error: 'forbidden' });
        }
        json(res, 200, { ok: true, stopped: true });
        setTimeout(() => {
          if (onShutdown) onShutdown();
          else process.exit(0);
        }, 100);
        return;
      }

      if (req.method !== 'GET') {
        return json(res, 405, { error: 'GET only' });
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        const st = fs.statSync(INDEX_HTML);
        if (!indexHtml || st.mtimeMs > indexLoadedAt) {
          indexHtml = fs.readFileSync(INDEX_HTML);
          indexLoadedAt = st.mtimeMs;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end(indexHtml);
      }

      if (url.pathname === '/api/meta') {
        if (url.searchParams.get('refresh') === '1') {
          meta = loadMeta(db, meta.db.path);
        }
        return json(res, 200, { ...meta, shutdownToken });
      }

      if (url.pathname === '/api/stats') {
        return json(res, 200, buildStats(db));
      }

      if (parts[0] === 'api' && parts[1] === 'table' && parts[2]) {
        const result = queryTable(db, meta, {
          table: parts[2],
          page: url.searchParams.get('page'),
          limit: url.searchParams.get('limit'),
          sort: url.searchParams.get('sort'),
          dir: url.searchParams.get('dir'),
          q: url.searchParams.get('q'),
          filters: parseColumnFilters(url),
        });
        return json(res, 200, result);
      }

      if (parts[0] === 'api' && parts[1] === 'cell' && parts.length === 5) {
        return json(res, 200, getCell(db, meta, parts[2], parts[3], parts[4]));
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, err.status || 500, { error: err.message });
    }
  });

  server.on('clientError', (_err, socket) => socket.destroy());

  return server;
}

/**
 * Listen on loopback only (the database holds personal data). Retries the
 * next ports when the preferred one is busy.
 */
function listen(server, preferredPort) {
  return new Promise((resolve, reject) => {
    let port = preferredPort;
    const attempts = preferredPort === 0 ? 1 : 25;

    const tryListen = (remaining) => {
      server.once('error', onErr);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onErr);
        resolve(port);
      });

      function onErr(err) {
        server.removeListener('error', onErr);
        if (err.code === 'EADDRINUSE' && remaining > 1) {
          port += 1;
          tryListen(remaining - 1);
        } else {
          reject(err);
        }
      }
    };

    tryListen(attempts);
  });
}

module.exports = { createApp, listen };
