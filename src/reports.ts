// Shareable reports (an answer + charts + the full audit trail of queries and sources) and
// scheduled questions that run on a cadence and publish a report each time.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import * as kb from "./kb.ts";
import { ask, chunkMeta, type AskResult } from "./brain.ts";

const REPORTS_DIR = path.join(kb.DATA_DIR, "reports");
const SCHEDULES_FILE = path.join(kb.DATA_DIR, "schedules.json");

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

export function saveReport(r: Report): Report {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORTS_DIR, `${r.id}.json`), JSON.stringify(r, null, 2));
  return r;
}

export function getReport(id: string): Report | null {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, `${id}.json`), "utf8")) as Report;
  } catch {
    return null;
  }
}

export function listReports() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs
    .readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const r = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), "utf8")) as Report;
      return { id: r.id, title: r.title, createdAt: r.createdAt, source: r.source, scheduleId: r.scheduleId, persona: r.persona, queries: r.queries.length, charts: r.charts.length };
    })
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

function readSchedules(): Schedule[] {
  try {
    return JSON.parse(fs.readFileSync(SCHEDULES_FILE, "utf8")) as Schedule[];
  } catch {
    return [];
  }
}

function writeSchedules(list: Schedule[]) {
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(list, null, 2));
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

export function listSchedules(): Schedule[] {
  return readSchedules();
}

export function upsertSchedule(input: Partial<Schedule> & { question: string }): Schedule {
  const list = readSchedules();
  const existing = input.id ? list.find((s) => s.id === input.id) : undefined;
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
  if (existing) Object.assign(existing, s);
  else list.push(s);
  writeSchedules(list);
  return s;
}

export function deleteSchedule(id: string) {
  writeSchedules(readSchedules().filter((s) => s.id !== id));
}

const running = new Set<string>();

export async function runSchedule(id: string): Promise<Report | null> {
  const s = readSchedules().find((x) => x.id === id);
  if (!s || running.has(id)) return null;
  running.add(id);
  try {
    const result = await ask(
      { question: s.question, history: [], persona: kb.getPersona(s.persona), userId: "scheduler", source: "schedule", requestApproval: async () => false },
      () => {},
    );
    const report = saveReport(buildReport(result, { question: s.question, persona: s.persona, title: `${s.title} · ${new Date().toLocaleDateString()}`, source: "schedule", scheduleId: s.id }));
    const list = readSchedules();
    const cur = list.find((x) => x.id === id);
    if (cur) {
      cur.lastRun = new Date().toISOString();
      cur.lastReportId = report.id;
      cur.lastStatus = result.mode;
      cur.nextRun = computeNextRun(cur);
      writeSchedules(list);
    }
    return report;
  } finally {
    running.delete(id);
  }
}

export function startScheduler(log = console.log) {
  const tick = async () => {
    const now = Date.now();
    for (const s of readSchedules()) {
      if (!s.enabled || running.has(s.id) || new Date(s.nextRun).getTime() > now) continue;
      log(`[scheduler] running "${s.title}"`);
      runSchedule(s.id).catch((err) => log(`[scheduler] "${s.title}" failed: ${(err as Error).message}`));
    }
  };
  return setInterval(tick, 30_000);
}
