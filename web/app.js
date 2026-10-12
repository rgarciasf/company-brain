/* Ingestion (Company Brain) UI — vanilla JS, no build step. Rendering helpers live in shared.js (BrainUI). */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const { esc, renderAnswer, renderChart, tableHtml, queryHtml, fmtNum, icon } = window.BrainUI;

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const state = {
  persona: store.get("brain.persona", "engineer"),
  userId: store.get("brain.user", null) || (() => { const id = "u-" + Math.random().toString(36).slice(2, 10); store.set("brain.user", id); return id; })(),
  history: [],
  chunks: new Map(), // doc chunk id -> chunk meta (global)
  busy: false,
  status: null,
};
const messages = new WeakMap(); // bot message element -> { queries: Map, traceId }

const SUGGESTIONS = [
  { tag: "Data + docs", q: "How bad is the Android crash rate since release 4.2, and is a fix planned?" },
  { tag: "Data + incident notes", q: "How did the September billing incident show up in invoices and support tickets?" },
  { tag: "Data trend", q: "Are EU customers seeing ingestion delays? Show the trend and the status of the fix." },
  { tag: "Data · deprecation", q: "How many workspaces still use Reports v1, and is usage on track for the deprecation?" },
  { tag: "Policies · conflict detection", q: "What's the meal per diem when I travel internationally?" },
  { tag: "Knowledge graph · impact", q: "What breaks if the Query Engine goes down, and who should I contact?" },
  { tag: "Permissions (try Engineer vs Manager)", q: "What is the salary band for a Staff Engineer?" },
  { tag: "Knowledge gap", q: "What's the parking policy at the Austin office?" },
];

const HR_SUGGESTIONS = [
  { tag: "Performance", q: "How are manager ratings distributed in the most recent completed review cycle?" },
  { tag: "Self vs manager", q: "Where do self-assessments differ most from manager ratings, by department?" },
  { tag: "Process health", q: "Which departments have the lowest review completion rates, and how many reviews are still not started?" },
  { tag: "Competencies", q: "Which competency areas get the lowest ratings across the company?" },
  { tag: "Goals", q: "How does goal attainment compare across departments?" },
  { tag: "Org structure", q: "What does the org look like: departments by headcount and the average span of control for managers?" },
  { tag: "Feedback culture", q: "Which teams give and receive the most feedback, and how much of it is anonymous?" },
  { tag: "Org lookup", q: "Who leads the largest department and how many people managers report into it?" },
];

function renderSuggestions() {
  const list = state.persona === "hr" ? HR_SUGGESTIONS : SUGGESTIONS;
  const el = $("#suggestions");
  if (el) el.innerHTML = list.map((s) => `<button data-q="${esc(s.q)}"><span class="tag">${esc(s.tag)}</span>${esc(s.q)}</button>`).join("");
}

