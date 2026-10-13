// The HTTP request handler (JSON API + Server-Sent Events + static UI), shared by the local server
// (src/server.ts) and the Vercel function (api/index.ts). Stateless across requests: everything
// persistent lives in ClickHouse (or local files), so any instance can serve any request.
import type http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ask, aiEnabled, chunkMeta, MODEL } from "./brain.ts";
import * as kb from "./kb.ts";
import * as ch from "./clickhouse.ts";
import * as traces from "./trace.ts";
import * as reports from "./reports.ts";
import * as state from "./state.ts";
import * as auth from "./auth.ts";
import { ANALYST_MODEL, loadSkills, runConsoleQuery } from "./analyst.ts";
import * as org from "./org.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(here, "..", "web");
const APPROVAL_TIMEOUT_MS = 3 * 60_000;
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

/** One-time initialisation per process (idempotent). */
let ready: Promise<void> | null = null;
export function init(): Promise<void> {
  return (ready ??= (async () => {
    await state.initState();
    await traces.initTraceStore();
    await kb.reload();
  })().catch((err) => {
    ready = null;
    throw err;
  }));
}

/** Pending approvals waiting in this process (fast path; the state store is the source of truth). */
const localApprovals = new Map<string, (ok: boolean) => void>();

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit = 5_000_000): Promise<Record<string, unknown>> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const part of req) {
    size += (part as Buffer).length;
    if (size > limit) throw new Error("Request body too large");
    parts.push(part as Buffer);
  }
  const text = Buffer.concat(parts).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function htmlToText(html: string): { title: string; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
  const text = html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, l, t) => `\n\n${"#".repeat(Number(l) === 1 ? 2 : Number(l))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`)
    .replace(/<(br|\/p|\/div|\/li|\/tr)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  return { title, text };
}

function serveFile(res: http.ServerResponse, file: string, status = 200) {
  res.writeHead(status, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

/** Wait for an Approve/Deny decision written by /api/approve (possibly on another instance). */
function waitForApproval(id: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      localApprovals.delete(id);
      resolve(ok);
    };
    localApprovals.set(id, finish);
    const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
    signal.addEventListener("abort", () => finish(false), { once: true });
    const poll = setInterval(async () => {
      try {
        const decision = await state.get<{ status: string }>("approval", id);
        if (decision && decision.status !== "pending") finish(decision.status === "approved");
      } catch {
        // transient; keep polling
      }
    }, 1000);
  });
}

