// Data analyst sub-agent: turns a natural-language data question into ClickHouse SQL.
// It explores the schema, checks real column values, runs read-only queries (with human approval
// for heavy scans) and creates charts. Full results stay server-side; the model only sees previews,
// which keeps its context small no matter how big the result is.
import fs from "node:fs";
import path from "node:path";
import * as ch from "./clickhouse.ts";
import { DATA_DIR } from "./kb.ts";
import { runAgent, tool, type Effort, type ToolOutput } from "./agent.ts";
import type { Trace } from "./trace.ts";

export const ANALYST_MODEL = process.env.ANALYST_MODEL ?? "claude-sonnet-5-5";
const ANALYST_EFFORT = (process.env.ANALYST_EFFORT ?? "medium") as Effort;
const APPROVAL_ROWS = Number(process.env.APPROVAL_ROWS ?? 30_000_000);
const PREVIEW_ROWS = 30;
const KEEP_ROWS = 5000;
const SKILLS_DIR = path.join(DATA_DIR, "skills");

export interface QueryRecord {
  id: string;
  sql: string;
  purpose: string;
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
  rowsRead: number;
  bytesRead: number;
  estimatedRows?: number | null;
  approval?: "auto" | "approved" | "denied";
  error?: string;
}

export interface ChartRecord {
  id: string;
  queryId: string;
  type: "line" | "bar" | "stacked_bar" | "area" | "table" | "number";
  title: string;
  x: string;
  y: string[];
  series?: string;
  unit?: string;
}

/** Everything one question produced: the audit trail for reports. */
export class Session {
  queries: QueryRecord[] = [];
  charts: ChartRecord[] = [];
  query(id: string) {
    return this.queries.find((q) => q.id === id);
  }
}

export interface ApprovalRequest {
  sql: string;
  purpose: string;
  estimatedRows: number;
}

export interface DataContext {
  session: Session;
  trace: Trace;
  parentSpanId: string;
  signal?: AbortSignal;
  emit: (event: string, data: unknown) => void;
  requestApproval: (req: ApprovalRequest) => Promise<boolean>;
  /** Databases this persona may query (enforced in the app and, when configured, by ClickHouse grants). */
  databases: string[];
}

const credsFor = (databases: string[]) => ch.readerCredentials(databases.includes("hr"));

/** Skills are context packets for the analyst; `hr-*.md` skills load only for personas with HR data access. */
export function loadSkills(databases: string[] = [ch.ANALYTICS_DB, "hr"]): { name: string; content: string }[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs
    .readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith(".md") && (!f.startsWith("hr-") || databases.includes("hr")))
    .sort()
    .map((f) => ({ name: f.replace(/\.md$/, ""), content: fs.readFileSync(path.join(SKILLS_DIR, f), "utf8").trim() }));
}

function systemPrompt(databases: string[]): string {
  const skills = loadSkills(databases)
    .map((s) => `<skill name="${s.name}">\n${s.content}\n</skill>`)
    .join("\n\n");
  const dbs = databases.filter((d) => d !== "brain");
  return `You are the data analyst sub-agent of Ingestion, the company's knowledge and analytics brain. You answer one data question by querying ClickHouse and report back concise, verified findings to the main agent.

You may query these databases: ${dbs.map((d) => `\`${d}\``).join(", ")} (plus brain.traces/spans/feedback about Ingestion's own usage). Any other database is off-limits for this user; if the question needs it, say you don't have access.

Workflow:
1. Call list_tables to learn the schema (tables, columns, comments, row counts) unless you already know it in this conversation.
2. Before filtering or grouping on a string column, call get_distinct_values to see the real values. Data is messy: legacy spellings, inconsistent casing and duplicate names for the same concept exist. Include all variants that mean the same thing, and mention any data-quality issue you found.
3. Write efficient ClickHouse SQL with run_query: always fully qualify tables (${ch.ANALYTICS_DB}.events), filter on time ranges, aggregate in SQL instead of pulling raw rows, and add LIMIT. Prefer one well-designed query over many small ones.
4. Sanity-check surprising numbers with a second query (e.g. check the denominator, a different time window, or a breakdown).
5. When a trend, comparison or breakdown would help, call create_chart on a query result (time series -> line; categories -> bar; parts of a whole over time -> stacked_bar). One or two charts is usually enough. Never use two y-axes: chart measures with different units separately. \`series\` is a single column: if series should differ by two dimensions (e.g. platform and app_version), build one label column in SQL, e.g. \`concat(platform, ' ', app_version) AS segment\`.
6. If a query is denied by the user, don't retry the same scan; narrow it (shorter time range, filter on event_name, sample) or explain what you could not check.

Final answer (to the main agent, not the end user): 3-8 bullet points with the key numbers, each followed by the query id that produced it in square brackets, e.g. "Crash rate on Android 15 + app 4.2 is 1.81% [q2]". Then one line listing data caveats (definitions used, data-quality issues, time range). Do not invent numbers that no query returned.

${skills}`;
}