async function api(path, opts = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${path}${sep}persona=${state.persona}`, { headers: { "Content-Type": "application/json" }, ...opts });
  if (r.status === 401) { location.reload(); throw new Error("Login required"); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 403 && data.hrLocked) { state.persona = "engineer"; $("#persona").value = "engineer"; renderSuggestions(); }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/* ---------------- Init ---------------- */

async function init() {
  const status = (state.status = await api("/api/status"));
  $("#company").textContent = status.company;
  $$(".company-name").forEach((e) => (e.textContent = status.company));
  $("#mode").textContent =
    (status.ai ? `AI: ${status.model}` : "Search-only (no API key)") +
    (status.clickhouse ? " · ClickHouse connected" : " · ClickHouse offline") +
    (status.knowledgeBackend === "hydradb" ? " · Search: HydraDB" : "");
  const personaOptions = status.personas.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("");
  $("#persona").innerHTML = personaOptions;
  $("#schedule-persona").innerHTML = personaOptions;
  $("#persona").value = state.persona;
  renderStats(status.stats);
  renderSuggestions();
  loadMemory();
  const graph = await api("/api/graph");
  $("#entity-list").innerHTML = graph.entities.map((e) => `<option value="${esc(e.name)}">${esc(e.type)}</option>`).join("");
}

function renderStats(s) {
  $("#source-list").innerHTML = Object.entries(s.bySource).map(([k, v]) => `<li><span>${esc(k)}</span><span class="muted">${v}</span></li>`).join("") +
    (state.status?.clickhouse ? `<li><span>analytics (ClickHouse)</span><span class="muted">4 tables</span></li>` : "");
  $("#index-stats").textContent = `${s.docs} docs · ${s.chunks} chunks · ${s.entities} entities · ${s.relations} relations`;
  $("#gap-count").textContent = s.gaps || "";
  $("#kb-filter").innerHTML = `<option value="">All sources</option>` + Object.keys(s.bySource).map((k) => `<option>${esc(k)}</option>`).join("");
  $("#type-list").innerHTML = Object.keys(s.bySource).map((k) => `<option value="${esc(k)}">`).join("");
}

async function refreshStats() {
  const status = await api("/api/status");
  state.status = status;
  renderStats(status.stats);
}

async function loadMemory() {
  const mems = await api(`/api/memory?user=${state.userId}`);
  $("#memory-list").innerHTML = mems.length
    ? mems.map((m) => `<li><span>${esc(m.fact)}</span><button data-forget="${m.id}" title="Forget" aria-label="Forget">${icon("x", "ico-sm")}</button></li>`).join("")
    : `<li class="muted small">Nothing yet. Tell me your team or role.</li>`;
}

/* ---------------- Navigation ---------------- */

function show(view) {
  $$(".nav").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (view === "knowledge") loadKnowledge();
  if (view === "gaps") loadGaps();
  if (view === "data") loadData();
  if (view === "traces") loadTraces();
  if (view === "reports") loadReports();
  if (view === "graph") setGraphMode(state.graphMode ?? (state.status?.hrAvailable ? "org" : "knowledge"));
}

/* ---------------- Ask ---------------- */

function addMessage(role, html) {
  $("#empty")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.innerHTML = `<div class="bubble">${html}</div>`;
  $("#chat").appendChild(el);
  el.scrollIntoView({ block: "end" });
  return el;
}

/** Step chip content: a Lucide icon name and plain text (escaped when rendered). */
function stepLabel(s) {
  switch (s.kind) {
    case "search": return { icon: s.fallback ? "triangle-alert" : "search", text: `${s.backend === "hydradb" ? "HydraDB " : ""}“${s.query}”${s.sourceTypes?.length ? ` in ${s.sourceTypes.join(", ")}` : ""} · ${s.results.length}` };
    case "read": return { icon: "file-text", text: `Read “${s.title}”` };
    case "graph": return { icon: "network", text: `Graph: ${s.entity} · ${s.edges.length} links` };
    case "gap": return { icon: "circle-help", text: "Flagged knowledge gap" };
    case "memory": return { icon: "pin", text: `Remembered: ${s.fact}` };
    case "analyst": return { icon: "bot", text: s.label };
    case "schema": return { icon: "folder-tree", text: s.label };
    case "values": return { icon: "whole-word", text: s.label };
    case "org": return { icon: "list-tree", text: s.label };
    default: return { icon: "sparkles", text: s.label || s.kind };
  }
}

function lookupFor(msg) {
  return (id) => (id.startsWith("q") ? msg.queries.get(id) : state.chunks.get(id));
}

async function ask(question) {
  if (state.busy || !question.trim()) return;
  state.busy = true;
  $("#send").disabled = true;
  addMessage("user", esc(question));
  const bot = addMessage("bot", `<div class="trail"></div><div class="approvals"></div><div class="answer"><div class="thinking"><span class="dot"></span>Thinking…</div></div><div class="charts"></div><div class="msg-foot"><span class="meta-line"></span><span class="actions"></span></div>`);
  const msg = { queries: new Map(), traceId: null };
  messages.set(bot, msg);
  const trail = $(".trail", bot);
  const answerEl = $(".answer", bot);
  let text = "";
  let raf = 0;
  const paint = () => { raf = 0; answerEl.innerHTML = text ? renderAnswer(text, lookupFor(msg)) : answerEl.innerHTML; };
  const chip = (label, cls = "", onclick) => {
    const c = document.createElement("span");
    c.className = `step ${cls}${onclick ? " clickable" : ""}`;
    c.innerHTML = `${icon(label.icon)}<span>${esc(label.text)}</span>`;
    if (onclick) c.onclick = onclick;
    trail.appendChild(c);
    return c;
  };

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history: state.history, persona: state.persona, userId: state.userId }),
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = raw.match(/^event: (.+)$/m)?.[1];
        const dataLine = raw.match(/^data: (.+)$/m)?.[1];
        if (!event || !dataLine) continue;
        const data = JSON.parse(dataLine);
        handleEvent(event, data);
      }
    }
    if (raf) cancelAnimationFrame(raf);
    paint();
    state.history.push({ role: "user", content: question }, { role: "assistant", content: text });
  } catch (err) {
    answerEl.innerHTML = `<div class="error">${esc(err.message)}</div>`;
  } finally {
    state.busy = false;
    $("#send").disabled = false;
    $(".thinking", bot)?.remove();
  }

  function handleEvent(event, data) {
    switch (event) {
      case "trace":
        msg.traceId = data.traceId;
        break;
      case "step":
        (data.results ?? []).forEach((c) => state.chunks.set(c.id, c));
        const c = chip(stepLabel(data), data.kind, data.kind === "graph" ? () => { show("graph"); exploreGraph(data.entity); } : null);
        if (data.fallback) c.title = `Used local search instead: ${data.fallback}`;
        if (data.kind === "gap" || data.kind === "memory") { refreshStats(); loadMemory(); }
        if (data.kind === "analyst") answerEl.innerHTML = `<div class="thinking"><span class="dot"></span>Analysing data in ClickHouse…</div>`;
        break;
      case "query":
        msg.queries.set(data.id, data);
        chip(
          data.error ? { icon: "triangle-alert", text: `SQL ${data.id}: ${data.error}` } : { icon: "zap", text: `SQL ${data.id} · ${fmtNum(data.rowsRead)} rows in ${data.elapsedMs} ms` },
          data.error ? "gap" : "sql",
          () => openQuery(data),
        );
        break;
      case "chart": {
        const box = document.createElement("div");
        $(".charts", bot).appendChild(box);
        renderChart(box, data);
        break;
      }
      case "approval": {
        const card = document.createElement("div");
        card.className = "approval";
        card.dataset.id = data.id;
        card.innerHTML = `<div class="row">${icon("circle-pause")}<span><strong>Approval needed:</strong> the data analyst wants to scan ~${fmtNum(data.estimatedRows)} rows.</span></div>
          <div class="muted small">${esc(data.purpose)}</div><pre class="sql">${esc(data.sql)}</pre>
          <div class="row"><button class="primary" data-approve="${data.id}">Approve</button><button data-deny="${data.id}">Deny</button><span class="muted small">Auto-denies in ${Math.round(data.timeoutSec / 60)} min</span></div>`;
        $(".approvals", bot).appendChild(card);
        card.scrollIntoView({ block: "nearest" });
        break;
      }
      case "approval_resolved": {
        const card = $(`.approval[data-id="${data.id}"]`, bot);
        if (card) card.outerHTML = `<div class="approval resolved ${data.approved ? "ok" : "denied"}">${icon(data.approved ? "circle-check" : "circle-x")}<span>${data.approved ? "Approved" : "Denied"} heavy query</span></div>`;
        break;
      }
      case "delta":
        text += data.text;
        if (!raf) raf = requestAnimationFrame(paint);
        break;
      case "done": {
        msg.traceId = data.traceId;
        const u = data.usage ?? {};
        $(".meta-line", bot).textContent =
          data.mode === "ai" ? `${(u.latency_ms / 1000).toFixed(1)}s · ${fmtNum(u.input_tokens + u.output_tokens)} tokens · $${(u.cost_usd ?? 0).toFixed(4)}` : data.mode;
        $(".actions", bot).innerHTML = `<button class="small-btn" data-feedback="1" title="Helpful" aria-label="Helpful">${icon("thumbs-up")}</button><button class="small-btn" data-feedback="-1" title="Not helpful" aria-label="Not helpful">${icon("thumbs-down")}</button>
          <button class="small-btn" data-share>${icon("share-2")}Share report</button><button class="small-btn" data-open-trace="${data.traceId}">${icon("telescope")}Trace</button>`;
        break;
      }
      case "error":
        text += `\n\n**Error:** ${data.message}`;
        break;
    }
  }
}

/* ---------------- Drawers ---------------- */

function openDrawer(title, meta, html) {
  $("#drawer").hidden = false;
  $("#drawer-title").textContent = title;
  $("#drawer-meta").innerHTML = meta;
  $("#drawer-body").innerHTML = html;
}

function openQuery(q) {
  openDrawer(`Query ${q.id}`, "SQL audit trail · ClickHouse", queryHtml(q));
}

async function openDoc(docId, highlightChunk) {
  openDrawer("Loading…", "", "");
  try {
    const doc = await api(`/api/document?id=${encodeURIComponent(docId)}`);
    const meta = [doc.sourceType, doc.owner, doc.updated && `updated ${doc.updated}`, doc.status, doc.access.includes("all") ? null : `Restricted to ${doc.access.join(", ")}`].filter(Boolean).map(esc).join(" · ");
    const body = doc.chunks
      .map((c) => `<div class="chunk ${c.id === highlightChunk ? "hl" : ""}" id="chunk-${c.id}">${c.heading ? `<div class="chunk-h">${esc(c.heading)}<span class="chunk-id">${c.id}</span></div>` : ""}${DOMPurify.sanitize(marked.parse(c.text))}</div>`)
      .join("");
    openDrawer(doc.title, meta, `<div class="md">${body}</div>`);
    if (highlightChunk) document.getElementById(`chunk-${highlightChunk}`)?.scrollIntoView({ block: "center" });
  } catch (err) {
    openDrawer("Unavailable", "", `<p class="error">${esc(err.message)}</p>`);
  }
}

/* ---------------- Knowledge ---------------- */

async function loadKnowledge() {
  const q = $("#kb-search").value.trim();
  const filter = $("#kb-filter").value;
  const out = $("#kb-results");
  if (q) {
    const hits = (await api(`/api/search?q=${encodeURIComponent(q)}`)).filter((h) => !filter || h.sourceType === filter);
    hits.forEach((c) => state.chunks.set(c.id, c));
    out.innerHTML = hits.length
      ? hits.map((h) => `<div class="card" data-doc="${esc(h.docId)}" data-chunk="${h.id}"><div class="row"><span class="pill">${esc(h.sourceType)}</span><span class="muted small">score ${h.score}</span></div><h4>${esc(h.title)}${h.heading ? ` › ${esc(h.heading)}` : ""}</h4><div class="preview">${esc(h.text)}</div></div>`).join("")
      : `<p class="muted">No matches.</p>`;
    return;
  }
  const docs = await api("/api/documents");
  out.innerHTML = docs
    .filter((d) => !filter || d.sourceType === filter)
    .map((d) => `<div class="card ${d.locked ? "locked" : ""}" data-doc="${d.locked ? "" : esc(d.id)}">
      <div class="row"><span class="pill">${esc(d.sourceType)}</span>${d.updated ? `<span class="pill">${esc(d.updated)}</span>` : ""}${d.status === "superseded" ? `<span class="pill superseded">superseded</span>` : ""}${d.access.includes("all") ? "" : `<span class="pill lock">${icon("lock", "ico-sm")}${esc(d.access.join(", "))}</span>`}</div>
      <h4>${esc(d.title)}</h4>
      <div class="preview">${d.locked ? "Restricted for your current persona." : esc(d.preview)}</div>
      ${d.owner ? `<div class="muted small">${esc(d.owner)}</div>` : ""}</div>`)
    .join("");
}

/* ---------------- Graph ---------------- */

const TYPE_COLORS = { TEAM: "#eb6834", SERVICE: "#2a78d6", DATASTORE: "#1baf7a", VENDOR: "#4a3aa7", FEATURE: "#008300", INCIDENT: "#e34948", TOOL: "#eda100", PERSON: "#e87ba4" };

async function exploreGraph(name) {
  $("#graph-q").value = name;
  const out = $("#graph-out");
  const g = await api(`/api/graph?entity=${encodeURIComponent(name)}`).catch(() => null);
  if (!g) { out.innerHTML = `<p class="muted">No entity matching “${esc(name)}”.</p>`; return; }
  const level = new Map([[g.entity.name, 0]]);
  for (let pass = 0; pass < 3; pass++)
    for (const e of g.edges)
      for (const [a, b] of [[e.from, e.to], [e.to, e.from]])
        if (level.has(a) && !level.has(b)) level.set(b, level.get(a) + 1);
  const W = 900, H = 560, cx = W / 2, cy = H / 2 - 10;
  const rings = {};
  for (const n of g.nodes) (rings[level.get(n.name) ?? 2] ??= []).push(n);
  const pos = {};
  for (const [lvl, nodes] of Object.entries(rings)) {
    const r = Number(lvl) === 0 ? 0 : Number(lvl) === 1 ? 150 : 235;
    nodes.forEach((n, i) => {
      const a = (i / nodes.length) * Math.PI * 2 + (Number(lvl) === 2 ? 0.3 : 0);
      pos[n.name] = { x: cx + r * Math.cos(a) * 1.5, y: cy + r * Math.sin(a) };
    });
  }
  const types = Object.fromEntries(g.nodes.map((n) => [n.name, n.type]));
  const edges = g.edges.map((e) => {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) return "";
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="currentColor" stroke-opacity=".22" stroke-width="1.5" />
      <text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 3}" font-size="9.5" text-anchor="middle" fill="currentColor" fill-opacity=".55">${esc(e.predicate)}</text>`;
  }).join("");
  const nodes = g.nodes.map((n) => {
    const p = pos[n.name];
    const root = n.name === g.entity.name;
    return `<g class="entity-chip" data-entity="${esc(n.name)}" style="cursor:pointer">
      <circle cx="${p.x}" cy="${p.y}" r="${root ? 11 : 7}" fill="${TYPE_COLORS[types[n.name]] ?? "#888"}" stroke="var(--panel)" stroke-width="2" />
      <text x="${p.x}" y="${p.y + (root ? 26 : 20)}" font-size="${root ? 14 : 12}" font-weight="${root ? 700 : 500}" text-anchor="middle" fill="currentColor">${esc(n.name)}</text></g>`;
  }).join("");
  const legend = Object.entries(TYPE_COLORS).map(([t, c], i) => `<g transform="translate(${16 + i * 108},${H - 12})"><circle r="5" fill="${c}" cy="-4"/><text x="10" font-size="11" fill="currentColor" fill-opacity=".7">${t}</text></g>`).join("");
  out.innerHTML = `<div class="graph-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Graph around ${esc(g.entity.name)}">${edges}${nodes}${legend}</svg></div>
    <div class="edge-list">${g.edges.map((e) => `<div><span class="entity-chip" data-entity="${esc(e.from)}">${esc(e.from)}</span> <span class="pred">${esc(e.predicate)}</span> <span class="entity-chip" data-entity="${esc(e.to)}">${esc(e.to)}</span> <span class="muted small">${esc(e.context ?? "")}</span></div>`).join("")}</div>`;
}

