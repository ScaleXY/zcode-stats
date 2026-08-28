'use strict';

const { all } = require('./db');
const { INFO: PRICING_INFO, estimateCostUsd } = require('./pricing');

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

const SESSION_COLS = `
  s.id, s.slug, s.title, s.task_type, s.directory,
  s.time_created, s.time_updated,
  (SELECT count(*) FROM message m WHERE m.session_id = s.id) AS messages,
  count(mu.id)   AS requests,
  coalesce(sum(mu.input_tokens), 0)            AS input_tokens,
  coalesce(sum(mu.output_tokens), 0)           AS output_tokens,
  coalesce(sum(mu.cache_read_input_tokens), 0) AS cache_read_tokens,
  coalesce(sum(mu.computed_total_tokens), 0)   AS total_tokens,
  min(mu.started_at) AS first_ms,
  max(coalesce(mu.completed_at, mu.started_at)) AS last_ms`;

/**
 * Cost of every ZCode session ("thread") tied to `dir`. Exact directory match
 * first; if nothing matches, falls back to including subfolders.
 */
function estimateDirectoryCost(db, dir) {
  let where = 's.directory = :dir';
  let params = { dir };
  let sessions = all(db, `SELECT ${SESSION_COLS}
    FROM session s LEFT JOIN model_usage mu ON mu.session_id = s.id
    WHERE ${where} GROUP BY s.id`, params);

  let includesSubfolders = false;
  if (!sessions.length) {
    where = `(s.directory = :dir OR s.directory LIKE :prefix ESCAPE '\\')`;
    params = { dir, prefix: escapeLike(dir) + '/%' };
    sessions = all(db, `SELECT ${SESSION_COLS}
      FROM session s LEFT JOIN model_usage mu ON mu.session_id = s.id
      WHERE ${where} GROUP BY s.id`, params);
    includesSubfolders = sessions.length > 0;
  }

  // Price per (session, model), then roll up per session / per model / total.
  const perModel = all(db, `SELECT
      s.id AS session_id, mu.model_id,
      count(*)                              AS requests,
      sum(mu.input_tokens)                  AS input_tokens,
      sum(mu.output_tokens)                 AS output_tokens,
      sum(mu.cache_read_input_tokens)       AS cache_read_tokens,
      sum(mu.computed_total_tokens)         AS total_tokens
    FROM session s JOIN model_usage mu ON mu.session_id = s.id
    WHERE ${where}
    GROUP BY s.id, mu.model_id`, params);

  const costBySession = new Map();
  const models = new Map();
  const total = { requests: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, total_tokens: 0, est_cost_usd: 0 };
  for (const r of perModel) {
    const c = estimateCostUsd(r.model_id, r) || 0;
    costBySession.set(r.session_id, (costBySession.get(r.session_id) || 0) + c);
    const m = models.get(r.model_id) || {
      model_id: r.model_id, requests: 0, input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, total_tokens: 0, est_cost_usd: 0,
    };
    m.requests += r.requests;
    m.input_tokens += r.input_tokens || 0;
    m.output_tokens += r.output_tokens || 0;
    m.cache_read_tokens += r.cache_read_tokens || 0;
    m.total_tokens += r.total_tokens || 0;
    m.est_cost_usd += c;
    models.set(r.model_id, m);
    total.requests += r.requests;
    total.input_tokens += r.input_tokens || 0;
    total.output_tokens += r.output_tokens || 0;
    total.cache_read_tokens += r.cache_read_tokens || 0;
    total.total_tokens += r.total_tokens || 0;
    total.est_cost_usd += c;
  }

  for (const s of sessions) s.est_cost_usd = costBySession.get(s.id) || 0;
  sessions.sort((a, b) => b.est_cost_usd - a.est_cost_usd);

  return {
    directory: dir,
    includes_subfolders: includesSubfolders,
    pricing: { as_of: PRICING_INFO.asOf, source: PRICING_INFO.source, currency: 'USD' },
    sessions,
    models: [...models.values()].sort((a, b) => b.est_cost_usd - a.est_cost_usd),
    total,
  };
}

/* ---------------- terminal report ---------------- */

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });
const usd = (v) => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' }) : '—');

function truncate(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function pad(s, w, right) {
  s = String(s);
  return s.length >= w ? s : right ? ' '.repeat(w - s.length) + s : s + ' '.repeat(w - s.length);
}

function formatCostReport(r, dbPath) {
  const L = [];
  L.push(`ZCode cost estimator`);
  L.push(`folder:  ${r.directory}${r.includes_subfolders ? '  (including subfolders)' : ''}`);
  L.push(`db:      ${dbPath} (read-only)`);
  L.push('');

  if (!r.sessions.length) {
    L.push('No ZCode sessions found for this folder.');
    return L.join('\n');
  }

  const rows = r.sessions.map((s) => ({
    title: truncate(s.title || s.slug || s.id, 44),
    type: s.task_type === 'subagent_child' ? 'subagent' : (s.task_type || '—'),
    created: shortDate(s.time_created),
    msgs: compact.format(s.messages || 0),
    req: compact.format(s.requests || 0),
    tokens: compact.format(s.total_tokens || 0),
    cost: usd(s.est_cost_usd),
  }));
  const headers = ['SESSION / TITLE', 'TYPE', 'CREATED', 'MSGS', 'REQ', 'TOKENS', 'EST. COST'];
  const W = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => Object.values(row)[i].length)) + 2);
  const line = (cells) => cells.map((c, i) => pad(c, W[i], i >= 3)).join('');

  L.push(line(headers));
  L.push(line(W.map((w) => '-'.repeat(w - 1) + ' ')));
  for (const row of rows) L.push(line(Object.values(row)));
  L.push('');

  L.push('By model:');
  for (const m of r.models) {
    L.push(
      `  ${pad(truncate(m.model_id, 28), 30)}${pad(compact.format(m.requests) + ' req', 10)}` +
      `in ${compact.format(m.input_tokens)} (cache ${compact.format(m.cache_read_tokens)}) ` +
      `out ${pad(compact.format(m.output_tokens), 6)} ${pad(usd(m.est_cost_usd), 12)}`
    );
  }
  L.push('');
  L.push(`TOTAL: ${r.sessions.length} session${r.sessions.length === 1 ? '' : 's'} · ${r.total.requests.toLocaleString()} requests · ` +
    `${compact.format(r.total.total_tokens)} tokens · est. ${usd(r.total.est_cost_usd)}`);
  L.push(`Estimates use Z.ai list prices as of ${r.pricing.as_of} (${r.pricing.source});`);
  L.push(`pay-as-you-go equivalent — a coding-plan subscription is billed separately.`);
  return L.join('\n');
}

module.exports = { estimateDirectoryCost, formatCostReport };
