// The knowledge base: documents, chunk index, knowledge graph, personas/permissions,
// knowledge gaps and per-user memory. All state is plain JSON on disk under data/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunkDocument, loadDocuments, type Chunk, type Doc } from "./ingest.ts";
import { BM25Index, tokenize, type SearchHit } from "./search.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.BRAIN_DATA_DIR ?? path.join(here, "..", "data");
export const SOURCES_DIR = path.join(DATA_DIR, "sources");
const GRAPH_FILE = path.join(DATA_DIR, "graph.json");
const GAPS_FILE = path.join(DATA_DIR, "gaps.json");
const MEMORY_FILE = path.join(DATA_DIR, "memory.json");

// ---------- Personas & permissions ----------

export interface Persona {
  id: string;
  label: string;
  groups: string[];
  focus: string;
}

export const PERSONAS: Persona[] = [
  { id: "engineer", label: "Engineer", groups: ["all", "engineering"], focus: "implementation details, runbooks, commands, service ownership and dependencies" },
  { id: "manager", label: "Manager", groups: ["all", "managers", "engineering", "sales"], focus: "decisions, timelines, owners, budget and people impact" },
  { id: "support", label: "Support", groups: ["all", "support"], focus: "customer-facing answers, known issues, workarounds, macros and escalation paths" },
  { id: "sales", label: "Sales", groups: ["all", "sales"], focus: "pricing, plans, discounts, competitive positioning and roadmap dates customers care about" },
  { id: "newhire", label: "New hire", groups: ["all"], focus: "clear step-by-step explanations, where to go and who to ask" },
];

export function getPersona(id: unknown): Persona {
  return PERSONAS.find((p) => p.id === id) ?? PERSONAS[0];
}

export function canAccess(item: { access: string[] }, persona: Persona): boolean {
  return item.access.includes("all") || item.access.some((g) => persona.groups.includes(g));
}

// ---------- Documents & index ----------

let docs: Doc[] = [];
let chunks: Chunk[] = [];
let index = new BM25Index([]);
let loadedAt = "";

export function reload(): { docs: number; chunks: number } {
  docs = loadDocuments(SOURCES_DIR);
  chunks = docs.flatMap(chunkDocument).map((c, i) => ({ ...c, id: `c${i + 1}` }));
  index = new BM25Index(chunks);
  graph = loadGraph();
  loadedAt = new Date().toISOString();
  return { docs: docs.length, chunks: chunks.length };
}

export function search(query: string, persona: Persona, opts: { sourceTypes?: string[]; limit?: number } = {}): SearchHit[] {
  const types = opts.sourceTypes?.length ? new Set(opts.sourceTypes) : null;
  return index.search(query, {
    limit: opts.limit,
    filter: (c) => canAccess(c, persona) && (!types || types.has(c.sourceType)),
  });
}

export function getDoc(id: string, persona: Persona): Doc | undefined {
  const d = docs.find((x) => x.id === id);
  return d && canAccess(d, persona) ? d : undefined;
}

export function getChunk(id: string): Chunk | undefined {
  return chunks.find((c) => c.id === id);
}

export function chunksOf(docId: string): Chunk[] {
  return chunks.filter((c) => c.docId === docId);
}