/* ---------------- Data ---------------- */

const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);

async function loadData() {
  const d = await api("/api/data/tables");
  $("#ch-status").textContent = d.up ? `ClickHouse connected · ${d.url} · database ${d.database}` : "ClickHouse not running";
  if (!d.up) {
    $("#storage-cards").innerHTML = `<p class="error">ClickHouse is not reachable. Run <code>npm run db:install</code> and restart.</p>`;
    return;
  }
  const total = d.storage.reduce((a, s) => ({ rows: a.rows + s.rows, c: a.c + s.compressed, u: a.u + s.uncompressed }), { rows: 0, c: 0, u: 0 });
  $("#storage-cards").innerHTML = `
    <div class="stat"><div class="stat-v">${fmtNum(total.rows)}</div><div class="muted small">rows</div></div>
    <div class="stat"><div class="stat-v">${mb(total.u)}</div><div class="muted small">uncompressed</div></div>
    <div class="stat"><div class="stat-v">${mb(total.c)}</div><div class="muted small">on disk</div></div>
    <div class="stat"><div class="stat-v">${(total.u / Math.max(1, total.c)).toFixed(1)}×</div><div class="muted small">compression</div></div>`;
  $("#tables-out").innerHTML = d.tables
    .map((t) => `<details class="table-card"><summary><strong>${esc(d.database)}.${esc(t.table)}</strong> <span class="pill">${fmtNum(t.rows)} rows</span> <span class="muted small">${esc(t.comment)}</span></summary>
      <div class="muted small">sort key: <code>${esc(t.sortingKey)}</code></div>
      ${tableHtml([{ name: "column" }, { name: "type" }, { name: "comment" }], t.columns.map((c) => ({ column: c.name, type: c.type, comment: c.comment })))}</details>`)
    .join("");
  $("#skills-out").innerHTML = d.skills.map((s) => `<details class="table-card"><summary><strong>${esc(s.name)}</strong></summary><div class="md">${DOMPurify.sanitize(marked.parse(s.content))}</div></details>`).join("");
}

