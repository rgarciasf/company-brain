// ClickHouse access over the HTTP interface (no driver needed), plus a local server manager
// that starts the bundled binary in .clickhouse/ when no server is running.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The project root is assembled at runtime (not via a static path.join) so deployment file tracers
// (e.g. Vercel's) don't treat the whole project, including the 700 MB local binary, as an asset.
const ROOT = [path.dirname(fileURLToPath(import.meta.url)), ".."].join(path.sep);
const CH_DIR = path.resolve(ROOT, process.env.CLICKHOUSE_HOME ?? ".clickhouse");
const CH_BIN = path.resolve(CH_DIR, "clickhouse");

export const CH_URL = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const CH_USER = process.env.CLICKHOUSE_USER ?? "default";
const CH_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "";
export const ANALYTICS_DB = process.env.CLICKHOUSE_DB ?? "pulse";

export interface QueryStats {
  elapsedMs: number;
  rowsRead: number;
  bytesRead: number;
}

export interface QueryResult extends QueryStats {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export class ClickHouseError extends Error {}

export interface Credentials {
  user: string;
  password: string;
}

function authHeaders(creds?: Credentials): Record<string, string> {
  return { "X-ClickHouse-User": creds?.user ?? CH_USER, "X-ClickHouse-Key": creds?.password ?? CH_PASSWORD };
}

/**
 * Least-privilege credentials for agent queries (created by `npm run db:users`):
 * brain_reader can read pulse.* and the agent's own traces; brain_hr_reader can also read hr.*.
 * Returns undefined when not configured (local dev), in which case the admin user is used and
 * only the application-level database check applies.
 */
export function readerCredentials(includeHr: boolean): Credentials | undefined {
  const password = includeHr ? process.env.CLICKHOUSE_HR_READER_PASSWORD : process.env.CLICKHOUSE_READER_PASSWORD;
  return password ? { user: includeHr ? "brain_hr_reader" : "brain_reader", password } : undefined;
}

/** Run a statement. `settings` are passed as URL params (ClickHouse settings). */
export async function exec(
  sql: string,
  settings: Record<string, string | number> = {},
  signal?: AbortSignal,
  params: Record<string, string | number> = {},
  creds?: Credentials,
): Promise<string> {
  const url = new URL(CH_URL);
  // Always UTC, so local and ClickHouse Cloud servers interpret dates identically.
  url.searchParams.set("session_timezone", "UTC");
  for (const [k, v] of Object.entries(settings)) url.searchParams.set(k, String(v));
  // Server-side query parameters: reference as {name:Type} in SQL (no string interpolation).
  for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, String(v));
  const res = await fetch(url, { method: "POST", body: sql, headers: authHeaders(creds), signal });
  const text = await res.text();
  if (!res.ok) throw new ClickHouseError(text.trim().split("\n")[0].slice(0, 600));
  return text;
}

/** Run a SELECT and return typed JSON rows. */
export async function query(
  sql: string,
  opts: { maxRows?: number; readonly?: boolean; timeoutSec?: number; signal?: AbortSignal; params?: Record<string, string | number>; creds?: Credentials } = {},
): Promise<QueryResult> {
  const maxRows = opts.maxRows ?? 10_000;
  const settings: Record<string, string | number> = {
    default_format: "JSON",
    max_result_rows: maxRows,
    result_overflow_mode: "break",
    max_execution_time: opts.timeoutSec ?? 30,
    output_format_json_quote_64bit_integers: 0,
    output_format_json_quote_decimals: 0,
  };
  if (opts.readonly !== false) settings.readonly = 2;
  const started = Date.now();
  const json = JSON.parse(await exec(sql, settings, opts.signal, opts.params, opts.creds)) as {
    meta: { name: string; type: string }[];
    data: Record<string, unknown>[];
    rows: number;
    rows_before_limit_at_least?: number;
    statistics?: { elapsed: number; rows_read: number; bytes_read: number };
  };
  return {
    columns: json.meta,
    rows: json.data,
    rowCount: json.rows,
    truncated: json.rows >= maxRows,
    elapsedMs: json.statistics ? Math.round(json.statistics.elapsed * 1000) : Date.now() - started,
    rowsRead: json.statistics?.rows_read ?? 0,
    bytesRead: json.statistics?.bytes_read ?? 0,
  };
}