const TOOLS = [
  tool("list_tables", "List the tables you may query, with row counts, sort keys and all column names, types and comments.", {}, []),
  tool(
    "get_distinct_values",
    "Show the most frequent values of a column (with counts). Use before filtering on any string column to catch non-standard values.",
    {
      table: { type: "string", description: "Table name, e.g. events (pulse) or hr.employees" },
      column: { type: "string" },
      where: { type: "string", description: "Optional SQL WHERE condition to narrow the scan, e.g. \"event_time >= '2026-09-01'\"" },
      limit: { type: "integer", description: "Max values (default 30)" },
    },
    ["table", "column"],
  ),
  tool(
    "run_query",
    "Run one read-only ClickHouse SQL query (SELECT/WITH). Returns a query id (q1, q2…), stats and up to 30 preview rows. The full result (up to 5,000 rows) is kept server-side for charts.",
    {
      sql: { type: "string" },
      purpose: { type: "string", description: "One short sentence: what this query checks (shown to the user in the audit trail)." },
    },
    ["sql", "purpose"],
  ),
  tool(
    "create_chart",
    "Render a chart for the user from a previous query result. Columns must exist in that result.",
    {
      query_id: { type: "string", description: "e.g. q3" },
      type: { type: "string", enum: ["line", "bar", "stacked_bar", "area", "table", "number"] },
      title: { type: "string" },
      x: { type: "string", description: "Column for the x axis / categories" },
      y: { type: "array", items: { type: "string" }, description: "Numeric column(s) to plot (same unit)" },
      series: { type: "string", description: "Optional column whose values become separate series (long format)" },
      unit: { type: "string", description: "Optional unit label, e.g. %, USD, ms" },
    },
    ["query_id", "type", "title", "x", "y"],
  ),
];

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

function preview(r: { columns: { name: string }[]; rows: Record<string, unknown>[] }, n = PREVIEW_ROWS): string {
  const cols = r.columns.map((c) => c.name);
  return [cols.join("\t"), ...r.rows.slice(0, n).map((row) => cols.map((c) => fmt(row[c])).join("\t"))].join("\n");
}

const human = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

const schemaCache = new Map<string, { at: number; text: string }>();