$("#sql-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#sql-stats").textContent = "Running…";
  try {
    const r = await api("/api/data/query", { method: "POST", body: JSON.stringify({ sql: $("#sql-input").value }) });
    $("#sql-stats").textContent = `${r.rowCount.toLocaleString()} rows · scanned ${fmtNum(r.rowsRead)} rows (${fmtNum(r.bytesRead)}B) in ${r.elapsedMs} ms`;
    $("#sql-out").innerHTML = tableHtml(r.columns, r.rows, 200);
  } catch (err) {
    $("#sql-stats").textContent = "";
    $("#sql-out").innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
});
$("#sql-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#sql-form").requestSubmit(); });

/* ---------------- Traces ---------------- */

async function loadTraces() {
  const d = await api("/api/traces");
  $("#trace-backend").textContent = `stored in ${d.backend === "clickhouse" ? "ClickHouse (brain.traces / brain.spans)" : "data/traces.jsonl"}`;
  const s = d.stats ?? {};
  $("#trace-stats").innerHTML = `
    <div class="stat"><div class="stat-v">${fmtNum(s.traces ?? 0)}</div><div class="muted small">questions</div></div>
    <div class="stat"><div class="stat-v">${((s.avg_latency_ms ?? 0) / 1000).toFixed(1)}s</div><div class="muted small">avg latency</div></div>
    <div class="stat"><div class="stat-v">${((s.p95_latency_ms ?? 0) / 1000).toFixed(1)}s</div><div class="muted small">p95 latency</div></div>
    <div class="stat"><div class="stat-v">$${Number(s.total_cost_usd ?? 0).toFixed(3)}</div><div class="muted small">total cost</div></div>`;
  $("#traces-out").innerHTML = d.traces.length
    ? `<div class="table-wrap"><table class="data clickable-rows"><thead><tr><th>When</th><th>Question</th><th>Source</th><th>Persona</th><th>Mode</th><th class="n">Latency</th><th class="n">Tokens</th><th class="n">Cost</th><th class="n">Tools</th><th>Feedback</th></tr></thead><tbody>
      ${d.traces.map((t) => `<tr data-open-trace="${t.trace_id}"><td>${esc(new Date(t.created_at.replace(" ", "T") + (t.created_at.endsWith("Z") ? "" : "Z")).toLocaleString())}</td><td>${esc(t.question.slice(0, 90))}</td><td>${esc(t.source)}</td><td>${esc(t.persona)}</td><td>${esc(t.mode)}</td>
        <td class="n">${(t.latency_ms / 1000).toFixed(1)}s</td><td class="n">${fmtNum(t.input_tokens + t.output_tokens)}</td><td class="n">$${Number(t.cost_usd).toFixed(4)}</td><td class="n">${t.tool_calls}</td><td>${t.feedback > 0 ? `${icon("thumbs-up", "ico-sm")} helpful` : t.feedback < 0 ? `${icon("thumbs-down", "ico-sm")} not helpful` : ""}</td></tr>`).join("")}
      </tbody></table></div>`
    : `<p class="muted">No traces yet. Ask a question first.</p>`;
}

