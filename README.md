# zcode-stats

A read-only web dashboard for the local [ZCode](https://zcode.z.ai/en) CLI database
(`~/.zcode/cli/db/db.sqlite`). Zero dependencies — it runs on Node's built-in
`node:sqlite` module.

It extracts everything the database knows about your ZCode usage and shows it
as tables in a local web UI:

- **Activity chart** — a line/area chart of model usage over the **full data
  range** with selectable granularity (hourly · 3 hours · 6 hours · daily ·
  weekly; comfortably handles 720+ hourly points) and metric (total tokens,
  requests, output tokens, est. cost). Buckets align to your local clock
  (local hours, local midnight, Monday-aligned weeks), gaps render as
  zero-valued points, hovering any point shows its exact figures, and the
  granularity/metric choice is remembered.
- **Overview** — KPIs (sessions, messages, turns, model requests, tool calls,
  token totals), a daily activity chart, per-model / per-tool / per-project
  rollups, message roles, part types, todo statuses, ZCode versions used, and
  the schema-migration history.
- **Cost estimation** — every token aggregate is priced with Z.ai's official
  GLM list rates ([docs.z.ai pricing](https://docs.z.ai/guides/overview/pricing),
  built-in table, USD per 1M tokens): an "Est. spend" KPI, an `Est. cost`
  column in the models and projects tables, an `Est. cost ($)` chart metric,
  and `est_cost_usd` fields throughout `/api/stats`. Cache-read tokens (a
  subset of input tokens) bill at the cheaper cached rate; cache writes at the
  input rate. Unknown models are marked `n/a` instead of guessed, and the
  estimate reflects pay-as-you-go list prices — a coding-plan subscription is
  billed separately.
- **Tables** — a browser for **every table in the database** with all columns:
  - **Sortable** — click any column header (server-side in the browser,
    client-side on the overview tables).
  - **Filterable** — per-column substring filters under every header (AND-ed
    server-side) plus a global search box; overview tables have a per-panel
    filter input; a `Reset` button clears everything.
  - **Resizable** — drag the right edge of a header to resize a column; widths
    are remembered per table (localStorage), double-click the handle to reset.
  - Server-side pagination, epoch-ms columns rendered as dates, and JSON cells
    (`message.data`, `part.data`, …) viewable pretty-printed via a per-cell
    endpoint.

## Requirements

- Node.js **>= 22.5** (for the built-in `node:sqlite` module)

## Usage

```bash
# from this directory
npx .

# or install it globally
npm install -g .
zcode-stats

# once published
npx zcode-stats
```

Then open the printed URL (default `http://127.0.0.1:8765/t/<session-token>/`
— the random token in the path is generated per run). When you're
done, the **⏻ Stop** button in the top bar shuts the server down (with a
confirmation) and closes the tab, or falls back to a farewell screen if the
browser forbids script-closing it.

### CLI-only cost estimator

```bash
zcode-stats --cost-estimator   # alias: --cost
zcode-stats --cost --json      # machine-readable output
```

No server is started: it prints the estimated API cost of every ZCode session
("thread") belonging to the current folder — a per-thread table (sorted by
cost), a per-model breakdown with cache details, and the grand total. Sessions
are matched by exact working directory; if none match, it falls back to the
folder plus its subfolders. Costs use the same Z.ai list-price table as the
dashboard.

```
Usage: zcode-stats [options]

Options:
  --db <path>    Path to db.sqlite (default: ~/.zcode/cli/db/db.sqlite)
  --port <n>     Port to serve on, 0 for a random free port (default: 8765)
  --no-open      Do not open the browser automatically
  --version      Print version
  -h, --help     Show this help
```

## Read-only guarantee

The database is never written:

- the file is opened with SQLite's `readOnly` mode (writes fail with
  `attempt to write a readonly database`), and
- `PRAGMA query_only = ON` is set on the connection as a second lock.

The HTTP server binds to `127.0.0.1` only, and the query layer validates every
table and column identifier against the database schema before using it
(search text only ever appears in bound parameters). The tool is therefore safe
to run against a database that the ZCode CLI is actively using.

### Local-server isolation

Because the dashboard exposes your full session history, the server also
defends against remote web pages reaching it through your browser:

- **Host allowlist** — requests whose `Host` is not `127.0.0.1` / `localhost`
  are rejected, which blocks DNS-rebinding attacks that would otherwise make
  a malicious page same-origin with the dashboard.
- **Secret URL path** — every route (UI and API) lives under a per-session
  random `/t/<token>/` prefix; guessing the URL is impractical and the token
  is never served over the API. The ⏻ Stop button additionally sends it in an
  `x-shutdown-token` header, so a cross-origin page (which would need a CORS
  preflight this server never grants) cannot shut the server down.

## How it works

```
bin/zcode-stats.js   CLI: args, read-only open, server bootstrap, browser launch
src/db.js            read-only connection, schema discovery, safe table queries
src/stats.js         dashboard aggregates (tokens, models, tools, projects, …)
src/pricing.js       built-in Z.ai GLM price table + cost estimation
src/server.js        loopback HTTP server + JSON API
ui/index.html        single-file web UI (vanilla JS, no CDN dependencies)
```

API surface (all routes under the per-session `/t/<token>/` prefix):

| Route | Purpose |
| --- | --- |
| `GET /api/meta[?refresh=1]` | db info + every table with row counts & columns |
| `GET /api/stats` | all dashboard aggregates (incl. `byBucket` time series and cost estimates) |
| `GET /api/table/:name?page=&limit=&sort=&dir=&q=&f.<col>=` | paginated table rows (per-column filters via `f.<column>=text`) |
| `GET /api/cell/:table/:rowid/:column` | full untruncated cell value |
| `POST /api/shutdown` | stop the server (also requires the session token from the URL path in an `x-shutdown-token` header; used by the UI's Stop button) |

## License

MIT
