// LLM observability: every question becomes a trace made of spans (agent runs, model generations,
// tool calls) with tokens, cost, latency and time-to-first-token. Stored in ClickHouse (database
// `brain`) when available, otherwise appended to data/traces.jsonl.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as ch from "./clickhouse.ts";
import { DATA_DIR } from "./kb.ts";

const TRACE_DB = "brain";
const JSONL = path.join(DATA_DIR, "traces.jsonl");
const FEEDBACK_JSONL = path.join(DATA_DIR, "feedback.jsonl");

// USD per million tokens: [input, output, cache read, cache write]
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

export function costUsd(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const p = PRICES[model] ?? PRICES["claude-opus-5-5"];
  return (u.input * p[0] + u.output * p[1] + u.cacheRead * p[2] + u.cacheWrite * p[3]) / 1e6;
}

export interface Span {
  trace_id: string;
  span_id: string;
  parent_id: string;
  name: string;
  kind: "agent" | "generation" | "tool";
  start_time: string;
  duration_ms: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  ttft_ms: number;
  cost_usd: number;
  status: "ok" | "error";
  input: string;
  output: string;
}

export interface TraceRecord {
  trace_id: string;
  created_at: string;
  source: string; // chat | schedule | eval | mcp
  question: string;
  persona: string;
  user_id: string;
  answer: string;
  mode: string;
  status: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  tool_calls: number;
  feedback?: number;
}

const clip = (s: unknown, n = 4000) => {
  const str = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return str.length > n ? str.slice(0, n) + `… [+${str.length - n} chars]` : str;
};

export class Trace {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  readonly spans: Span[] = [];
  private open = new Map<string, number>();

  readonly meta: { source: string; question: string; persona: string; userId: string };

  constructor(meta: { source: string; question: string; persona: string; userId: string }) {
    this.meta = meta;
  }

  start(name: string, kind: Span["kind"], parentId = "", input: unknown = "", model = ""): Span {
    const span: Span = {
      trace_id: this.id,
      span_id: randomUUID(),
      parent_id: parentId,
      name,
      kind,
      start_time: new Date().toISOString(),
      duration_ms: 0,
      model,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      ttft_ms: 0,
      cost_usd: 0,
      status: "ok",
      input: clip(input),
      output: "",
    };
    this.spans.push(span);
    this.open.set(span.span_id, Date.now());
    return span;
  }

  end(span: Span, data: Partial<Pick<Span, "output" | "status" | "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "ttft_ms">> = {}) {
    const t0 = this.open.get(span.span_id) ?? Date.now();
    Object.assign(span, data, { output: clip(data.output ?? span.output), duration_ms: Date.now() - t0 });
    if (span.kind === "generation") {
      span.cost_usd = costUsd(span.model, { input: span.input_tokens, output: span.output_tokens, cacheRead: span.cache_read_tokens, cacheWrite: span.cache_write_tokens });
    }
    this.open.delete(span.span_id);
  }

  totals() {
    const gens = this.spans.filter((s) => s.kind === "generation");
    return {
      input_tokens: gens.reduce((a, s) => a + s.input_tokens + s.cache_read_tokens + s.cache_write_tokens, 0),
      output_tokens: gens.reduce((a, s) => a + s.output_tokens, 0),
      cache_read_tokens: gens.reduce((a, s) => a + s.cache_read_tokens, 0),
      cost_usd: gens.reduce((a, s) => a + s.cost_usd, 0),
      tool_calls: this.spans.filter((s) => s.kind === "tool").length,
    };
  }

  async finish(answer: string, mode: string, status = "ok"): Promise<TraceRecord> {
    const t = this.totals();
    const record: TraceRecord = {
      trace_id: this.id,
      created_at: new Date(this.startedAt).toISOString(),
      source: this.meta.source,
      question: clip(this.meta.question, 2000),
      persona: this.meta.persona,
      user_id: this.meta.userId,
      answer: clip(answer, 20000),
      mode,
      status,
      latency_ms: Date.now() - this.startedAt,
      input_tokens: t.input_tokens,
      output_tokens: t.output_tokens,
      cost_usd: Number(t.cost_usd.toFixed(6)),
      tool_calls: t.tool_calls,
    };
    try {
      await store.save(record, this.spans);
    } catch (err) {
      console.warn(`[trace] could not persist trace: ${(err as Error).message}`);
    }
    return record;
  }
}

// ---------------- storage ----------------

let useClickHouse = false;