async function openTrace(id) {
  openDrawer("Loading trace…", "", "");
  const { trace, spans } = await api(`/api/trace?id=${id}`);
  const t0 = new Date(trace.created_at.replace(" ", "T") + (String(trace.created_at).endsWith("Z") ? "" : "Z")).getTime();
  const parse = (s) => new Date(String(s.start_time).replace(" ", "T") + (String(s.start_time).endsWith("Z") ? "" : "Z")).getTime();
  const total = Math.max(trace.latency_ms, ...spans.map((s) => parse(s) - t0 + s.duration_ms), 1);
  const depth = new Map();
  const byId = new Map(spans.map((s) => [s.span_id, s]));
  const d = (s) => (depth.has(s.span_id) ? depth.get(s.span_id) : (depth.set(s.span_id, s.parent_id && byId.has(s.parent_id) ? d(byId.get(s.parent_id)) + 1 : 0), depth.get(s.span_id)));
  const rows = spans
    .map((s, i) => {
      const left = ((parse(s) - t0) / total) * 100;
      const width = Math.max((s.duration_ms / total) * 100, 0.4);
      const info = s.kind === "generation" ? `${fmtNum(s.input_tokens + s.cache_read_tokens)} in / ${fmtNum(s.output_tokens)} out · $${Number(s.cost_usd).toFixed(4)}${s.ttft_ms ? ` · TTFT ${s.ttft_ms} ms` : ""}` : "";
      return `<div class="span-row" data-span="${i}"><div class="span-name" style="padding-left:${d(s) * 14}px"><span class="kind ${s.kind}">${s.kind}</span> ${esc(s.name)}${s.status === "error" ? ` ${icon("triangle-alert", "ico-sm")}` : ""}</div>
        <div class="span-bar-wrap"><div class="span-bar ${s.kind}" style="left:${left}%;width:${width}%"></div></div><div class="span-dur">${s.duration_ms} ms</div></div>
        <div class="span-detail" hidden><div class="muted small">${esc(s.model)} ${info}</div><div class="io"><div><div class="muted small">Input</div><pre>${esc(s.input)}</pre></div><div><div class="muted small">Output</div><pre>${esc(s.output)}</pre></div></div></div>`;
    })
    .join("");
  openDrawer(
    trace.question.slice(0, 120),
    `${esc(trace.source)} · ${esc(trace.persona)} · ${(trace.latency_ms / 1000).toFixed(2)}s · ${fmtNum(trace.input_tokens + trace.output_tokens)} tokens · $${Number(trace.cost_usd).toFixed(4)}`,
    `<div class="waterfall">${rows || '<p class="muted">No spans.</p>'}</div><h4>Answer</h4><div class="md">${DOMPurify.sanitize(marked.parse(trace.answer || ""))}</div>`,
  );
  $$("#drawer .span-row").forEach((r) => (r.onclick = () => { const det = r.nextElementSibling; det.hidden = !det.hidden; }));
  $("#drawer").classList.add("wide");
}

