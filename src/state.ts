// Small persistent key-value store for app state: reports, schedules, knowledge gaps, memory,
// uploaded sources and pending approvals. Uses the ClickHouse table brain.state when reachable
// (required on serverless hosts like Vercel, where the filesystem is ephemeral and requests can
// land on different instances); otherwise JSON files under data/state/<namespace>/.
import fs from "node:fs";
import path from "node:path";
import * as ch from "./clickhouse.ts";

const STATE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "data", "state");
const TABLE = "brain.state";
let backend: "clickhouse" | "file" = "file";
let lastVersion = 0;

/** Monotonic version so the newest write wins in ReplacingMergeTree / argMax. */
function nextVersion(): number {
  lastVersion = Math.max(Date.now() * 1000, lastVersion + 1);
  return lastVersion;
}

export async function initState(): Promise<"clickhouse" | "file"> {
  backend = "file";
  if (!(await ch.waitForServer())) {
    if (ch.requireReachable()) throw new Error("ClickHouse is not reachable (the service may still be waking up). Try again in a few seconds.");
    return backend;
  }
  try {
    await ch.exec("CREATE DATABASE IF NOT EXISTS brain");
    await ch.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      ns LowCardinality(String), key String, value String, version UInt64, deleted UInt8
    ) ENGINE = ReplacingMergeTree(version) ORDER BY (ns, key)
    COMMENT 'Ingestion app state (reports, schedules, gaps, memory, uploads, approvals)'`);
    backend = "clickhouse";
  } catch (err) {
    console.warn(`[state] using file store: ${(err as Error).message}`);
  }
  return backend;
}

export function stateBackend() {
  return backend;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 200);

export async function get<T>(ns: string, key: string): Promise<T | null> {
  if (backend === "clickhouse") {
    const r = await ch.query(
      `SELECT argMax(value, version) AS v, argMax(deleted, version) AS d FROM ${TABLE} WHERE ns = {ns:String} AND key = {key:String}`,
      { params: { ns, key } },
    );
    const row = r.rows[0];
    return row && row.v !== "" && !Number(row.d) ? (JSON.parse(String(row.v)) as T) : null;
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, safe(ns), `${safe(key)}.json`), "utf8")) as T;
  } catch {
    return null;
  }
}

export async function list<T>(ns: string): Promise<{ key: string; value: T }[]> {
  if (backend === "clickhouse") {
    const r = await ch.query(
      `SELECT key, argMax(value, version) AS v FROM ${TABLE} WHERE ns = {ns:String} GROUP BY key HAVING argMax(deleted, version) = 0`,
      { params: { ns }, maxRows: 100_000 },
    );
    return r.rows.map((row) => ({ key: String(row.key), value: JSON.parse(String(row.v)) as T }));
  }
  const dir = path.join(STATE_DIR, safe(ns));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ key: f.slice(0, -5), value: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as T }));
}

export async function put(ns: string, key: string, value: unknown): Promise<void> {
  if (backend === "clickhouse") {
    await ch.insertJson(TABLE, [{ ns, key, value: JSON.stringify(value), version: nextVersion(), deleted: 0 }]);
    return;
  }
  const dir = path.join(STATE_DIR, safe(ns));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${safe(key)}.json`), JSON.stringify(value, null, 2));
}

export async function del(ns: string, key: string): Promise<void> {
  if (backend === "clickhouse") {
    await ch.insertJson(TABLE, [{ ns, key, value: "", version: nextVersion(), deleted: 1 }]);
    return;
  }
  fs.rmSync(path.join(STATE_DIR, safe(ns), `${safe(key)}.json`), { force: true });
}