export async function initTraceStore(): Promise<"clickhouse" | "file"> {
  useClickHouse = false;
  if (!(await ch.waitForServer())) {
    if (ch.requireReachable()) throw new Error("ClickHouse is not reachable (the service may still be waking up). Try again in a few seconds.");
    return "file";
  }
  try {
    await ch.exec(`CREATE DATABASE IF NOT EXISTS ${TRACE_DB}`);
    await ch.exec(`CREATE TABLE IF NOT EXISTS ${TRACE_DB}.traces (
      trace_id String, created_at DateTime64(3), source LowCardinality(String), question String, persona LowCardinality(String),
      user_id String, answer String, mode LowCardinality(String), status LowCardinality(String), latency_ms UInt32,
      input_tokens UInt32, output_tokens UInt32, cost_usd Float64, tool_calls UInt16
    ) ENGINE = MergeTree ORDER BY created_at COMMENT 'Ingestion questions (one row per question)'`);
    await ch.exec(`CREATE TABLE IF NOT EXISTS ${TRACE_DB}.spans (
      trace_id String, span_id String, parent_id String, name String, kind LowCardinality(String), start_time DateTime64(3),
      duration_ms UInt32, model LowCardinality(String), input_tokens UInt32, output_tokens UInt32, cache_read_tokens UInt32,
      cache_write_tokens UInt32, ttft_ms UInt32, cost_usd Float64, status LowCardinality(String), input String, output String
    ) ENGINE = MergeTree ORDER BY (trace_id, start_time) COMMENT 'Agent runs, model generations and tool calls within a trace'`);
    await ch.exec(`CREATE TABLE IF NOT EXISTS ${TRACE_DB}.feedback (
      trace_id String, score Int8, comment String, at DateTime64(3)
    ) ENGINE = MergeTree ORDER BY trace_id COMMENT 'User feedback: score 1 = helpful, -1 = not helpful'`);
    useClickHouse = true;
    return "clickhouse";
  } catch (err) {
    console.warn(`[trace] falling back to file store: ${(err as Error).message}`);
    return "file";
  }
}

export function traceBackend() {
  return useClickHouse ? "clickhouse" : "file";
}

const store = {
  async save(record: TraceRecord, spans: Span[]) {
    if (useClickHouse) {
      await ch.insertJson(`${TRACE_DB}.traces`, [record]);
      await ch.insertJson(`${TRACE_DB}.spans`, spans);
    } else {
      fs.appendFileSync(JSONL, JSON.stringify({ ...record, spans }) + "\n");
    }
  },
};

function readJsonl<T>(file: string): T[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

export async function listTraces(limit = 100): Promise<TraceRecord[]> {
  if (useClickHouse) {
    const r = await ch.query(
      `SELECT t.* EXCEPT answer, substring(t.answer, 1, 300) AS answer, f.score AS feedback
       FROM ${TRACE_DB}.traces AS t
       LEFT JOIN (SELECT trace_id, argMax(score, at) AS score FROM ${TRACE_DB}.feedback GROUP BY trace_id) AS f USING trace_id
       ORDER BY t.created_at DESC LIMIT ${Math.min(limit, 500)}`,
      { readonly: true },
    );
    return r.rows as unknown as TraceRecord[];
  }
  const fb = new Map(readJsonl<{ trace_id: string; score: number }>(FEEDBACK_JSONL).map((f) => [f.trace_id, f.score]));
  return readJsonl<TraceRecord & { spans: Span[] }>(JSONL)
    .reverse()
    .slice(0, limit)
    .map(({ spans: _s, ...t }) => ({ ...t, answer: t.answer.slice(0, 300), feedback: fb.get(t.trace_id) }));
}

export async function getTrace(id: string): Promise<{ trace: TraceRecord; spans: Span[] } | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  if (useClickHouse) {
    const t = await ch.query(`SELECT * FROM ${TRACE_DB}.traces WHERE trace_id = '${id}' LIMIT 1`);
    if (!t.rows.length) return null;
    const s = await ch.query(`SELECT * FROM ${TRACE_DB}.spans WHERE trace_id = '${id}' ORDER BY start_time`);
    return { trace: t.rows[0] as unknown as TraceRecord, spans: s.rows as unknown as Span[] };
  }
  const found = readJsonl<TraceRecord & { spans: Span[] }>(JSONL).find((t) => t.trace_id === id);
  if (!found) return null;
  const { spans, ...trace } = found;
  return { trace, spans };
}

export async function addFeedback(traceId: string, score: number, comment = ""): Promise<void> {
  const row = { trace_id: traceId, score: score > 0 ? 1 : -1, comment: comment.slice(0, 1000), at: new Date().toISOString() };
  if (useClickHouse) await ch.insertJson(`${TRACE_DB}.feedback`, [row]);
  else fs.appendFileSync(FEEDBACK_JSONL, JSON.stringify(row) + "\n");
}

export async function traceStats() {
  if (!useClickHouse) {
    const all = readJsonl<TraceRecord>(JSONL);
    const n = all.length || 1;
    return { traces: all.length, avg_latency_ms: Math.round(all.reduce((a, t) => a + t.latency_ms, 0) / n), total_cost_usd: all.reduce((a, t) => a + t.cost_usd, 0), p95_latency_ms: 0 };
  }
  const r = await ch.query(
    `SELECT count() AS traces, round(avg(latency_ms)) AS avg_latency_ms, round(quantile(0.95)(latency_ms)) AS p95_latency_ms, sum(cost_usd) AS total_cost_usd FROM ${TRACE_DB}.traces`,
  );
  return r.rows[0];
}