/* ---------------- Reports & schedules ---------------- */

async function loadReports() {
  const [schedules, reports] = await Promise.all([api("/api/schedules"), api("/api/reports")]);
  $("#schedules-out").innerHTML = schedules.length
    ? schedules.map((s) => `<div class="gap-row"><div class="count">${icon("calendar-clock")}</div><div class="grow"><div class="q">${esc(s.title)}</div>
        <div class="muted small">${esc(s.frequency === "minutes" ? `every ${s.minutes} min` : s.frequency === "hourly" ? "hourly" : `${s.frequency} at ${s.time}`)} · as ${esc(s.persona)} · next ${new Date(s.nextRun).toLocaleString()}${s.lastRun ? ` · last ${new Date(s.lastRun).toLocaleString()} (${esc(s.lastStatus)})` : ""}</div></div>
        ${s.lastReportId ? `<a class="small-btn" href="/r/${s.lastReportId}" target="_blank">Last report</a>` : ""}<button class="small-btn" data-run-schedule="${s.id}">Run now</button><button class="small-btn" data-del-schedule="${s.id}">Delete</button></div>`).join("")
    : `<p class="muted small">No scheduled questions yet.</p>`;
  $("#reports-out").innerHTML = reports.length
    ? reports.map((r) => `<a class="gap-row report-link" href="/r/${r.id}" target="_blank"><div class="count">${icon(r.source === "schedule" ? "calendar-clock" : "link")}</div><div class="grow"><div class="q">${esc(r.title)}</div>
        <div class="muted small">${new Date(r.createdAt).toLocaleString()} · ${r.queries} queries · ${r.charts} charts · as ${esc(r.persona)}</div></div></a>`).join("")
    : `<p class="muted small">No reports yet. Use “Share report” under an answer.</p>`;
}

$("#schedule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const frequency = f.frequency.value;
  await api("/api/schedules", {
    method: "POST",
    body: JSON.stringify({ question: f.question.value, frequency, time: f.time.value, persona: f.persona.value, minutes: frequency === "minutes" ? 15 : undefined }),
  });
  f.question.value = "";
  loadReports();
});

/* ---------------- Gaps ---------------- */

async function loadGaps() {
  const gaps = await api("/api/gaps");
  $("#gaps-out").innerHTML = gaps.length
    ? gaps.map((g) => `<div class="gap-row ${g.resolved ? "resolved" : ""}"><div class="count" title="times asked">×${g.count}</div>
        <div class="grow"><div class="q">${esc(g.question)}</div><div class="muted small">${esc(g.reason)}</div>
        <div class="muted small">asked by ${esc(g.persona)} · last ${new Date(g.lastAsked).toLocaleString()}</div></div>
        ${g.resolved ? `<span class="pill">resolved</span>` : `<button data-fill="${esc(g.question)}">Add answer</button><button data-resolve="${g.id}">Resolve</button>`}</div>`).join("")
    : `<p class="muted">No gaps yet. Ask something the knowledge base doesn't cover to see one appear.</p>`;
}

/* ---------------- Add knowledge ---------------- */

function openAdd(prefillTitle = "") {
  const f = $("#add-form");
  f.reset();
  f.title.value = prefillTitle;
  $("#add-error").textContent = "";
  toggleMode();
  $("#add-dialog").showModal();
}
function toggleMode() {
  const url = $("#add-form").mode.value === "url";
  $(".mode-url").hidden = !url;
  $(".mode-paste").hidden = url;
}

/* ---------------- Events ---------------- */