export function listDocs(persona: Persona) {
  return docs.map((d) => ({
    id: d.id,
    title: d.title,
    sourceType: d.sourceType,
    owner: d.owner,
    updated: d.updated,
    status: d.status,
    access: d.access,
    locked: !canAccess(d, persona),
    preview: canAccess(d, persona) ? d.text.replace(/[#*|`>-]/g, " ").replace(/\s+/g, " ").slice(0, 180) : "",
  }));
}

export function stats() {
  const bySource: Record<string, number> = {};
  for (const d of docs) bySource[d.sourceType] = (bySource[d.sourceType] ?? 0) + 1;
  return {
    docs: docs.length,
    chunks: chunks.length,
    entities: graph.entities.length,
    relations: graph.relations.length,
    gaps: readJson<Gap[]>(GAPS_FILE, []).filter((g) => !g.resolved).length,
    bySource,
    loadedAt,
  };
}

// ---------- Ingestion (uploads / paste / URL) ----------

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "untitled";
}

export function addSource(input: { title: string; sourceType: string; content: string; owner?: string; access?: string; format?: "md" | "json" }): string {
  const type = slugify(input.sourceType);
  const dir = path.join(SOURCES_DIR, type);
  fs.mkdirSync(dir, { recursive: true });
  let name = slugify(input.title);
  const ext = input.format === "json" ? "json" : "md";
  for (let n = 2; fs.existsSync(path.join(dir, `${name}.${ext}`)); n++) name = `${slugify(input.title)}-${n}`;
  let body = input.content;
  if (ext === "md") {
    const today = new Date().toISOString().slice(0, 10);
    const fm = [`title: ${input.title.replace(/\n/g, " ")}`, `owner: ${input.owner || "Uploaded"}`, `updated: ${today}`];
    if (input.access && input.access !== "all") fm.push(`access: ${input.access}`);
    body = `---\n${fm.join("\n")}\n---\n\n${input.content.trim()}\n`;
  } else {
    JSON.parse(body); // validate
  }
  fs.writeFileSync(path.join(dir, `${name}.${ext}`), body);
  reload();
  return `${type}/${name}`;
}

// ---------- Knowledge graph ----------

export interface Entity { name: string; type: string; aliases?: string[] }
export interface Relation { from: string; predicate: string; to: string; context?: string }
let graph: { entities: Entity[]; relations: Relation[] } = { entities: [], relations: [] };

function loadGraph() {
  return readJson(GRAPH_FILE, { entities: [] as Entity[], relations: [] as Relation[] });
}

export function getGraph() {
  return graph;
}

export function findEntity(q: string): Entity | undefined {
  const s = q.toLowerCase().trim();
  return (
    graph.entities.find((e) => e.name.toLowerCase() === s || e.aliases?.some((a) => a.toLowerCase() === s)) ??
    graph.entities.find((e) => e.name.toLowerCase().includes(s) || s.includes(e.name.toLowerCase())) ??
    graph.entities.find((e) => e.aliases?.some((a) => s.includes(a.toLowerCase())))
  );
}

/** Breadth-first walk over declared relations (both directions) from an entity. */
export function exploreGraph(name: string, depth = 2) {
  const start = findEntity(name);
  if (!start) return null;
  const seen = new Set([start.name]);
  const edges: Relation[] = [];
  let frontier = [start.name];
  for (let d = 0; d < Math.min(Math.max(depth, 1), 3); d++) {
    const next: string[] = [];
    for (const r of graph.relations) {
      const hitFrom = frontier.includes(r.from);
      const hitTo = frontier.includes(r.to);
      if (!hitFrom && !hitTo) continue;
      if (!edges.includes(r)) edges.push(r);
      for (const n of [r.from, r.to]) if (!seen.has(n)) { seen.add(n); next.push(n); }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  const types = Object.fromEntries(graph.entities.map((e) => [e.name, e.type]));
  return { entity: start, edges, nodes: [...seen].map((n) => ({ name: n, type: types[n] ?? "UNKNOWN" })) };
}

/** Entities mentioned in a piece of text (used to surface related graph context). */
export function entitiesIn(text: string): Entity[] {
  const toks = new Set(tokenize(text));
  const lower = text.toLowerCase();
  return graph.entities.filter((e) =>
    [e.name, ...(e.aliases ?? [])].some((n) => {
      const nl = n.toLowerCase();
      return nl.length > 3 ? lower.includes(nl) : toks.has(nl);
    }),
  );
}

// ---------- Knowledge gaps ----------

export interface Gap { id: string; question: string; reason: string; persona: string; count: number; firstAsked: string; lastAsked: string; resolved?: boolean }

export function flagGap(question: string, reason: string, persona: string): Gap {
  const gaps = readJson<Gap[]>(GAPS_FILE, []);
  const key = question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const now = new Date().toISOString();
  let gap = gaps.find((g) => g.question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === key);
  if (gap) {
    gap.count++;
    gap.lastAsked = now;
    gap.reason = reason;
    gap.resolved = false;
  } else {
    gap = { id: `g${Date.now().toString(36)}`, question, reason, persona, count: 1, firstAsked: now, lastAsked: now };
    gaps.push(gap);
  }
  writeJson(GAPS_FILE, gaps);
  return gap;
}

export function listGaps(): Gap[] {
  return readJson<Gap[]>(GAPS_FILE, []).sort((a, b) => Number(!!a.resolved) - Number(!!b.resolved) || b.lastAsked.localeCompare(a.lastAsked));
}

export function resolveGap(id: string): boolean {
  const gaps = readJson<Gap[]>(GAPS_FILE, []);
  const g = gaps.find((x) => x.id === id);
  if (!g) return false;
  g.resolved = true;
  writeJson(GAPS_FILE, gaps);
  return true;
}

// ---------- Per-user memory ----------

export interface Memory { id: string; fact: string; at: string }

export function getMemories(userId: string): Memory[] {
  return readJson<Record<string, Memory[]>>(MEMORY_FILE, {})[userId] ?? [];
}

export function remember(userId: string, fact: string): Memory {
  const all = readJson<Record<string, Memory[]>>(MEMORY_FILE, {});
  const list = (all[userId] ??= []);
  const m = { id: `m${Date.now().toString(36)}`, fact: fact.trim().slice(0, 300), at: new Date().toISOString() };
  list.push(m);
  if (list.length > 30) list.shift();
  writeJson(MEMORY_FILE, all);
  return m;
}

export function forget(userId: string, id: string): void {
  const all = readJson<Record<string, Memory[]>>(MEMORY_FILE, {});
  all[userId] = (all[userId] ?? []).filter((m) => m.id !== id);
  writeJson(MEMORY_FILE, all);
}

// ---------- helpers ----------

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