export async function insertJson(table: string, rows: object[]): Promise<void> {
  if (!rows.length) return;
  await exec(`INSERT INTO ${table} FORMAT JSONEachRow\n` + rows.map((r) => JSON.stringify(r)).join("\n"), { date_time_input_format: "best_effort" });
}

export async function ping(timeoutMs = 4000): Promise<boolean> {
  try {
    const res = await fetch(new URL("/ping", CH_URL), { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** How long to wait for a remote server: an idle ClickHouse Cloud service takes ~15 s to wake. */
export const WAKE_TIMEOUT_MS = Number(process.env.CLICKHOUSE_WAKE_TIMEOUT_MS ?? 45_000);

/**
 * Ping until the server answers or `timeoutMs` passes. A remote (Cloud) server gets the full wake
 * window; a local default URL only gets one quick ping, since nothing will wake it.
 */
export async function waitForServer(timeoutMs = process.env.CLICKHOUSE_URL ? WAKE_TIMEOUT_MS : 0): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await ping(Math.min(10_000, Math.max(deadline - Date.now(), 4000)))) return true;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  } while (Date.now() < deadline);
  return false;
}

/** On Vercel the file fallback isn't shared between instances, so an unreachable server must fail loudly. */
export function requireReachable(): boolean {
  return !!process.env.VERCEL;
}

// ---------------- SQL safety ----------------

const ALLOWED_START = /^\s*(\(\s*)*(select|with|show|describe|desc|explain)\b/i;
const FORBIDDEN = /\b(insert|alter|drop|truncate|create|rename|attach|detach|optimize|grant|revoke|kill|system|set|delete|update|exchange|undrop)\b/i;
const FORBIDDEN_FUNCS = /\b(url|file|s3|s3cluster|hdfs|mysql|postgresql|remote|remoteSecure|executable|azureBlobStorage|input|jdbc|odbc|mongodb|redis|sqlite)\s*\(/i;

/** Agent queries must be single read-only statements that don't touch external systems. */
export function validateReadOnly(sql: string): string | null {
  const stripped = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/'(?:[^'\\]|\\.)*'/g, "''").trim().replace(/;\s*$/, "");
  if (!stripped) return "Empty query.";
  if (stripped.includes(";")) return "Only one statement per query is allowed.";
  if (!ALLOWED_START.test(stripped)) return "Only SELECT / WITH / SHOW / DESCRIBE / EXPLAIN queries are allowed.";
  if (FORBIDDEN.test(stripped.replace(/^\s*explain\b/i, ""))) return "Query contains a write/admin keyword, which is not allowed.";
  if (FORBIDDEN_FUNCS.test(stripped)) return "Table functions that reach external systems are not allowed.";
  if (/\bformat\s+\w+\s*$/i.test(stripped)) return "Don't specify FORMAT; results are returned as JSON automatically.";
  return null;
}

/** Estimated rows a query would read (EXPLAIN ESTIMATE); null if it can't be estimated. */
export async function estimateRows(sql: string, creds?: Credentials): Promise<number | null> {
  if (!/^\s*(select|with|\()/i.test(sql)) return null;
  try {
    const r = await query(`EXPLAIN ESTIMATE ${sql.replace(/;\s*$/, "")}`, { maxRows: 100, timeoutSec: 10, creds });
    return r.rows.reduce((sum, row) => sum + Number(row.rows ?? 0), 0);
  } catch {
    return null;
  }
}

// ---------------- Schema helpers ----------------

export async function listTables(databases: string[] = [ANALYTICS_DB]) {
  const params = { dbs: `[${databases.map((d) => `'${d.replace(/[^A-Za-z0-9_]/g, "")}'`).join(",")}]` };
  const r = await query(
    `SELECT database, name, comment, total_rows, total_bytes, engine, sorting_key
     FROM system.tables WHERE has({dbs:Array(String)}, database) AND NOT is_temporary ORDER BY database, name`,
    { params },
  );
  const cols = await query(`SELECT database, table, name, type, comment FROM system.columns WHERE has({dbs:Array(String)}, database) ORDER BY database, table, position`, {
    params,
    maxRows: 100_000,
  });
  return r.rows.map((t) => ({
    database: String(t.database),
    table: String(t.name),
    comment: String(t.comment ?? ""),
    rows: Number(t.total_rows ?? 0),
    bytesOnDisk: Number(t.total_bytes ?? 0),
    sortingKey: String(t.sorting_key ?? ""),
    columns: cols.rows
      .filter((c) => c.database === t.database && c.table === t.name)
      .map((c) => ({ name: String(c.name), type: String(c.type), comment: String(c.comment ?? "") })),
  }));
}

/** `db.table` pairs a query references (also matches alias.column; callers filter by known databases). */
export function qualifiedNames(sql: string): { db: string; table: string }[] {
  const stripped = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const out: { db: string; table: string }[] = [];
  for (const m of stripped.matchAll(/[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?\s*\.\s*[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?/g)) out.push({ db: m[1], table: m[2] });
  return out;
}

const KNOWN_DATABASES = new Set(["pulse", "hr", "brain", "system", "default", "information_schema"]);
const BRAIN_READABLE = new Set(["traces", "spans", "feedback"]);

/** Application-level access check: only allowed databases (and only the agent's own trace tables in `brain`). */
export function checkDatabaseAccess(sql: string, allowed: string[]): string | null {
  for (const { db, table } of qualifiedNames(sql)) {
    const d = db.toLowerCase();
    if (!KNOWN_DATABASES.has(d) && d !== ANALYTICS_DB) continue; // alias.column, not a database
    if (d === "brain" && BRAIN_READABLE.has(table) && allowed.includes("brain")) continue;
    if (d !== "brain" && allowed.includes(d)) continue;
    return `Access to ${db}.${table} is not allowed for this user. Allowed databases: ${allowed.filter((a) => a !== "brain").join(", ")}${allowed.includes("brain") ? " (and brain.traces/spans/feedback)" : ""}.`;
  }
  return null;
}

export async function storageStats() {
  const r = await query(
    `SELECT table, sum(rows) AS rows, sum(data_compressed_bytes) AS compressed, sum(data_uncompressed_bytes) AS uncompressed
     FROM system.parts WHERE database = '${ANALYTICS_DB}' AND active GROUP BY table ORDER BY rows DESC`,
  );
  return r.rows.map((x) => ({ table: String(x.table), rows: Number(x.rows), compressed: Number(x.compressed), uncompressed: Number(x.uncompressed) }));
}

export function isSafeIdentifier(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

// ---------------- Local server management ----------------

let child: ChildProcess | null = null;

export function hasLocalBinary(): boolean {
  return fs.existsSync(CH_BIN);
}

/** Make sure a ClickHouse server is reachable; start the bundled binary if needed. */
export async function ensureServer(log = console.log): Promise<boolean> {
  if (await waitForServer()) return true;
  if (process.env.CLICKHOUSE_URL || !hasLocalBinary()) return false;
  const dataDir = path.join(CH_DIR, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  log("   Starting local ClickHouse server…");
  child = spawn(
    CH_BIN,
    [
      "server",
      "--",
      `--path=${dataDir}/`,
      "--http_port=8123",
      "--tcp_port=9000",
      "--listen_host=127.0.0.1",
      "--timezone=UTC",
      "--mysql_port=",
      "--postgresql_port=",
      `--logger.log=${path.join(CH_DIR, "server.log")}`,
      `--logger.errorlog=${path.join(CH_DIR, "server.err.log")}`,
      "--logger.level=warning",
      "--logger.console=0",
    ],
    { cwd: dataDir, stdio: "ignore", detached: false },
  );
  child.on("exit", (code) => {
    if (code) console.warn(`[clickhouse] server exited with code ${code} (see .clickhouse/server.err.log)`);
    child = null;
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await ping()) return true;
  }
  return false;
}

export function stopServer() {
  child?.kill("SIGTERM");
}

export async function databaseExists(): Promise<boolean> {
  try {
    const r = await query(`SELECT count() AS n FROM system.tables WHERE database = '${ANALYTICS_DB}' AND name = 'events'`);
    return Number(r.rows[0]?.n) > 0;
  } catch {
    return false;
  }
}