document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-cite],[data-chunk],[data-doc],[data-q],[data-entity],[data-resolve],[data-fill],[data-forget],[data-approve],[data-deny],[data-feedback],[data-share],[data-open-trace],[data-run-schedule],[data-del-schedule],.nav");
  if (!t) return;
  if (t.classList.contains("nav")) return show(t.dataset.view);
  if (t.dataset.q) return ask(t.dataset.q);
  if (t.dataset.entity) return exploreGraph(t.dataset.entity);
  if (t.dataset.resolve) return api("/api/gaps/resolve", { method: "POST", body: JSON.stringify({ id: t.dataset.resolve }) }).then(() => { loadGaps(); refreshStats(); });
  if (t.dataset.fill) return openAdd(t.dataset.fill);
  if (t.dataset.forget) return fetch(`/api/memory?user=${state.userId}&id=${t.dataset.forget}`, { method: "DELETE" }).then(loadMemory);
  if (t.dataset.approve || t.dataset.deny) {
    t.closest(".approval").querySelectorAll("button").forEach((b) => (b.disabled = true));
    return api("/api/approve", { method: "POST", body: JSON.stringify({ id: t.dataset.approve || t.dataset.deny, approved: !!t.dataset.approve }) }).catch((err) => alert(err.message));
  }
  if (t.dataset.openTrace) return openTrace(t.dataset.openTrace);
  if (t.dataset.runSchedule) {
    t.disabled = true;
    t.textContent = "Running…";
    return api("/api/schedules/run", { method: "POST", body: JSON.stringify({ id: t.dataset.runSchedule }) }).then(loadReports).catch((err) => alert(err.message));
  }
  if (t.dataset.delSchedule) return fetch(`/api/schedules?id=${t.dataset.delSchedule}`, { method: "DELETE" }).then(loadReports);
  const bot = t.closest(".msg.bot");
  const msg = bot && messages.get(bot);
  if (t.dataset.feedback && msg) {
    await api("/api/feedback", { method: "POST", body: JSON.stringify({ traceId: msg.traceId, score: Number(t.dataset.feedback) }) });
    $$("[data-feedback]", bot).forEach((b) => b.classList.toggle("chosen", b === t));
    return;
  }
  if (t.dataset.share !== undefined && msg) {
    t.disabled = true;
    try {
      const r = await api("/api/reports", { method: "POST", body: JSON.stringify({ traceId: msg.traceId }) });
      const link = location.origin + r.url;
      navigator.clipboard?.writeText(link).catch(() => {});
      t.outerHTML = `<a class="small-btn" href="${r.url}" target="_blank">${icon("circle-check")}Report: ${esc(r.url)}</a>`;
    } catch (err) {
      t.disabled = false;
      alert(err.message);
    }
    return;
  }
  if (t.dataset.cite) {
    e.preventDefault();
    const id = t.dataset.cite;
    if (id.startsWith("q")) { const q = msg?.queries.get(id); if (q) openQuery(q); return; }
    const c = state.chunks.get(id);
    if (c) openDoc(c.docId, c.id);
    return;
  }
  if (t.dataset.chunk) {
    e.preventDefault();
    const c = state.chunks.get(t.dataset.chunk);
    if (c) openDoc(c.docId, c.id);
    return;
  }
  if (t.dataset.doc) openDoc(t.dataset.doc);
});

$("#ask-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#question").value;
  $("#question").value = "";
  $("#question").style.height = "";
  ask(q);
});
$("#question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#ask-form").requestSubmit(); }
});
$("#question").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; });
$("#persona").addEventListener("change", async (e) => {
  const next = e.target.value;
  if (next === "hr" && state.status?.hrLocked) {
    e.target.value = state.persona; // stay on the current persona until unlocked
    $("#hr-error").textContent = "";
    $("#hr-form").reset();
    $("#hr-dialog").showModal();
    return;
  }
  setPersona(next);
});

function setPersona(id) {
  state.persona = id;
  $("#persona").value = id;
  store.set("brain.persona", id);
  renderSuggestions();
  if ($("#view-knowledge").classList.contains("active")) loadKnowledge();
  if ($("#view-data").classList.contains("active")) loadData();
}

$("#hr-cancel").onclick = () => $("#hr-dialog").close();
$("#hr-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("/api/hr-unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: e.target.password.value }) });
  if (!r.ok) { $("#hr-error").textContent = "Wrong HR password"; return; }
  state.status.hrLocked = false;
  $("#hr-dialog").close();
  setPersona("hr");
});

/* ---------------- Org chart ---------------- */

function setGraphMode(mode) {
  state.graphMode = mode;
  $$("[data-graph-mode]").forEach((b) => b.classList.toggle("active", b.dataset.graphMode === mode));
  $$(".graph-org-only").forEach((el) => (el.hidden = mode !== "org"));
  $$(".graph-knowledge-only").forEach((el) => (el.hidden = mode !== "knowledge"));
  if (mode === "org") loadOrg();
  else if (!$("#graph-out").innerHTML) exploreGraph("Billing Service");
}
$$("[data-graph-mode]").forEach((b) => (b.onclick = () => setGraphMode(b.dataset.graphMode)));

const org = { people: [], byId: new Map(), children: new Map(), size: new Map(), deptColor: new Map(), loaded: false };

async function loadOrg() {
  if (org.loaded) return renderOrg();
  const d = await api("/api/org");
  if (!d.available) {
    $("#org-out").innerHTML = `<p class="muted">No org data yet. Run <code>npm run hr:import</code> to import the org structure from Ascend.</p>`;
    return;
  }
  org.people = d.people;
  org.byId = new Map(d.people.map((p) => [p.id, p]));
  for (const p of d.people) {
    const parent = org.byId.has(p.managerId) ? p.managerId : "";
    if (!org.children.has(parent)) org.children.set(parent, []);
    org.children.get(parent).push(p.id);
  }
  const size = (id) => {
    if (org.size.has(id)) return org.size.get(id);
    org.size.set(id, 1);
    const n = 1 + (org.children.get(id) ?? []).reduce((a, c) => a + size(c), 0);
    org.size.set(id, n);
    return n;
  };
  d.people.forEach((p) => size(p.id));
  for (const kids of org.children.values()) kids.sort((a, b) => org.size.get(b) - org.size.get(a) || org.byId.get(a).name.localeCompare(org.byId.get(b).name));
  const colors = window.BrainUI.palette();
  const depts = [...new Set(d.people.map((p) => p.department).filter(Boolean))].sort();
  depts.forEach((dep, i) => org.deptColor.set(dep, colors[i % colors.length]));
  const managers = d.people.filter((p) => p.directReports > 0);
  const avgSpan = managers.length ? (managers.reduce((a, p) => a + p.directReports, 0) / managers.length).toFixed(1) : "0";
  $("#org-summary").textContent = `${d.people.length} active people · ${depts.length} departments · ${managers.length} people managers (avg ${avgSpan} direct reports). Names are pseudonyms; performance data is HR-only.`;
  org.loaded = true;
  renderOrg();
}

