# 🧠 Company Brain

An AI-powered knowledge **and analytics** system. It connects a company's documentation, meeting notes, FAQs, policies, product info, support content and internal tools with its live product data in ClickHouse. Employees ask questions in plain English and get **cited, permission-aware, conflict-aware answers, with SQL-backed numbers and charts**.

The normal path to a data answer is a ticket to the data team and a dashboard days later. Here it's natural language → agent → data-analyst sub-agent → SQL on ClickHouse → chart and answer in seconds, with a full audit trail.

**Live demo:** https://ingestion.work (password protected; ask the team for the password)

Built with Node.js + TypeScript (no build step), ClickHouse, and Claude (`claude-opus-5-5` as the main agent, `claude-sonnet-5-5` as the SQL analyst sub-agent).

## Quick start

```bash
npm install
npm run db:install      # downloads the official ClickHouse binary into .clickhouse/ (no Docker)
cp .env.example .env    # add your ANTHROPIC_API_KEY
npm start               # http://localhost:3000 (starts ClickHouse and seeds ~38M events on first run, ~20s)
```

Without an API key the app still runs: search-only answers, the SQL console, the graph and everything else that doesn't need an LLM.

## Architecture

```
            ┌───────────────────────── Company Brain agent (Opus) ─────────────────────────┐
question ─▶ │ search_knowledge · read_document · explore_graph · remember · flag_gap        │ ─▶ cited answer
            │ analyze_data ──▶ Data-analyst sub-agent (Sonnet)                               │    + charts
            │                    list_tables · get_distinct_values · run_query · create_chart│    + audit trail
            └──────────────┬──────────────────────────────┬──────────────────────────────────┘
                     BM25 index + graph            ClickHouse (pulse.*)  ◀─ read-only, guarded, approval for heavy scans
                     (data/sources, graph.json)    ClickHouse (brain.*)  ◀─ traces, spans, feedback (observability)
```

| Capability | How |
|---|---|
| **Connectors** | Each folder in `data/sources/<type>/` is a source. Markdown/text becomes documents; JSON arrays become one doc per item. Add sources from the UI by pasting, uploading a file, or giving a URL. |
| **Agentic analytics** | The main agent delegates data questions to a **data-analyst sub-agent**. The sub-agent discovers the schema, checks real column values (catching messy data like `Dashboard Viewed` vs `dashboard_view`, or `USA` vs `US`), writes ClickHouse SQL, sanity-checks results and makes charts. |
| **Why ClickHouse** | Agents fire many small exploratory queries. Columnar storage + the sparse primary index (sort key `event_name, date, workspace`) answer them over 38M rows in roughly 10–100 ms. See the Data tab for compression stats. |
| **Context protection** | Query results stay server-side. The model sees only a 30-row preview and a result handle (`q3`); charts reference the handle, so big results never flood the context window. |
| **Skills** | Small context packets in `data/skills/*.md` (ClickHouse SQL practices and a metrics glossary acting as a semantic layer) load into the analyst's prompt. |
| **Human-in-the-loop** | Queries whose `EXPLAIN ESTIMATE` exceeds `APPROVAL_ROWS` (default 30M rows) pause the agent and show an Approve/Deny card mid-answer. Scheduled runs auto-deny. |
| **Guardrails** | Single read-only statements only. No writes, `system.*`, external table functions or `FORMAT`. ClickHouse also runs the query with `readonly=2`, plus row and time limits. |
| **Citations** | Document claims cite chunks (blue chips); numbers cite SQL queries (orange chips) that open the exact query and its result. |
| **Reports (artifact sharing)** | **Share report** publishes `/r/<id>` with the answer, charts and the full audit trail: every step, every SQL query with its results and scan stats, and every cited passage. |
| **Scheduled questions** | Cron-style questions (daily, weekly, hourly) run the full agent and publish a new report each time. |
| **Observability** | Every question is a trace in ClickHouse (`brain.traces`, `brain.spans`). Spans cover agent runs, generations (tokens, cost, time to first token) and tool calls, shown as a waterfall in the Traces tab. 👍/👎 feedback is stored with the trace. |
| **Conflicts, graph, permissions, memory, gaps** | Current beats superseded sources and conflicts are called out. A declared graph answers ownership and impact questions. `access:` frontmatter is enforced before retrieval. Personas tailor answers. The agent can remember user facts and flags knowledge gaps. |
| **MCP server** | `src/mcp.ts` exposes the brain to Claude Code, Claude Desktop or any MCP client: `search_knowledge`, `read_document`, `explore_graph`, `list_tables`, `run_select_query`, `ask_brain`. |

