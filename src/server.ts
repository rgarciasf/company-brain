// HTTP server: JSON API + Server-Sent Events for streaming answers + static UI.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on the environment
}

const { ask, aiEnabled, chunkMeta, MODEL } = await import("./brain.ts");
const kb = await import("./kb.ts");
const ch = await import("./clickhouse.ts");
const traces = await import("./trace.ts");
const reports = await import("./reports.ts");
const { ANALYST_MODEL, loadSkills, runConsoleQuery } = await import("./analyst.ts");
type AskResult = Awaited<ReturnType<typeof ask>>;

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "public");
const PORT = Number(process.env.PORT ?? 3000);
const APPROVAL_TIMEOUT_MS = 3 * 60_000;
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

/** Recent answers, kept so they can be turned into shareable reports. */
const recent = new Map<string, AskResult & { question: string; persona: string }>();
/** Pending human-in-the-loop approvals: id -> resolver. */
const approvals = new Map<string, (ok: boolean) => void>();
let clickhouseUp = false;

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
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

function serveFile(res: http.ServerResponse, file: string) {
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const p = url.pathname;
  const persona = kb.getPersona(url.searchParams.get("persona"));
  try {
    // ---- Knowledge ----
    if (p === "/api/status" && req.method === "GET") {
      clickhouseUp = await ch.ping();
      return send(res, 200, {
        ai: aiEnabled(),
        model: MODEL,
        analystModel: ANALYST_MODEL,
        company: process.env.COMPANY_NAME ?? "Acme",
        personas: kb.PERSONAS,
        stats: kb.stats(),
        clickhouse: clickhouseUp,
        traceStore: traces.traceBackend(),
      });
    }
    if (p === "/api/documents" && req.method === "GET") return send(res, 200, kb.listDocs(persona));
    if (p === "/api/document" && req.method === "GET") {
      const doc = kb.getDoc(url.searchParams.get("id") ?? "", persona);
      if (!doc) return send(res, 404, { error: "Not found or not accessible for this persona." });
      return send(res, 200, { ...doc, chunks: kb.chunksOf(doc.id).map(chunkMeta) });
    }
    if (p === "/api/search" && req.method === "GET") {
      const hits = kb.search(url.searchParams.get("q") ?? "", persona, { limit: 10 });
      return send(res, 200, hits.map((h) => ({ ...chunkMeta(h.chunk), score: Number(h.score.toFixed(2)) })));
    }
    if (p === "/api/graph" && req.method === "GET") {
      const entity = url.searchParams.get("entity");
      return send(res, 200, entity ? kb.exploreGraph(entity, 2) : kb.getGraph());
    }
    if (p === "/api/gaps" && req.method === "GET") return send(res, 200, kb.listGaps());
    if (p === "/api/gaps/resolve" && req.method === "POST") {
      const body = await readBody(req);
      return send(res, kb.resolveGap(String(body.id)) ? 200 : 404, { ok: true });
    }
    if (p === "/api/memory" && req.method === "GET") return send(res, 200, kb.getMemories(url.searchParams.get("user") ?? "demo"));
    if (p === "/api/memory" && req.method === "DELETE") {
      kb.forget(url.searchParams.get("user") ?? "demo", url.searchParams.get("id") ?? "");
      return send(res, 200, { ok: true });
    }
    if (p === "/api/reindex" && req.method === "POST") return send(res, 200, kb.reload());

    if (p === "/api/ingest" && req.method === "POST") {
      const body = await readBody(req);
      let title = String(body.title ?? "").trim();
      let content = String(body.content ?? "");
      const sourceType = String(body.sourceType ?? "docs");
      if (body.url) {
        const target = new URL(String(body.url));
        if (!/^https?:$/.test(target.protocol)) return send(res, 400, { error: "Only http(s) URLs are supported." });
        const r = await fetch(target, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "CompanyBrain/1.0" } });
        if (!r.ok) return send(res, 400, { error: `Fetch failed: HTTP ${r.status}` });
        const ct = r.headers.get("content-type") ?? "";
        const raw = (await r.text()).slice(0, 2_000_000);
        const parsed = ct.includes("html") ? htmlToText(raw) : { title: "", text: raw };
        title ||= parsed.title || target.hostname + target.pathname;
        content = `Source: ${target.href}\n\n${parsed.text}`;
      }
      if (!title || !content.trim()) return send(res, 400, { error: "Title and content (or a URL) are required." });
      const format = body.format === "json" ? "json" : "md";
      const id = kb.addSource({ title, sourceType, content, owner: body.owner ? String(body.owner) : undefined, access: body.access ? String(body.access) : undefined, format });
      return send(res, 200, { id, stats: kb.stats() });
    }

    // ---- Ask (SSE) ----
    if (p === "/api/ask" && req.method === "POST") {
      const body = await readBody(req);
      const question = String(body.question ?? "").trim();
      if (!question) return send(res, 400, { error: "question is required" });
      const history = (Array.isArray(body.history) ? body.history : [])
        .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .map((m: any) => ({ role: m.role as "user" | "assistant", content: String(m.content).slice(0, 8000) }));
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      const emit = (event: string, data: unknown) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const askPersona = kb.getPersona(body.persona);
      const requestApproval = (r: { sql: string; purpose: string; estimatedRows: number }) =>
        new Promise<boolean>((resolve) => {
          const id = randomUUID();
          const finish = (ok: boolean) => {
            if (!approvals.has(id)) return;
            approvals.delete(id);
            clearTimeout(timer);
            emit("approval_resolved", { id, approved: ok });
            resolve(ok);
          };
          const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
          controller.signal.addEventListener("abort", () => finish(false), { once: true });
          approvals.set(id, finish);
          emit("approval", { id, ...r, timeoutSec: APPROVAL_TIMEOUT_MS / 1000 });
        });
      const result = await ask(
        { question, history, persona: askPersona, userId: String(body.userId ?? "demo").slice(0, 64), signal: controller.signal, source: "chat", requestApproval },
        emit,
      );
      recent.set(result.traceId, { ...result, question, persona: askPersona.id });
      if (recent.size > 200) recent.delete(recent.keys().next().value!);
      return res.end();
    }
    if (p === "/api/approve" && req.method === "POST") {
      const body = await readBody(req);
      const resolve = approvals.get(String(body.id));
      if (!resolve) return send(res, 404, { error: "No pending approval with that id (it may have timed out)." });
      resolve(body.approved === true);
      return send(res, 200, { ok: true });
    }

    // ---- Data (ClickHouse) ----
    if (p === "/api/data/tables" && req.method === "GET") {
      if (!(await ch.ping())) return send(res, 200, { up: false, tables: [], storage: [], skills: loadSkills() });
      const [tables, storage] = await Promise.all([ch.listTables(), ch.storageStats()]);
      return send(res, 200, { up: true, url: ch.CH_URL, database: ch.ANALYTICS_DB, tables, storage, skills: loadSkills() });
    }
    if (p === "/api/data/query" && req.method === "POST") {
      const body = await readBody(req);
      try {
        return send(res, 200, await runConsoleQuery(String(body.sql ?? "")));
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
    if (p === "/api/reports" && req.method === "GET") return send(res, 200, reports.listReports());
    if (p === "/api/reports" && req.method === "POST") {
      const body = await readBody(req);
      const r = recent.get(String(body.traceId));
      if (!r) return send(res, 404, { error: "Answer not found (the server may have restarted). Ask again to share it." });
      const report = reports.saveReport(reports.buildReport(r, { question: r.question, persona: r.persona, title: body.title ? String(body.title) : undefined, source: "chat" }));
      return send(res, 200, { id: report.id, url: `/r/${report.id}` });
    }
    if (p === "/api/report" && req.method === "GET") {
      const r = reports.getReport(url.searchParams.get("id") ?? "");
      return r ? send(res, 200, r) : send(res, 404, { error: "Report not found" });
    }
    if (p === "/api/schedules" && req.method === "GET") return send(res, 200, reports.listSchedules());
    if (p === "/api/schedules" && req.method === "POST") {
      const body = await readBody(req);
      if (!String(body.question ?? "").trim()) return send(res, 400, { error: "question is required" });
      return send(res, 200, reports.upsertSchedule(body as any));
    }
    if (p === "/api/schedules" && req.method === "DELETE") {
      reports.deleteSchedule(url.searchParams.get("id") ?? "");
      return send(res, 200, { ok: true });
    }
    if (p === "/api/schedules/run" && req.method === "POST") {
      const body = await readBody(req);
      const report = await reports.runSchedule(String(body.id));
      return report ? send(res, 200, { id: report.id, url: `/r/${report.id}` }) : send(res, 409, { error: "Schedule not found or already running." });
    }

    if (p.startsWith("/api/")) return send(res, 404, { error: "Unknown endpoint" });

    // ---- Static UI ----
    if (/^\/r\/[A-Za-z0-9_-]+$/.test(p)) return serveFile(res, path.join(PUBLIC_DIR, "report.html"));
    const rel = p === "/" ? "index.html" : decodeURIComponent(p).replace(/^\/+/, "");
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end("Not found");
    }
    serveFile(res, file);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: (err as Error).message });
    else res.end();
  }
});

// ---- Startup ----
const loaded = kb.reload();
console.log(`\n🧠 Company Brain`);
console.log(`   ${loaded.docs} documents, ${loaded.chunks} chunks indexed`);
clickhouseUp = await ch.ensureServer((m) => console.log(m));
if (clickhouseUp && !(await ch.databaseExists())) {
  console.log("   Seeding analytics database (first run)…");
  const { seed } = await import("../scripts/seed.ts");
  await seed((m) => console.log(m));
}
console.log(clickhouseUp ? `   ClickHouse: ${ch.CH_URL} (database ${ch.ANALYTICS_DB})` : "   ClickHouse: not available (data questions disabled). Run `npm run db:install`.");
console.log(`   Traces stored in: ${await traces.initTraceStore()}`);
console.log(aiEnabled() ? `   AI: ${MODEL} (+ ${ANALYST_MODEL} data analyst)` : "   AI answers: OFF (search-only). Set ANTHROPIC_API_KEY in .env to enable.");
reports.startScheduler();
server.listen(PORT, () => console.log(`   Running at http://localhost:${PORT}\n`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    ch.stopServer();
    process.exit(0);
  });
}
