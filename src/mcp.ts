// MCP server (stdio): exposes the Company Brain to any MCP client (Claude Code, Claude Desktop…).
// Knowledge search, documents, graph and read-only ClickHouse SQL work without an API key;
// ask_brain runs the full agent (docs + data analyst) and needs ANTHROPIC_API_KEY.
//   claude mcp add company-brain -- node /absolute/path/to/company-brain/src/mcp.ts
// Note: stdout is the MCP channel, so all logging goes to stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
} catch {}

const kb = await import("./kb.ts");
const ch = await import("./clickhouse.ts");
const { ask, aiEnabled, chunkMeta } = await import("./brain.ts");
const { runConsoleQuery } = await import("./analyst.ts");
const { initTraceStore } = await import("./trace.ts");
const { initState } = await import("./state.ts");

await initState();
await kb.reload();
const persona = kb.getPersona(process.env.MCP_PERSONA ?? "engineer");
await ch.ensureServer((m) => console.error(m));
await initTraceStore();

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

const server = new McpServer({ name: "company-brain", version: "1.0.0" });

server.registerTool(
  "search_knowledge",
  {
    title: "Search company knowledge",
    description: "BM25 search over company docs, meeting notes, FAQs, policies, product info, support content and internal tools. Returns passages with citation ids, dates and owners.",
    inputSchema: { query: z.string(), source_types: z.array(z.string()).optional(), limit: z.number().int().min(1).max(10).optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ query, source_types, limit }) => {
    const { hits } = await kb.search(query, persona, { sourceTypes: source_types, limit: limit ?? 6 });
    if (!hits.length) return text(`No results for "${query}".`);
    return text(hits.map(({ chunk: c }) => `[${c.id}] ${c.title}${c.heading ? ` > ${c.heading}` : ""} (${c.sourceType}, updated ${c.updated ?? "?"}${c.status ? `, ${c.status}` : ""}, doc_id ${c.docId})\n${c.text}`).join("\n\n---\n\n"));
  },
);

server.registerTool(
  "read_document",
  { title: "Read a document", description: "Full text of one document by doc_id (from search results).", inputSchema: { doc_id: z.string() }, annotations: { readOnlyHint: true } },
  async ({ doc_id }) => {
    const doc = kb.getDoc(doc_id, persona);
    return doc ? text(`# ${doc.title}\n(owner: ${doc.owner ?? "?"}, updated: ${doc.updated ?? "?"})\n\n${doc.text}`) : text(`No accessible document "${doc_id}".`, true);
  },
);

server.registerTool(
  "explore_graph",
  {
    title: "Explore the knowledge graph",
    description: "Relationships (OWNED_BY, DEPENDS_ON, REPLACED_BY, AFFECTED, MEMBER_OF…) around a team, service, person, feature or incident.",
    inputSchema: { entity: z.string(), depth: z.number().int().min(1).max(3).optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ entity, depth }) => {
    const g = kb.exploreGraph(entity, depth ?? 2);
    if (!g) return text(`No entity matching "${entity}". Known: ${kb.getGraph().entities.map((e) => e.name).join(", ")}`, true);
    return text(g.edges.map((r) => `${r.from} --${r.predicate}--> ${r.to}${r.context ? ` (${r.context})` : ""}`).join("\n"));
  },
);

server.registerTool(
  "list_tables",
  { title: "List analytics tables", description: `Tables, columns and row counts in the ClickHouse analytics database (${ch.ANALYTICS_DB}).`, annotations: { readOnlyHint: true } },
  async () => {
    if (!(await ch.ping())) return text("ClickHouse is not reachable.", true);
    const tables = await ch.listTables();
    return text(tables.map((t) => `${ch.ANALYTICS_DB}.${t.table} (${t.rows.toLocaleString()} rows) — ${t.comment}\n` + t.columns.map((c) => `  ${c.name} ${c.type}${c.comment ? ` -- ${c.comment}` : ""}`).join("\n")).join("\n\n"));
  },
);

server.registerTool(
  "run_select_query",
  {
    title: "Run a read-only SQL query",
    description: "Run one read-only ClickHouse SELECT against the analytics database. Returns up to 1,000 rows as JSON plus scan statistics.",
    inputSchema: { sql: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ sql }) => {
    try {
      const r = await runConsoleQuery(sql, persona.databases);
      return text(JSON.stringify({ rows: r.rows, rowCount: r.rowCount, truncated: r.truncated, elapsedMs: r.elapsedMs, rowsRead: r.rowsRead }, null, 1));
    } catch (err) {
      return text(`Query failed: ${(err as Error).message}`, true);
    }
  },
);

server.registerTool(
  "ask_brain",
  {
    title: "Ask the Company Brain",
    description: "Ask a question in natural language. The Brain agent searches knowledge, walks the graph and delegates data questions to its SQL analyst sub-agent, then returns a cited answer. Requires ANTHROPIC_API_KEY.",
    inputSchema: { question: z.string() },
  },
  async ({ question }) => {
    if (!aiEnabled()) return text("ask_brain needs ANTHROPIC_API_KEY in company-brain/.env. Use search_knowledge / run_select_query instead.", true);
    const result = await ask({ question, history: [], persona, userId: "mcp", source: "mcp", requestApproval: async () => false }, () => {});
    const sources = [...new Set(result.answer.match(/\bc\d+\b/g) ?? [])].map((id) => kb.getChunk(id)).filter((c) => !!c).map((c) => `[${c.id}] ${chunkMeta(c).title}`);
    const queries = result.session.queries.filter((q) => !q.error).map((q) => `[${q.id}] ${q.purpose}\n${q.sql}`);
    return text([result.answer, sources.length ? `\nSources:\n${sources.join("\n")}` : "", queries.length ? `\nQueries:\n${queries.join("\n\n")}` : ""].join("\n"));
  },
);

await server.connect(new StdioServerTransport());
console.error("Company Brain MCP server ready (stdio)");