## Sample data (fictional "Acme")

Documents and data tell one consistent story, so the agent can connect *why* (docs) with *how much* (data):

| In the docs | In ClickHouse |
|---|---|
| Release 4.2 known issue: Android 15 crashes, fix in 4.3 | Crash rate on Android 15 + app 4.2 jumps from ~0.4% to ~1.8% on Sep 29 |
| INC-2291 billing outage (Sep 19), EUR/GBP invoices reissued | 791 voided + reissued September invoices; billing ticket spike |
| DI-4410 EU ingestion delays under investigation | `ingest_delay_ms` of 10–20 min for eu-central at peak hours since Oct 1 |
| Reports v1 deprecation, ~340 workspaces affected | ~340 workspaces using Reports v1, usage declining |
| Q4 goal: $48M ARR (currently $43.5M) | Active MRR × 12 ≈ $43.9M |

Data tables: `pulse.events` (~38M rows), `pulse.workspaces`, `pulse.invoices`, `pulse.support_tickets`. Re-seed or scale with `EVENTS=200000000 npm run db:seed`.

## Demo script (≈5 min)

1. **Data + docs:** "How bad is the Android crash rate since release 4.2, and is a fix planned?" The agent pulls the release notes, then the analyst explores the schema, runs SQL and draws a chart. Click an orange citation to see the SQL.
2. **Human-in-the-loop:** "How many unique users have we had in total, ever?" The analyst wants a full scan, so the agent pauses for approval.
3. **Cross-source investigation:** "How did the September billing incident show up in invoices and support tickets?"
4. **Share:** Click **Share report**, open the link and scroll through the audit trail.
5. **Schedule:** In Reports, schedule "Daily digest: crash rate, EU ingestion delay and support tickets vs last week", then click **Run now**.
6. **Observe:** Open the Traces tab to see the waterfall across both agents, with tokens, cost and approval wait time.
7. **Knowledge features:** per-diem conflict, Query Engine impact graph, salary bands as Engineer vs Manager, and a knowledge gap.
8. **MCP:** `claude mcp add company-brain -- node $(pwd)/src/mcp.ts`, then ask Claude Code to "use company-brain to find which plan has the most MRR".

## Knowledge backend: local or HydraDB

Knowledge retrieval is switchable with `KNOWLEDGE_BACKEND`:

| | `local` (default) | `hydradb` |
|---|---|---|
| Engine | In-process BM25 keyword search | [HydraDB](https://docs.hydradb.com) hybrid search (semantic + keyword) with graph context |
| Setup | none | `HYDRA_DB_API_KEY` in `.env`, then `npm run hydra:sync` |
| Graph | declared graph (`data/graph.json`) via `explore_graph` | same, plus HydraDB's auto-extracted relation paths appended to search results |

How it works (`src/hydra.ts`): each of our chunks is ingested as one HydraDB source with a stable id (`<doc>--<position>`) and filterable metadata (`kb_source_type`, `access`, `doc_id`, `doc_status`, `updated_on`). Queries filter by the persona's access groups and requested source types; every hit is mapped back to the local chunk, so citations, `read_document`, the superseded-policy logic and the UI work unchanged. Access is re-checked locally on every hit (HydraDB metadata filters are not an ACL). If HydraDB errors or returns nothing, search falls back to local BM25 and the search chip shows ⚠️ with the reason. Uploads made in the UI are ingested into HydraDB as well.

```bash
npm run hydra:sync                      # create database + schema, upsert all chunks, wait for indexing, test query
KNOWLEDGE_BACKEND=hydradb npm run eval  # A/B the answer eval against local search
```

On Vercel, add `KNOWLEDGE_BACKEND=hydradb` and `HYDRA_DB_API_KEY` to the environment.

## HR · People & Performance (Ascend import)

Real HR data from Ascend (Postgres on Neon) is imported into the ClickHouse `hr` database, **pseudonymised**:

```bash
# 1. Once: create the read-only, column-restricted role (Neon SQL Editor) — scripts/ascend-readonly-role.sql
# 2. .env: ASCEND_DATABASE_URL=postgresql://brain_readonly:…@<direct host>/neondb?sslmode=verify-full
npm run hr:import     # org structure, review cycles, reviews, per-question ratings, goals/KRs, feedback metadata, competencies
npm run db:users      # least-privilege ClickHouse users: brain_reader (no hr.*) and brain_hr_reader
```

- **Privacy by construction:** the Postgres role can't read emails, phones, birthdays, password hashes, tokens or any free text (feedback, review comments, written answers, calibration notes); every person gets a stable pseudonym (salted with `ASCEND_SALT`), and real names inside team names, titles and goal titles are replaced. Disconnect any time: `DROP OWNED BY brain_readonly; DROP ROLE brain_readonly;`
- **HR persona** ("HR · People & Performance") is the only persona whose data analyst can query `hr.*`, enforced by ClickHouse grants (`brain_hr_reader` vs `brain_reader`) and an app-level check; it loads `data/skills/hr-metrics.md` (definitions + privacy rules: aggregate first, no stats for groups under 5).
- **Org chart** (Graph tab) and the `org_lookup` agent tool expose structure only (names, titles, teams, managers) to every persona; ratings stay HR-only.
- **Production:** HR and the org chart stay hidden on Vercel until `HR_PASSWORD` is set there; then the HR persona asks for it as a second password.

## Deploy to Vercel

**Production:** https://ingestion.work (also https://company-brain-mu-steel.vercel.app). Every push to `main` deploys automatically (GitHub ↔ Vercel); other branches and pull requests get preview URLs, which are behind Vercel login plus the app password and share the production ClickHouse database.

The same handler runs as one Vercel Function (`api/index.ts`, all routes rewritten to it; see `vercel.json`). Vercel can't run the bundled ClickHouse binary, and its instances are short-lived, so production uses **ClickHouse Cloud**. All app state (reports, schedules, gaps, memory, uploads, pending approvals) lives in ClickHouse (`brain.state`), so any instance can serve any request, including an Approve click handled by a different instance than the one running the agent.

1. Create a ClickHouse Cloud service and put `CLICKHOUSE_URL` (`https://<host>:8443`), `CLICKHOUSE_USER` and `CLICKHOUSE_PASSWORD` in `.env`.
2. Seed it (data is generated server-side, ~30s): `npm run db:seed`
3. Set Vercel env vars: `ANTHROPIC_API_KEY`, the three `CLICKHOUSE_*`, `APP_PASSWORD` (shared login) and `CRON_SECRET` (any random string; Vercel Cron sends it).
4. Push to `main` (auto-deploys), or run `vercel deploy --prod` manually

Notes: functions run up to 300s (enough for long data questions + approvals). On the Hobby plan Vercel Cron runs at most daily, so `/api/cron` runs due scheduled questions every day at 08:00 UTC. With `APP_PASSWORD` set, every page and API call requires the login cookie.

## Connect via MCP

```bash
claude mcp add company-brain -- node /absolute/path/to/company-brain/src/mcp.ts
```

Set `MCP_PERSONA` (default `engineer`) to control which restricted documents MCP clients can see. `ask_brain` needs `ANTHROPIC_API_KEY` in `.env`; the other tools work without it.

## Tests & evals

```bash
npm test          # offline: retrieval, permissions, graph, SQL guardrails, planted data signals, schedules
npm run eval      # end-to-end answer checks against Claude, incl. data questions (needs API key)
npm run typecheck
```

`test/mock-anthropic.ts` is a scripted mock of the streaming Messages API. It's used to test the full pipeline (agent loops, sub-agent, approvals, tracing, charts, reports) without an API key. Start it, then run the app with `ANTHROPIC_BASE_URL=http://127.0.0.1:4010 ANTHROPIC_API_KEY=test`. Its answers are canned, so don't demo with it.

## Configuration (`.env`)

| Var | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Enables AI answers and data analysis |
| `ANTHROPIC_WORKSPACE_ID` | — | Only for keys not scoped to a workspace (sends the `anthropic-workspace-id` header) |
| `BRAIN_MODEL` / `BRAIN_EFFORT` | `claude-opus-5-5` / `medium` | Main agent |
| `ANALYST_MODEL` / `ANALYST_EFFORT` | `claude-sonnet-5-5` / `medium` | SQL sub-agent |
| `APPROVAL_ROWS` | `30000000` | Estimated rows above which a query needs approval |
| `CLICKHOUSE_URL` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` / `CLICKHOUSE_DB` | local / `default` / — / `pulse` | Point at ClickHouse Cloud or any server instead of the bundled binary |
| `KNOWLEDGE_BACKEND` | `local` | `local` or `hydradb` |
| `HYDRA_DB_API_KEY` / `HYDRA_DB_DATABASE` / `HYDRA_DB_COLLECTION` / `HYDRA_DB_MODE` | — / `company_brain` / `knowledge` / `fast` | HydraDB backend settings |
| `APP_PASSWORD` | — | Shared password login (required for public deployments) |
| `HR_PASSWORD` | — | Second password for the HR persona (required on Vercel for HR/org data) |
| `ASCEND_DATABASE_URL` / `ASCEND_SALT` | — | HR import source (read-only role) / pseudonym salt (auto-generated) |
| `CLICKHOUSE_READER_PASSWORD` / `CLICKHOUSE_HR_READER_PASSWORD` | — | Least-privilege users for agent SQL (`npm run db:users`) |
| `CRON_SECRET` | — | Authenticates Vercel Cron calls to `/api/cron` |
| `COMPANY_NAME`, `PORT`, `MCP_PERSONA`, `BRAIN_OFFLINE` | `Acme`, `3000`, `engineer`, — | |

## Project layout

```
src/app.ts         request handler: HTTP API, SSE streaming, approvals, auth gate (shared by local + Vercel)
src/server.ts      local entry: starts ClickHouse, seeds on first run, scheduler
api/index.ts       Vercel Function entry (same handler)
src/state.ts       persistent app state (ClickHouse brain.state, or local files)
src/auth.ts        shared-password login + cron auth
src/brain.ts       main agent (knowledge tools + analyze_data)
src/analyst.ts     data-analyst sub-agent (schema, values, SQL, charts) + skills loader
src/agent.ts       shared streaming tool-use loop with tracing
src/clickhouse.ts  HTTP client, SQL guardrails, EXPLAIN ESTIMATE, local server manager
src/trace.ts       traces/spans/feedback (ClickHouse or JSONL fallback), cost model
src/reports.ts     shareable reports with audit trail + scheduled questions
src/kb.ts          knowledge base: index, graph, personas/permissions, gaps, memory
src/ingest.ts      connectors + heading-aware chunking      src/search.ts  BM25
src/hydra.ts       HydraDB retrieval backend (KNOWLEDGE_BACKEND=hydradb)      scripts/hydra-sync.ts  sync knowledge to HydraDB
src/mcp.ts         MCP server (stdio)
scripts/seed.ts    deterministic synthetic analytics data   scripts/eval.ts  answer eval
web/               web UI (vanilla JS + Chart.js), report page, login page
data/              sources, graph.json, skills (runtime state is git-ignored)
```

All sample company data is fictional.