async function runTool(name: string, input: Record<string, unknown>, ctx: DataContext): Promise<ToolOutput> {
  switch (name) {
    case "list_tables": {
      const key = ctx.databases.join(",");
      let cached = schemaCache.get(key);
      if (!cached || Date.now() - cached.at > 60_000) {
        const tables = await ch.listTables(ctx.databases.filter((d) => d !== "brain"));
        const text = tables
          .map(
            (t) =>
              `## ${t.database}.${t.table} (${t.rows.toLocaleString()} rows; sort key: ${t.sortingKey || "none"})\n${t.comment}\n` +
              t.columns.map((c) => `- ${c.name} ${c.type}${c.comment ? ` -- ${c.comment}` : ""}`).join("\n"),
          )
          .join("\n\n");
        cached = { at: Date.now(), text };
        schemaCache.set(key, cached);
      }
      ctx.emit("step", { kind: "schema", label: "Explored schema" });
      return { content: cached.text };
    }
    case "get_distinct_values": {
      const [dbPart, tablePart] = String(input.table ?? "").includes(".") ? String(input.table).split(".", 2) : [ch.ANALYTICS_DB, String(input.table ?? "")];
      const db = dbPart;
      const table = tablePart;
      const column = String(input.column ?? "");
      if (!ch.isSafeIdentifier(db) || !ch.isSafeIdentifier(table) || !ch.isSafeIdentifier(column)) return { content: "Error: invalid table or column name.", isError: true };
      const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 200);
      const where = typeof input.where === "string" && input.where.trim() ? ` WHERE ${input.where}` : "";
      const sql = `SELECT ${column} AS value, count() AS n FROM ${db}.${table}${where} GROUP BY value ORDER BY n DESC LIMIT ${limit}`;
      const invalid = ch.validateReadOnly(sql) ?? ch.checkDatabaseAccess(sql, ctx.databases);
      if (invalid) return { content: `Error: ${invalid}`, isError: true };
      const r = await ch.query(sql, { maxRows: limit, signal: ctx.signal, creds: credsFor(ctx.databases) });
      ctx.emit("step", { kind: "values", label: `Checked values of ${table}.${column}` });
      return { content: `${r.rowCount} distinct values shown (read ${human(r.rowsRead)} rows in ${r.elapsedMs} ms)\n${preview(r, limit)}` };
    }
    case "run_query": {
      const sql = String(input.sql ?? "").trim().replace(/;\s*$/, "");
      const purpose = String(input.purpose ?? "").trim();
      const invalid = ch.validateReadOnly(sql) ?? ch.checkDatabaseAccess(sql, ctx.databases);
      if (invalid) return { content: `Error: ${invalid}`, isError: true };
      const id = `q${ctx.session.queries.length + 1}`;
      const rec: QueryRecord = { id, sql, purpose, columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0, rowsRead: 0, bytesRead: 0 };

      rec.estimatedRows = await ch.estimateRows(sql, credsFor(ctx.databases));
      if (rec.estimatedRows && rec.estimatedRows > APPROVAL_ROWS) {
        const ok = await ctx.requestApproval({ sql, purpose, estimatedRows: rec.estimatedRows });
        rec.approval = ok ? "approved" : "denied";
        if (!ok) {
          rec.error = "Denied by user";
          ctx.session.queries.push(rec);
          ctx.emit("query", { ...rec, rows: [] });
          return {
            content: `Query ${id} was NOT run: the user denied it (it would scan ~${human(rec.estimatedRows)} rows). Narrow it (shorter time range, an event_name filter, or uniq() instead of uniqExact()) or explain what you couldn't check.`,
            isError: true,
          };
        }
      } else {
        rec.approval = "auto";
      }

      try {
        const r = await ch.query(sql, { maxRows: KEEP_ROWS, signal: ctx.signal, creds: credsFor(ctx.databases) });
        Object.assign(rec, { columns: r.columns, rows: r.rows, rowCount: r.rowCount, truncated: r.truncated, elapsedMs: r.elapsedMs, rowsRead: r.rowsRead, bytesRead: r.bytesRead });
      } catch (err) {
        rec.error = (err as Error).message;
      }
      ctx.session.queries.push(rec);
      ctx.emit("query", { ...rec, rows: rec.rows.slice(0, 100) });
      if (rec.error) return { content: `Query ${id} failed: ${rec.error}`, isError: true };
      return {
        content:
          `${id}: ${rec.rowCount.toLocaleString()} rows${rec.truncated ? " (truncated)" : ""}; scanned ${human(rec.rowsRead)} rows / ${human(rec.bytesRead)}B in ${rec.elapsedMs} ms\n` +
          `columns: ${rec.columns.map((c) => `${c.name} (${c.type})`).join(", ")}\n` +
          preview(rec) +
          (rec.rowCount > PREVIEW_ROWS ? `\n… ${rec.rowCount - PREVIEW_ROWS} more rows kept server-side (usable in create_chart)` : ""),
      };
    }
    case "create_chart": {
      const q = ctx.session.query(String(input.query_id ?? ""));
      if (!q || q.error) return { content: `Error: no successful query with id ${input.query_id}.`, isError: true };
      const cols = new Set(q.columns.map((c) => c.name));
      const y = Array.isArray(input.y) ? input.y.map(String) : [String(input.y ?? "")];
      const x = String(input.x ?? "");
      const series = input.series ? String(input.series) : undefined;
      const missing = [x, ...y, ...(series ? [series] : [])].filter((c) => !cols.has(c));
      if (missing.length) return { content: `Error: columns not in ${q.id}: ${missing.join(", ")}. Available: ${[...cols].join(", ")}`, isError: true };
      const type = (["line", "bar", "stacked_bar", "area", "table", "number"].includes(String(input.type)) ? input.type : "bar") as ChartRecord["type"];
      const chart: ChartRecord = { id: `ch${ctx.session.charts.length + 1}`, queryId: q.id, type, title: String(input.title ?? q.purpose), x, y, series, unit: input.unit ? String(input.unit) : undefined };
      ctx.session.charts.push(chart);
      ctx.emit("chart", { ...chart, columns: q.columns, rows: q.rows.slice(0, 2000) });
      return { content: `Chart ${chart.id} is now displayed to the user.` };
    }
    default:
      return { content: `Error: unknown tool ${name}`, isError: true };
  }
}

/** Runs the analyst sub-agent on one question and returns its findings for the main agent. */
export async function analyzeData(question: string, ctx: DataContext): Promise<ToolOutput> {
  if (!(await ch.waitForServer())) return { content: "The analytics database (ClickHouse) is not reachable, so data questions can't be answered right now.", isError: true };
  ctx.emit("step", { kind: "analyst", label: `Data analyst: ${question}` });
  const before = ctx.session.queries.length;
  const result = await runAgent(
    {
      name: "data-analyst",
      model: ANALYST_MODEL,
      effort: ANALYST_EFFORT,
      system: systemPrompt(ctx.databases),
      tools: TOOLS,
      maxTurns: 14,
      runTool: (name, input) => runTool(name, input, ctx),
    },
    [{ role: "user", content: question }],
    { trace: ctx.trace, parentSpanId: ctx.parentSpanId, signal: ctx.signal },
  );
  const used = ctx.session.queries.slice(before).filter((q) => !q.error).map((q) => `${q.id}: ${q.purpose}`);
  return { content: `${result.text.trim() || "(no findings)"}\n\nQueries run: ${used.join("; ") || "none"}` };
}

/** Direct SQL for the Data tab console (same safety rules, no agent). */
export async function runConsoleQuery(sql: string, databases: string[]) {
  const invalid = ch.validateReadOnly(sql) ?? ch.checkDatabaseAccess(sql, databases);
  if (invalid) throw new Error(invalid);
  return ch.query(sql.trim().replace(/;\s*$/, ""), { maxRows: 1000, creds: credsFor(databases) });
}