export async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const p = url.pathname;
  try {
    // ---- Auth gate ----
    if (p === "/api/login" && req.method === "POST") {
      const body = await readBody(req);
      if (!auth.checkPassword(body.password)) {
        await new Promise((r) => setTimeout(r, 600)); // slow down guessing
        return send(res, 401, { error: "Wrong password" });
      }
      return send(res, 200, { ok: true }, { "Set-Cookie": auth.sessionCookie(req) });
    }
    if (p === "/api/warm") {
      // Called by the login page so an idle ClickHouse Cloud service wakes while the user types.
      void init().catch(() => {});
      return send(res, 202, { ok: true });
    }
    if (p === "/api/logout") return send(res, 200, { ok: true }, { "Set-Cookie": auth.clearCookie() });
    const isAsset = /\.(css|js|svg)$/.test(p);
    if (!isAsset && !auth.isAuthed(req) && !(p === "/api/cron" && auth.isCron(req))) {
      if (p.startsWith("/api/")) return send(res, 401, { error: "Login required" });
      return serveFile(res, path.join(WEB_DIR, "login.html"), 401);
    }

    if (p.startsWith("/api/")) {
      await init();
      await kb.ensureFresh();
    }
    if (p === "/api/hr-unlock" && req.method === "POST") {
      const body = await readBody(req);
      if (!auth.checkHrPassword(body.password)) {
        await new Promise((r) => setTimeout(r, 600));
        return send(res, 401, { error: "Wrong HR password" });
      }
      return send(res, 200, { ok: true }, { "Set-Cookie": auth.hrCookie(req) });
    }
    // The HR persona needs the HR password (when HR_PASSWORD is set); otherwise fall back to an error.
    const hrLocked = !auth.hrUnlocked(req);
    const personaFor = (id: unknown) => {
      const persona = kb.getPersona(id);
      return persona.id === "hr" && hrLocked ? null : persona;
    };
    const requested = url.searchParams.get("persona");
    const maybePersona = personaFor(requested);
    if (!maybePersona && p.startsWith("/api/") && p !== "/api/status") return send(res, 403, { error: "The HR persona requires the HR password.", hrLocked: true });
    const persona = maybePersona ?? kb.getPersona("engineer");

    // ---- Knowledge ----
    if (p === "/api/status" && req.method === "GET") {
      return send(res, 200, {
        ai: aiEnabled(),
        model: MODEL,
        analystModel: ANALYST_MODEL,
        company: process.env.COMPANY_NAME ?? "Acme",
        personas: kb.PERSONAS,
        stats: await kb.stats(),
        clickhouse: await ch.ping(),
        knowledgeBackend: kb.knowledgeBackend(),
        traceStore: traces.traceBackend(),
        stateStore: state.stateBackend(),
        auth: auth.authEnabled(),
        hrLocked,
        hrAvailable: await org.orgAvailable(),
      });
    }
    if (p === "/api/documents" && req.method === "GET") return send(res, 200, kb.listDocs(persona));
    if (p === "/api/document" && req.method === "GET") {
      const doc = kb.getDoc(url.searchParams.get("id") ?? "", persona);
      if (!doc) return send(res, 404, { error: "Not found or not accessible for this persona." });
      return send(res, 200, { ...doc, chunks: kb.chunksOf(doc.id).map(chunkMeta) });
    }
    if (p === "/api/search" && req.method === "GET") {
      const { hits, backend, fallback } = await kb.search(url.searchParams.get("q") ?? "", persona, { limit: 10 });
      return send(res, 200, hits.map((h) => ({ ...chunkMeta(h.chunk), score: Number(h.score.toFixed(2)), backend, fallback })));
    }
    if (p === "/api/graph" && req.method === "GET") {
      const entity = url.searchParams.get("entity");
      return send(res, 200, entity ? kb.exploreGraph(entity, 2) : kb.getGraph());
    }
    if (p === "/api/org" && req.method === "GET") return send(res, 200, await org.orgChart());
    if (p === "/api/gaps" && req.method === "GET") return send(res, 200, await kb.listGaps());
    if (p === "/api/gaps/resolve" && req.method === "POST") {
      const body = await readBody(req);
      return send(res, (await kb.resolveGap(String(body.id))) ? 200 : 404, { ok: true });
    }
    if (p === "/api/memory" && req.method === "GET") return send(res, 200, await kb.getMemories(url.searchParams.get("user") ?? "demo"));
    if (p === "/api/memory" && req.method === "DELETE") {
      await kb.forget(url.searchParams.get("user") ?? "demo", url.searchParams.get("id") ?? "");
      return send(res, 200, { ok: true });
    }
    if (p === "/api/reindex" && req.method === "POST") return send(res, 200, await kb.reload());

    if (p === "/api/ingest" && req.method === "POST") {
      const body = await readBody(req);
      let title = String(body.title ?? "").trim();
      let content = String(body.content ?? "");
      const sourceType = String(body.sourceType ?? "docs");
      if (body.url) {
        const target = new URL(String(body.url));
        if (!/^https?:$/.test(target.protocol)) return send(res, 400, { error: "Only http(s) URLs are supported." });
        const r = await fetch(target, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "Ingestion/1.0" } });
        if (!r.ok) return send(res, 400, { error: `Fetch failed: HTTP ${r.status}` });
        const ct = r.headers.get("content-type") ?? "";
        const raw = (await r.text()).slice(0, 2_000_000);
        const parsed = ct.includes("html") ? htmlToText(raw) : { title: "", text: raw };
        title ||= parsed.title || target.hostname + target.pathname;
        content = `Source: ${target.href}\n\n${parsed.text}`;
      }
      if (!title || !content.trim()) return send(res, 400, { error: "Title and content (or a URL) are required." });
      const format = body.format === "json" ? "json" : "md";
      const id = await kb.addSource({ title, sourceType, content, owner: body.owner ? String(body.owner) : undefined, access: body.access ? String(body.access) : undefined, format });
      return send(res, 200, { id, stats: await kb.stats() });
    }

    // ---- Ask (SSE) ----
    if (p === "/api/ask" && req.method === "POST") {
      const body = await readBody(req);
      const question = String(body.question ?? "").trim();
      if (!question) return send(res, 400, { error: "question is required" });
      const history = (Array.isArray(body.history) ? body.history : [])
        .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .map((m: any) => ({ role: m.role as "user" | "assistant", content: String(m.content).slice(0, 8000) }));
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      const emit = (event: string, data: unknown) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const askPersona = personaFor(body.persona);
      if (!askPersona) {
        emit("error", { message: "The HR persona requires the HR password." });
        res.end();
        return;
      }
      const requestApproval = async (r: { sql: string; purpose: string; estimatedRows: number }) => {
        const id = randomUUID();
        await state.put("approval", id, { status: "pending", ...r, at: new Date().toISOString() });
        emit("approval", { id, ...r, timeoutSec: APPROVAL_TIMEOUT_MS / 1000 });
        const ok = await waitForApproval(id, controller.signal);
        emit("approval_resolved", { id, approved: ok });
        return ok;
      };
      const result = await ask(
        { question, history, persona: askPersona, userId: String(body.userId ?? "demo").slice(0, 64), signal: controller.signal, source: "chat", requestApproval },
        emit,
      );
      // Keep a shareable draft so "Share report" works from any instance.
      if (result.mode !== "error") {
        try {
          await state.put("draft", result.traceId, reports.buildReport(result, { question, persona: askPersona.id, source: "chat" }));
        } catch (err) {
          console.warn(`[app] could not store report draft: ${(err as Error).message}`);
        }
      }
      res.end();
      return;
    }
    if (p === "/api/approve" && req.method === "POST") {
      const body = await readBody(req);
      const id = String(body.id);
      const pending = await state.get<{ status: string }>("approval", id);
      if (!pending || pending.status !== "pending") return send(res, 404, { error: "No pending approval with that id (it may have timed out)." });
      await state.put("approval", id, { ...pending, status: body.approved === true ? "approved" : "denied" });
      localApprovals.get(id)?.(body.approved === true);
      return send(res, 200, { ok: true });
    }

    // ---- Data (ClickHouse) ----
    if (p === "/api/data/tables" && req.method === "GET") {
      if (!(await ch.ping())) return send(res, 200, { up: false, tables: [], storage: [], skills: loadSkills() });
      const dbs = persona.databases.filter((d) => d !== "brain");
      const [tables, storage] = await Promise.all([ch.listTables(dbs), ch.storageStats()]);
      const host = new URL(ch.CH_URL).host;
      return send(res, 200, { up: true, url: host, database: dbs.join(", "), tables, storage, skills: loadSkills(persona.databases) });
    }
    if (p === "/api/data/query" && req.method === "POST") {
      const body = await readBody(req);
      try {
        return send(res, 200, await runConsoleQuery(String(body.sql ?? ""), persona.databases));
      } catch (err) {
        return send(res, 400, { error: (err as Error).message });
      }
    }

    // ---- Observability ----
    if (p === "/api/traces" && req.method === "GET") {
      const [list, stats] = await Promise.all([traces.listTraces(100), traces.traceStats()]);
      return send(res, 200, { backend: traces.traceBackend(), stats, traces: list });
    }
    if (p === "/api/trace" && req.method === "GET") {
      const t = await traces.getTrace(url.searchParams.get("id") ?? "");
      return t ? send(res, 200, t) : send(res, 404, { error: "Trace not found" });
    }
    if (p === "/api/feedback" && req.method === "POST") {
      const body = await readBody(req);
      await traces.addFeedback(String(body.traceId), Number(body.score), String(body.comment ?? ""));
      return send(res, 200, { ok: true });
    }

    // ---- Reports & schedules ----
    if (p === "/api/reports" && req.method === "GET") return send(res, 200, await reports.listReports());
    if (p === "/api/reports" && req.method === "POST") {
      const body = await readBody(req);
      const draft = await state.get<reports.Report>("draft", String(body.traceId));
      if (!draft) return send(res, 404, { error: "Answer not found. Ask again to share it." });
      const report = await reports.saveReport({ ...draft, title: body.title ? String(body.title) : draft.title, createdAt: new Date().toISOString() });
      return send(res, 200, { id: report.id, url: `/r/${report.id}` });
    }
    if (p === "/api/report" && req.method === "GET") {
      const r = await reports.getReport(url.searchParams.get("id") ?? "");
      return r ? send(res, 200, r) : send(res, 404, { error: "Report not found" });
    }
    if (p === "/api/schedules" && req.method === "GET") return send(res, 200, await reports.listSchedules());
    if (p === "/api/schedules" && req.method === "POST") {
      const body = await readBody(req);
      if (!String(body.question ?? "").trim()) return send(res, 400, { error: "question is required" });
      return send(res, 200, await reports.upsertSchedule(body as any));
    }
    if (p === "/api/schedules" && req.method === "DELETE") {
      await reports.deleteSchedule(url.searchParams.get("id") ?? "");
      return send(res, 200, { ok: true });
    }
    if (p === "/api/schedules/run" && req.method === "POST") {
      const body = await readBody(req);
      const report = await reports.runSchedule(String(body.id));
      return report ? send(res, 200, { id: report.id, url: `/r/${report.id}` }) : send(res, 409, { error: "Schedule not found or already running." });
    }
    if (p === "/api/cron" && (req.method === "GET" || req.method === "POST")) {
      return send(res, 200, { ran: await reports.runDueSchedules() });
    }

    if (p.startsWith("/api/")) return send(res, 404, { error: "Unknown endpoint" });

    // ---- Static UI ----
    if (/^\/r\/[A-Za-z0-9_-]+$/.test(p)) return serveFile(res, path.join(WEB_DIR, "report.html"));
    const rel = p === "/" ? "index.html" : decodeURIComponent(p).replace(/^\/+/, "");
    const file = path.normalize(path.join(WEB_DIR, rel));
    if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    serveFile(res, file);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: (err as Error).message });
    else res.end();
  }
}
