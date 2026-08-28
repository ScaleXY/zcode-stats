'use strict';

const { all, get } = require('./db');
const { INFO: PRICING_INFO, lookupPricing, estimateCostUsd } = require('./pricing');

/** Attach estimated-cost fields to a per-model aggregate row. */
function withCost(row) {
  const cost = estimateCostUsd(row.model_id, row);
  const rates = lookupPricing(row.model_id);
  return {
    ...row,
    est_cost_usd: cost,
    rates: rates ? { input: rates.input, cacheRead: rates.cacheRead, output: rates.output, free: !!rates.free } : null,
  };
}

/**
 * Build the dashboard aggregates. Every block is independent and failure
 * tolerant: if the schema changes shape, the rest of the dashboard still
 * renders.
 */
function buildStats(db) {
  const blocks = {};
  const guard = (name, fn) => {
    try {
      const v = fn();
      if (v !== undefined) blocks[name] = v;
    } catch (err) {
      blocks[name] = { error: err.message };
    }
  };

  guard('modelTotals', () => {
    const totals = get(db, `SELECT
        count(*)                      AS requests,
        sum(input_tokens)             AS input_tokens,
        sum(output_tokens)            AS output_tokens,
        sum(reasoning_tokens)         AS reasoning_tokens,
        sum(cache_creation_input_tokens) AS cache_creation_tokens,
        sum(cache_read_input_tokens)  AS cache_read_tokens,
        sum(computed_total_tokens)    AS total_tokens,
        sum(duration_ms)              AS total_duration_ms,
        avg(duration_ms)              AS avg_duration_ms,
        avg(time_to_first_token_ms)   AS avg_ttft_ms,
        sum(status = 'error')         AS errors,
        sum(context_exceeded)         AS context_exceeded,
        sum(retry_count)              AS retries,
        sum(tool_call_count)          AS tool_calls,
        min(started_at)               AS first_activity_ms,
        max(completed_at)             AS last_activity_ms
      FROM model_usage`);
    // Cost is model-dependent: price each model's totals, then sum.
    const perModel = all(db, `SELECT
        model_id,
        sum(input_tokens)            AS input_tokens,
        sum(output_tokens)           AS output_tokens,
        sum(cache_read_input_tokens) AS cache_read_input_tokens
      FROM model_usage GROUP BY model_id`);
    let cost = 0;
    let covered = 0;
    for (const m of perModel) {
      const c = estimateCostUsd(m.model_id, m);
      if (c != null) {
        cost += c;
        covered += m.input_tokens || 0;
      }
    }
    totals.est_cost_usd = cost;
    totals.cost_coverage = totals.input_tokens ? covered / totals.input_tokens : 0;
    return totals;
  });

  guard('turnTotals', () =>
    get(db, `SELECT
        count(*)                    AS turns,
        avg(duration_ms)            AS avg_duration_ms,
        avg(time_to_first_token_ms) AS avg_ttft_ms,
        sum(model_request_count)    AS model_requests,
        sum(model_retry_count)      AS model_retries,
        sum(tool_call_count)        AS tool_calls,
        sum(tool_error_count)       AS tool_errors,
        sum(computed_total_tokens)  AS total_tokens
      FROM turn_usage`)
  );

  guard('models', () =>
    all(db, `SELECT
        provider_id,
        model_id,
        count(*)                     AS requests,
        sum(input_tokens)            AS input_tokens,
        sum(output_tokens)           AS output_tokens,
        sum(reasoning_tokens)        AS reasoning_tokens,
        sum(cache_creation_input_tokens) AS cache_creation_tokens,
        sum(cache_read_input_tokens) AS cache_read_tokens,
        sum(computed_total_tokens)   AS total_tokens,
        avg(duration_ms)             AS avg_duration_ms,
        avg(time_to_first_token_ms)  AS avg_ttft_ms,
        sum(status = 'error')        AS errors,
        max(started_at)              AS last_used_ms
      FROM model_usage
      GROUP BY provider_id, model_id
      ORDER BY requests DESC`).map(withCost)
  );

  guard('tools', () =>
    all(db, `SELECT
        tool_name,
        count(*)                AS calls,
        sum(status = 'error')   AS errors,
        avg(duration_ms)        AS avg_duration_ms,
        max(duration_ms)        AS max_duration_ms,
        sum(output_bytes)       AS output_bytes,
        sum(read_only)          AS read_only_calls,
        sum(destructive)        AS destructive_calls,
        max(started_at)         AS last_used_ms
      FROM tool_usage
      GROUP BY tool_name
      ORDER BY calls DESC`)
  );

  // Per-project rollup assembled from independent GROUP BYs (joining
  // message × model_usage in one query would double-count). Usage is grouped
  // by (project, model) so it can be priced per model before summing.
  guard('projects', () => {
    const sessions = all(db, `SELECT
        directory,
        count(*)                                   AS sessions,
        sum(task_type = 'interactive')             AS interactive,
        sum(task_type = 'subagent_child')          AS subagent_children,
        sum(task_type = 'fork')                    AS forks,
        max(time_updated)                          AS last_active_ms
      FROM session GROUP BY directory`);
    const messages = new Map(
      all(
        db,
        `SELECT s.directory AS d, count(m.id) AS c
           FROM message m JOIN session s ON s.id = m.session_id
          GROUP BY s.directory`
      ).map((r) => [r.d, r.c])
    );
    const usageByDir = new Map();
    let totalCost = 0;
    for (const r of all(
      db,
      `SELECT s.directory AS d,
              mu.model_id   AS m,
              count(*)                     AS requests,
              sum(mu.input_tokens)         AS input_tokens,
              sum(mu.output_tokens)        AS output_tokens,
              sum(mu.cache_read_input_tokens) AS cache_read_tokens,
              sum(mu.computed_total_tokens) AS total_tokens
         FROM model_usage mu JOIN session s ON s.id = mu.session_id
        GROUP BY s.directory, mu.model_id`
    )) {
      const acc = usageByDir.get(r.d) || { requests: 0, output_tokens: 0, total_tokens: 0, cost: 0 };
      acc.requests += r.requests;
      acc.output_tokens += r.output_tokens || 0;
      acc.total_tokens += r.total_tokens || 0;
      const c = estimateCostUsd(r.m, r);
      if (c != null) acc.cost += c;
      totalCost += c || 0;
      usageByDir.set(r.d, acc);
    }
    return sessions.map((s) => {
      const u = usageByDir.get(s.directory) || {};
      return {
        ...s,
        messages: messages.get(s.directory) || 0,
        requests: u.requests || 0,
        output_tokens: u.output_tokens || 0,
        total_tokens: u.total_tokens || 0,
        est_cost_usd: u.cost || 0,
      };
    });
  });

  guard('byDay', () =>
    all(db, `SELECT
        date(started_at / 1000, 'unixepoch') AS day,
        count(*)                             AS requests,
        sum(computed_total_tokens)           AS total_tokens,
        sum(output_tokens)                   AS output_tokens
      FROM model_usage
      GROUP BY day
      ORDER BY day`)
  );

  // All chart granularities in one pass over the per-request rows.
  // Buckets align to local time: hour/3h/6h to local clock boundaries,
  // daily to local midnight, weekly to local Monday.
  guard('byBucket', () => {
    const blockFloor = (h) => (ts) => {
      const d = new Date(ts);
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() - (d.getHours() % h));
      return d.getTime();
    };
    const dayStart = (ts) => {
      const d = new Date(ts);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    };
    const weekStart = (ts) => {
      const d = new Date(ts);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
      return d.getTime();
    };
    const defs = {
      hourly: blockFloor(1),
      h3: blockFloor(3),
      h6: blockFloor(6),
      daily: dayStart,
      weekly: weekStart,
    };
    const acc = {};
    for (const g of Object.keys(defs)) acc[g] = new Map();

    for (const r of all(
      db,
      `SELECT started_at, model_id, input_tokens, output_tokens,
              cache_read_input_tokens, computed_total_tokens
         FROM model_usage`
    )) {
      const ts = Number(r.started_at);
      if (!Number.isFinite(ts)) continue;
      const cost = estimateCostUsd(r.model_id, r) || 0;
      const tok = Number(r.computed_total_tokens || 0);
      const out = Number(r.output_tokens || 0);
      for (const [g, fn] of Object.entries(defs)) {
        const t = fn(ts);
        let b = acc[g].get(t);
        if (!b) {
          b = { t, requests: 0, total_tokens: 0, output_tokens: 0, cost_usd: 0 };
          acc[g].set(t, b);
        }
        b.requests += 1;
        b.total_tokens += tok;
        b.output_tokens += out;
        b.cost_usd += cost;
      }
    }
    const out = {};
    for (const [g, m] of Object.entries(acc)) {
      out[g] = [...m.values()].sort((a, b) => a.t - b.t);
    }
    return out;
  });

  guard('messagesByRole', () =>
    all(db, `SELECT json_extract(data, '$.role') AS role, count(*) AS c
      FROM message GROUP BY role ORDER BY c DESC`)
  );

  guard('partsByType', () =>
    all(db, `SELECT json_extract(data, '$.type') AS type, count(*) AS c
      FROM part GROUP BY type ORDER BY c DESC`)
  );

  guard('sessionsByTaskType', () =>
    all(db, `SELECT task_type, count(*) AS c FROM session GROUP BY task_type ORDER BY c DESC`)
  );

  guard('sessionsByVersion', () =>
    all(db, `SELECT version, count(*) AS c, min(time_created) AS first_ms, max(time_updated) AS last_ms
      FROM session GROUP BY version ORDER BY first_ms`)
  );

  guard('inputHistoryByKind', () =>
    all(db, `SELECT kind, count(*) AS c FROM input_history GROUP BY kind ORDER BY c DESC`)
  );

  guard('sessionInputByStatus', () =>
    all(db, `SELECT status, count(*) AS c FROM session_input GROUP BY status ORDER BY c DESC`)
  );

  guard('todosByStatus', () =>
    all(db, `SELECT status, count(*) AS c FROM todo GROUP BY status ORDER BY c DESC`)
  );

  guard('migrations', () =>
    all(db, `SELECT id, app_version, time_applied
      FROM schema_migration ORDER BY time_applied`)
  );

  guard('pricing', () => ({ ...PRICING_INFO }));

  return { generatedAt: Date.now(), ...blocks };
}

module.exports = { buildStats };
