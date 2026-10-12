// Shareable reports (an answer + charts + the full audit trail of queries and sources) and
// scheduled questions that run on a cadence and publish a report each time. Persisted in the
// state store (ClickHouse or local files).
import { randomBytes } from "node:crypto";
import * as kb from "./kb.ts";
import * as state from "./state.ts";
import { ask, chunkMeta, type AskResult } from "./brain.ts";

export interface Report {
  id: string;
  title: string;
  createdAt: string;
  source: "chat" | "schedule";
  scheduleId?: string;
  question: string;
  persona: string;
  answer: string;
  traceId: string;
  queries: unknown[];
  charts: unknown[];
  sources: unknown[];
  steps: unknown[];
}

const newId = () => randomBytes(6).toString("base64url");

export function buildReport(result: AskResult, meta: { question: string; persona: string; title?: string; source: Report["source"]; scheduleId?: string }): Report {
  const citedChunks = [...new Set(result.answer.match(/\bc\d+\b/g) ?? [])].map((id) => kb.getChunk(id)).filter((c) => !!c);
  return {
    id: newId(),
    title: meta.title || meta.question.slice(0, 90),
    createdAt: new Date().toISOString(),
    source: meta.source,
    scheduleId: meta.scheduleId,
    question: meta.question,
    persona: meta.persona,
    answer: result.answer,
    traceId: result.traceId,
    queries: result.session.queries.map((q) => ({ ...q, rows: q.rows.slice(0, 200) })),
    charts: result.session.charts.map((c) => {
      const q = result.session.query(c.queryId);
      return { ...c, columns: q?.columns ?? [], rows: q?.rows.slice(0, 2000) ?? [] };
    }),
    sources: citedChunks.map(chunkMeta),
    steps: result.steps.map((s) => {
      const { results, ...rest } = s as { results?: unknown[] };
      return { ...rest, resultCount: results?.length };
    }),
  };
}

export async function saveReport(r: Report): Promise<Report> {
  await state.put("report", r.id, r);
  return r;
}

export async function getReport(id: string): Promise<Report | null> {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
  return state.get<Report>("report", id);
}

export async function listReports() {
  return (await state.list<Report>("report"))
    .map(({ value: r }) => ({ id: r.id, title: r.title, createdAt: r.createdAt, source: r.source, scheduleId: r.scheduleId, persona: r.persona, queries: r.queries.length, charts: r.charts.length }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------------- Schedules ----------------

export interface Schedule {
  id: string;
  title: string;
  question: string;
  persona: string;
  frequency: "hourly" | "daily" | "weekly" | "minutes";
  time?: string; // HH:MM local time for daily/weekly
  weekday?: number; // 1 = Monday … 7 = Sunday, for weekly
  minutes?: number; // for "minutes"
  enabled: boolean;
  nextRun: string;
  lastRun?: string;
  lastReportId?: string;
  lastStatus?: string;
}

async function readSchedules(): Promise<Schedule[]> {
  return (await state.list<Schedule>("schedule")).map((s) => s.value);
}

export function computeNextRun(s: Pick<Schedule, "frequency" | "time" | "weekday" | "minutes">, from = new Date()): string {
  const next = new Date(from);
  if (s.frequency === "minutes") return new Date(from.getTime() + Math.max(5, s.minutes ?? 60) * 60_000).toISOString();
  if (s.frequency === "hourly") {
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next.toISOString();
  }
  const [h, m] = (s.time ?? "09:00").split(":").map(Number);
  next.setHours(h || 0, m || 0, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  if (s.frequency === "weekly") {
    const want = ((s.weekday ?? 1) % 7) as number; // JS: 0 = Sunday
    while (next.getDay() !== want) next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
}

export async function listSchedules(): Promise<Schedule[]> {
  return (await readSchedules()).sort((a, b) => a.nextRun.localeCompare(b.nextRun));
}

export async function upsertSchedule(input: Partial<Schedule> & { question: string }): Promise<Schedule> {
  const existing = input.id ? ((await state.get<Schedule>("schedule", input.id)) ?? undefined) : undefined;
  const frequency = (["hourly", "daily", "weekly", "minutes"].includes(String(input.frequency)) ? input.frequency : "daily") as Schedule["frequency"];
  const s: Schedule = {
    ...(existing ?? { id: newId(), enabled: true, nextRun: "" }),
    title: (input.title || input.question).slice(0, 90),
    question: input.question.slice(0, 2000),
    persona: kb.getPersona(input.persona).id,
    frequency,
    time: /^\d{1,2}:\d{2}$/.test(String(input.time)) ? input.time : "09:00",
    weekday: Number(input.weekday) || 1,
    minutes: Number(input.minutes) || 60,
    enabled: input.enabled ?? existing?.enabled ?? true,
  };
  s.nextRun = computeNextRun(s);
  await state.put("schedule", s.id, s);
  return s;
}

export async function deleteSchedule(id: string) {
  await state.del("schedule", id);
}

const running = new Set<string>();

export async function runSchedule(id: string): Promise<Report | null> {
  const s = await state.get<Schedule>("schedule", id);
  if (!s || running.has(id)) return null;
  running.add(id);
  try {
    const result = await ask(
      { question: s.question, history: [], persona: kb.getPersona(s.persona), userId: "scheduler", source: "schedule", requestApproval: async () => false },
      () => {},
    );
    const report = await saveReport(buildReport(result, { question: s.question, persona: s.persona, title: `${s.title} · ${new Date().toLocaleDateString()}`, source: "schedule", scheduleId: s.id }));
    const cur = await state.get<Schedule>("schedule", id);
    if (cur) {
      cur.lastRun = new Date().toISOString();
      cur.lastReportId = report.id;
      cur.lastStatus = result.mode;
      cur.nextRun = computeNextRun(cur);
      await state.put("schedule", id, cur);
    }
    return report;
  } finally {
    running.delete(id);
  }
}

/** Run every enabled schedule that is due. Called by the local timer or the Vercel cron endpoint. */
export async function runDueSchedules(log = console.log): Promise<string[]> {
  const now = Date.now();
  const due = (await readSchedules()).filter((s) => s.enabled && !running.has(s.id) && new Date(s.nextRun).getTime() <= now);
  const reports: string[] = [];
  for (const s of due) {
    log(`[scheduler] running "${s.title}"`);
    try {
      const r = await runSchedule(s.id);
      if (r) reports.push(r.id);
    } catch (err) {
      log(`[scheduler] "${s.title}" failed: ${(err as Error).message}`);
    }
  }
  return reports;
}

export function startScheduler(log = console.log) {
  return setInterval(() => void runDueSchedules(log).catch((err) => log(`[scheduler] ${(err as Error).message}`)), 30_000);
}
