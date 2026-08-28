#!/usr/bin/env node
'use strict';

// node:sqlite emits an ExperimentalWarning at require time that cannot be
// intercepted at runtime; re-exec once with --no-warnings for a clean CLI.
// Note: do NOT require('node:sqlite') in this parent process — the warning
// fires at import time, before any listener can suppress it.
if (!process.env.ZCODE_STATS_CHILD) {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['--no-warnings', __filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ZCODE_STATS_CHILD: '1' },
  });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
  return;
}

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const VERSION = require('../package.json').version;

function usage(out) {
  out(`zcode-stats v${VERSION} — read-only web dashboard for the ZCode CLI database

Usage:
  zcode-stats [options]

Options:
  --db <path>    Path to db.sqlite (default: ~/.zcode/cli/db/db.sqlite)
  --port <n>     Port to serve on, 0 for a random free port (default: 8765)
  --no-open      Do not open the browser automatically
  --cost-estimator | --cost
                 CLI-only: print the estimated API cost of the ZCode sessions
                 belonging to the current folder (per thread, per model, and
                 the total), then exit. No server is started.
  --json         With --cost-estimator: output raw JSON instead of a table
  --version      Print version
  -h, --help     Show this help

The database is opened strictly read-only and the web server binds to
127.0.0.1 only, serves everything under a per-session secret URL path,
and rejects requests with any other Host header. Nothing is ever written
to the database file.`);
}

function parseArgs(argv) {
  const opts = { db: null, port: 8765, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--version') {
      opts.version = true;
    } else if (a === '--db') {
      opts.db = argv[++i];
      if (!opts.db) { console.error('--db requires a path'); process.exit(2); }
    } else if (a === '--port') {
      const p = parseInt(argv[++i], 10);
      if (!Number.isInteger(p) || p < 0 || p > 65535) {
        console.error('--port requires an integer between 0 and 65535');
        process.exit(2);
      }
      opts.port = p;
    } else if (a === '--no-open') {
      opts.open = false;
    } else if (a === '--cost-estimator' || a === '--cost') {
      opts.cost = true;
    } else if (a === '--json') {
      opts.json = true;
    } else {
      console.error(`Unknown option: ${a}`);
      usage(console.error);
      process.exit(2);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage(console.log);
  if (opts.version) return console.log(VERSION);

  let dbApi;
  try {
    dbApi = require('../src/db');
  } catch (err) {
    console.error(
      `This tool needs Node.js >= 22.5 with node:sqlite (got ${process.version}): ${err.message}`
    );
    process.exit(1);
  }

  const dbPath = opts.db
    ? path.resolve(opts.db)
    : dbApi.DEFAULT_DB_PATH;

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    console.error('Pass a path with --db <path> if your database lives elsewhere.');
    process.exit(1);
  }

  let db;
  try {
    db = dbApi.openReadOnly(dbPath);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (opts.cost) {
    const { estimateDirectoryCost, formatCostReport } = require('../src/estimate');
    const result = estimateDirectoryCost(db, process.cwd());
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatCostReport(result, dbPath));
    db.close();
    return;
  }

  const meta = dbApi.loadMeta(db, dbPath);
  const { buildStats } = require('../src/stats');
  const { createApp, listen } = require('../src/server');

  const server = createApp({
    db,
    meta,
    buildStats,
    onShutdown: () => {
      console.log('\n⏹  Stopped via the web UI.');
      process.exit(0);
    },
  });
  listen(server, opts.port)
    .then((port) => {
      const url = `http://127.0.0.1:${port}${server.openPath}`;
      const mb = (meta.db.bytes / 1024 / 1024).toFixed(1);
      console.log(`zcode-stats v${VERSION}`);
      console.log(`db:     ${dbPath} (${mb} MB, opened read-only)`);
      console.log(`tables: ${meta.tables.length}, non-empty: ${meta.tables.filter((t) => t.count > 0).length}`);
      console.log(`ui:     ${url}`);
      console.log(`Press Ctrl+C to stop.`);
      if (opts.open) openBrowser(url);
    })
    .catch((err) => {
      console.error(`Could not listen on port ${opts.port}: ${err.message}`);
      process.exit(1);
    });

  process.on('SIGINT', () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* opening the browser is best-effort */
  }
}

main();