function orgNodeHtml(id, depth, expandTo) {
  const p = org.byId.get(id);
  const kids = org.children.get(id) ?? [];
  const open = depth < 1 || expandTo?.has(id);
  const color = org.deptColor.get(p.department) ?? "var(--muted)";
  return `<div class="org-node" data-org="${id}">
    <div class="org-row"><span class="org-toggle">${kids.length ? icon(open ? "chevron-down" : "chevron-right") : ""}</span><span class="org-dept" style="background:${color}" title="${esc(p.department)}"></span>
      <span class="org-name">${esc(p.name)}</span><span class="org-title">${esc(p.title)}${p.team ? ` · ${esc(p.team)}` : ""}</span>
      <span class="org-count">${kids.length ? `${kids.length} direct · ${org.size.get(id) - 1} total` : ""}</span></div>
    ${kids.length && open ? `<div class="org-children">${kids.map((k) => orgNodeHtml(k, depth + 1, expandTo)).join("")}</div>` : ""}
  </div>`;
}

function renderOrg(expandTo, highlight) {
  const roots = org.children.get("") ?? [];
  roots.sort((a, b) => org.size.get(b) - org.size.get(a));
  $("#org-out").innerHTML = roots.map((r) => orgNodeHtml(r, 0, expandTo)).join("") || `<p class="muted">No people.</p>`;
  if (highlight) {
    const el = $(`.org-node[data-org="${highlight}"]`);
    el?.classList.add("match");
    el?.scrollIntoView({ block: "center" });
  }
}

$("#org-out").addEventListener("click", (e) => {
  const row = e.target.closest(".org-row");
  if (!row) return;
  const node = row.parentElement;
  const id = node.dataset.org;
  const kids = org.children.get(id) ?? [];
  if (!kids.length) return;
  const existing = node.querySelector(":scope > .org-children");
  if (existing) { existing.remove(); row.querySelector(".org-toggle").innerHTML = icon("chevron-right"); return; }
  const depth = 1;
  node.insertAdjacentHTML("beforeend", `<div class="org-children">${kids.map((k) => orgNodeHtml(k, depth + 1)).join("")}</div>`);
  row.querySelector(".org-toggle").innerHTML = icon("chevron-down");
});

let orgTimer;
$("#org-q").addEventListener("input", () => {
  clearTimeout(orgTimer);
  orgTimer = setTimeout(() => {
    const q = $("#org-q").value.trim().toLowerCase();
    if (!org.loaded) return;
    if (!q) return renderOrg();
    const match = org.people.find((p) => p.name.toLowerCase().includes(q)) ?? org.people.find((p) => [p.title, p.team, p.department].some((f) => f.toLowerCase().includes(q)));
    if (!match) { $("#org-out").innerHTML = `<p class="muted">No match for “${esc(q)}”.</p>`; return; }
    const expandTo = new Set();
    for (let m = org.byId.get(match.managerId); m && !expandTo.has(m.id); m = org.byId.get(m.managerId)) expandTo.add(m.id);
    renderOrg(expandTo, match.id);
  }, 200);
});
const closeDrawer = () => { $("#drawer").hidden = true; $("#drawer").classList.remove("wide"); };
$("#drawer-close").onclick = closeDrawer;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

let searchTimer;
$("#kb-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadKnowledge, 200); });
$("#kb-filter").addEventListener("change", loadKnowledge);
$("#reindex-btn").onclick = async () => { await api("/api/reindex", { method: "POST" }); await refreshStats(); loadKnowledge(); };
$("#graph-go").onclick = () => exploreGraph($("#graph-q").value);
$("#graph-q").addEventListener("keydown", (e) => { if (e.key === "Enter") exploreGraph($("#graph-q").value); });

$("#add-btn").onclick = () => openAdd();
$("#add-cancel").onclick = () => $("#add-dialog").close();
$$('#add-form input[name="mode"]').forEach((r) => r.addEventListener("change", toggleMode));
$("#file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const f = $("#add-form");
  f.content.value = await file.text();
  if (!f.title.value) f.title.value = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
});
$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const isUrl = f.mode.value === "url";
  const content = f.content.value;
  let format = "md";
  if (!isUrl && /^\s*[[{]/.test(content)) { try { JSON.parse(content); format = "json"; } catch {} }
  $("#add-submit").disabled = true;
  $("#add-error").textContent = "";
  try {
    await api("/api/ingest", {
      method: "POST",
      body: JSON.stringify({ title: f.title.value, sourceType: f.sourceType.value || "docs", access: f.access.value, content: isUrl ? "" : content, url: isUrl ? f.url.value : undefined, format }),
    });
    $("#add-dialog").close();
    await refreshStats();
    show("knowledge");
  } catch (err) {
    $("#add-error").textContent = err.message;
  } finally {
    $("#add-submit").disabled = false;
  }
});

init().catch((err) => { $("#mode").textContent = "Server unreachable"; console.error(err); });
