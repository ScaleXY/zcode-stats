'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { loadMeta, queryTable, getCell } = require('./db');

const INDEX_HTML = path.join(__dirname, '..', 'ui', 'index.html');

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

/**
 * Only loopback hostnames may address this server. A request that arrives
 * with any other Host (e.g. after a DNS rebinding of an attacker domain to
 * 127.0.0.1, which would make a malicious page same-origin) is rejected.
 */
function hostAllowed(hostHeader) {
  if (typeof hostHeader !== 'string') return false;
  let h = hostHeader.toLowerCase().trim();
  if (h.startsWith('[')) h = h.slice(1, h.indexOf(']')); // IPv6 literal
  else h = h.replace(/:\d+$/, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
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
  // Every route lives under a per-session random path prefix (the token is
  // never handed out over the API), and shutdown additionally requires this
  // token in a custom header: a cross-origin page can neither guess the URL
  // nor send the header without a CORS preflight, which this server never
  // grants. The Host allowlist above blocks DNS-rebinding attempts to bypass
  // the same-origin policy altogether.
  const sessionToken = randomUUID();
  const prefix = `/t/${sessionToken}`;

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return json(res, 400, { error: 'bad url' });
    }
    if (!hostAllowed(req.headers.host)) {
      return json(res, 403, { error: 'forbidden host' });
    }
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) {
      return json(res, 404, { error: 'not found' });
    }
    const pathname = url.pathname.slice(prefix.length) || '/';

    let parts;
    try {
      parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return json(res, 400, { error: 'bad path encoding' });
    }

    try {
      if (pathname === '/api/shutdown') {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        if (req.headers['x-shutdown-token'] !== sessionToken) {
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

      if (pathname === '/' || pathname === '/index.html') {
        const st = fs.statSync(INDEX_HTML);
        if (!indexHtml || st.mtimeMs > indexLoadedAt) {
          indexHtml = fs.readFileSync(INDEX_HTML);
          indexLoadedAt = st.mtimeMs;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': CSP,
        });
        return res.end(indexHtml);
      }

      if (pathname === '/api/meta') {
        if (url.searchParams.get('refresh') === '1') {
          meta = loadMeta(db, meta.db.path);
        }
        return json(res, 200, { ...meta });
      }

      if (pathname === '/api/stats') {
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
      // Expected client errors keep their message; internals stay server-side.
      if (!err.status) console.error(err);
      return json(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
    }
  });

  server.on('clientError', (_err, socket) => socket.destroy());

  // URL path (token included) the CLI should open in the browser.
  server.openPath = `${prefix}/`;
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
        resolve(server.address().port); // actual port (differs when 0 was requested)
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
