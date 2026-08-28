'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.zcode',
  'cli',
  'db',
  'db.sqlite'
);

const MAX_LIST_CELL = 4000; // truncate cells beyond this in list responses
const MAX_CELL = 3 * 1024 * 1024; // hard cap for the full-cell endpoint

/**
 * Open the database strictly read-only. SQLite guarantees a connection opened
 * with readOnly never writes to the main database file. `PRAGMA query_only`
 * is belt-and-braces: it rejects any write statement on this connection even
 * if the open mode were ever changed by mistake.
 */
function openReadOnly(dbPath) {
  const st = fs.statSync(dbPath); // throws ENOENT etc. with a clear message upstream
  if (!st.isFile()) throw new Error(`${dbPath} is not a file`);
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    throw new Error(
      `Could not open ${dbPath} read-only (${err.message}). ` +
        'This tool requires Node.js >= 22.5 (node:sqlite with the readOnly option).'
    );
  }
  db.exec('PRAGMA query_only = ON');
  return db;
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function all(db, sql, params) {
  return db.prepare(sql).all(params || {}).map((r) => Object.assign({}, r));
}

function get(db, sql, params) {
  const row = db.prepare(sql).get(params || {});
  return row ? Object.assign({}, row) : undefined;
}

function tableColumns(db, table) {
  return all(db, `PRAGMA table_info(${quoteIdent(table)})`).map((c) => ({
    name: c.name,
    type: (c.type || '').toLowerCase(),
  }));
}

/** Discover every user table with its row count and column list. */
function loadMeta(db, dbPath) {
  const names = all(
    db,
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`
  ).map((r) => r.name);

  const tables = names.map((name) => {
    const columns = tableColumns(db, name);
    let count = 0;
    let hasRowid = true;
    try {
      count = get(db, `SELECT count(*) AS c FROM ${quoteIdent(name)}`).c;
    } catch {
      count = -1;
    }
    try {
      get(db, `SELECT rowid AS r FROM ${quoteIdent(name)} LIMIT 1`);
    } catch {
      hasRowid = false;
    }
    return { name, count, columns, hasRowid };
  });

  const st = fs.statSync(dbPath);
  let walBytes = null;
  try {
    walBytes = fs.statSync(dbPath + '-wal').size;
  } catch {
    /* no WAL file */
  }

  return {
    db: {
      path: dbPath,
      bytes: st.size,
      modifiedMs: Math.round(st.mtimeMs),
      walBytes,
      openedMode: 'read-only',
    },
    tables,
  };
}

const TIMEISH_DEFAULTS = ['time_created', 'started_at', 'time_updated', 'time_applied'];

function defaultSort(columns) {
  for (const cand of TIMEISH_DEFAULTS) {
    if (columns.some((c) => c.name === cand)) return { sort: cand, dir: 'desc' };
  }
  return { sort: '__rowid__', dir: 'asc' };
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/**
 * Paginated, sortable, searchable SELECT over one table. All identifiers are
 * validated against loaded metadata; user search text only ever appears in a
 * bound parameter.
 */
function queryTable(db, meta, opts) {
  const table = meta.tables.find((t) => t.name === opts.table);
  if (!table) {
    const err = new Error(`Unknown table: ${opts.table}`);
    err.status = 404;
    throw err;
  }

  const colNames = table.columns.map((c) => c.name);
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 500);
  const page = Math.max(parseInt(opts.page, 10) || 1, 1);
  const offset = (page - 1) * limit;

  let sort = opts.sort;
  let dir = opts.dir === 'asc' || opts.dir === 'desc' ? opts.dir : null;
  if (!sort || (sort !== '__rowid__' && !colNames.includes(sort))) {
    const d = defaultSort(table.columns);
    sort = d.sort;
    dir = dir || d.dir;
  }
  if (!dir) dir = sort === '__rowid__' ? 'asc' : 'desc';

  const q = (opts.q || '').trim();
  // Per-column substring filters (validated against text-typed columns).
  const filters = {};
  if (opts.filters && typeof opts.filters === 'object') {
    for (const [col, val] of Object.entries(opts.filters)) {
      if (!val) continue;
      const c = table.columns.find((x) => x.name === col);
      if (c && (c.type === '' || c.type === 'text' || c.type === 'blob')) {
        filters[col] = String(val);
      }
    }
  }

  const conds = [];
  const params = {};
  if (q) {
    const clauses = [];
    table.columns.forEach((c, i) => {
      if (c.type === '' || c.type === 'text' || c.type === 'blob') {
        const p = `p${i}`;
        params[p] = `%${escapeLike(q)}%`;
        clauses.push(`${quoteIdent(c.name)} LIKE :${p} ESCAPE '\\'`);
      }
    });
    if (clauses.length) conds.push('(' + clauses.join(' OR ') + ')');
  }
  Object.entries(filters).forEach(([col, val], i) => {
    const p = `f${i}`;
    params[p] = `%${escapeLike(val)}%`;
    conds.push(`${quoteIdent(col)} LIKE :${p} ESCAPE '\\'`);
  });
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const total = table.count;
  const filteredTotal = conds.length
    ? get(db, `SELECT count(*) AS c FROM ${quoteIdent(table.name)} ${where}`, params).c
    : total;

  const selectCols = ['rowid AS __rowid__', ...colNames.map(quoteIdent)].join(', ');
  const rows = all(
    db,
    `SELECT ${selectCols} FROM ${quoteIdent(table.name)} ${where}
      ORDER BY ${sort === '__rowid__' ? 'rowid' : quoteIdent(sort)} ${dir}
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  // Truncate monster cells (e.g. part.data blobs) so list payloads stay sane;
  // the full value is available via the /api/cell endpoint.
  const truncated = rows.map((row) => {
    const flags = {};
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (typeof v === 'string' && v.length > MAX_LIST_CELL) {
        row[k] = v.slice(0, MAX_LIST_CELL);
        flags[k] = true;
      }
    }
    return flags;
  });

  return {
    table: table.name,
    columns: table.columns,
    hasRowid: table.hasRowid,
    total,
    filteredTotal,
    page,
    limit,
    sort,
    dir,
    q,
    filters,
    rows,
    truncated,
  };
}

/** Full, untruncated value of a single cell addressed by rowid. */
function getCell(db, meta, table, rowid, column) {
  const t = meta.tables.find((x) => x.name === table);
  if (!t) {
    const err = new Error(`Unknown table: ${table}`);
    err.status = 404;
    throw err;
  }
  if (!t.columns.some((c) => c.name === column)) {
    const err = new Error(`Unknown column: ${column}`);
    err.status = 400;
    throw err;
  }
  if (!t.hasRowid) {
    const err = new Error(`Table ${table} has no rowid`);
    err.status = 400;
    throw err;
  }
  const rid = Number.parseInt(rowid, 10);
  if (!Number.isInteger(rid)) {
    const err = new Error('rowid must be an integer');
    err.status = 400;
    throw err;
  }
  const row = get(
    db,
    `SELECT ${quoteIdent(column)} AS v FROM ${quoteIdent(table)} WHERE rowid = :rid`,
    { rid }
  );
  if (!row) {
    const err = new Error('Row not found');
    err.status = 404;
    throw err;
  }
  let value = row.v;
  let truncated = false;
  if (typeof value === 'string' && value.length > MAX_CELL) {
    value = value.slice(0, MAX_CELL);
    truncated = true;
  }
  return { table, rowid: rid, column, value, truncated };
}

module.exports = {
  DEFAULT_DB_PATH,
  openReadOnly,
  loadMeta,
  queryTable,
  getCell,
  all,
  get,
  quoteIdent,
};
