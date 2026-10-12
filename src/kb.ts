// The knowledge base: documents, chunk index, knowledge graph, personas/permissions,
// knowledge gaps and per-user memory. Repo sources are read from data/; uploads, gaps and
// memory live in the state store (ClickHouse or local files, see state.ts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunkDocument, loadDocuments, parseSource, type Chunk, type Doc } from "./ingest.ts";
import { BM25Index, tokenize, type SearchHit } from "./search.ts";
import * as state from "./state.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.BRAIN_DATA_DIR ?? path.join(here, "..", "data");
export const SOURCES_DIR = path.join(DATA_DIR, "sources");
const GRAPH_FILE = path.join(DATA_DIR, "graph.json");

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
let loadedVersion = -1;

interface UploadedSource { sourceType: string; file: string; content: string }

/** Rebuild the index from repo sources plus uploaded sources (uploads come last so repo chunk ids stay stable). */
export async function reload(): Promise<{ docs: number; chunks: number }> {
  const uploads = await state.list<UploadedSource>("source");
  loadedVersion = (await state.get<number>("meta", "sources_version")) ?? 0;
  docs = loadDocuments(SOURCES_DIR);
  for (const { value: u } of uploads.sort((a, b) => a.key.localeCompare(b.key))) {
    try {
      docs.push(...parseSource(u.sourceType, u.file, u.content));
    } catch (err) {
      console.warn(`[kb] skipped upload ${u.sourceType}/${u.file}: ${(err as Error).message}`);
    }
  }
  chunks = docs.flatMap(chunkDocument).map((c, i) => ({ ...c, id: `c${i + 1}` }));
  index = new BM25Index(chunks);
  graph = loadGraph();
  loadedAt = new Date().toISOString();
  return { docs: docs.length, chunks: chunks.length };
}

/** Reload if another instance added sources since we last indexed (cheap version check). */
export async function ensureFresh(): Promise<void> {
  const v = (await state.get<number>("meta", "sources_version")) ?? 0;
  if (v !== loadedVersion) await reload();
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

export async function stats() {
  const bySource: Record<string, number> = {};
  for (const d of docs) bySource[d.sourceType] = (bySource[d.sourceType] ?? 0) + 1;
  return {
    docs: docs.length,
    chunks: chunks.length,
    entities: graph.entities.length,
    relations: graph.relations.length,
    gaps: (await listGaps()).filter((g) => !g.resolved).length,
    bySource,
    loadedAt,
  };
}

// ---------- Ingestion (uploads / paste / URL) ----------

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "untitled";
}

export async function addSource(input: { title: string; sourceType: string; content: string; owner?: string; access?: string; format?: "md" | "json" }): Promise<string> {
  const type = slugify(input.sourceType);
  const ext = input.format === "json" ? "json" : "md";
  const existing = new Set((await state.list<UploadedSource>("source")).map((s) => s.key));
  let name = slugify(input.title);
  for (let n = 2; existing.has(`${type}/${name}.${ext}`) || fs.existsSync(path.join(SOURCES_DIR, type, `${name}.${ext}`)); n++) name = `${slugify(input.title)}-${n}`;
  let content = input.content;
  if (ext === "md") {
    const today = new Date().toISOString().slice(0, 10);
    const fm = [`title: ${input.title.replace(/\n/g, " ")}`, `owner: ${input.owner || "Uploaded"}`, `updated: ${today}`];
    if (input.access && input.access !== "all") fm.push(`access: ${input.access}`);
    content = `---\n${fm.join("\n")}\n---\n\n${input.content.trim()}\n`;
  } else {
    JSON.parse(content); // validate
  }
  await state.put("source", `${type}/${name}.${ext}`, { sourceType: type, file: `${name}.${ext}`, content } satisfies UploadedSource);
  await state.put("meta", "sources_version", Date.now());
  await reload();
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

const gapKey = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 180);

export async function flagGap(question: string, reason: string, persona: string): Promise<Gap> {
  const key = gapKey(question);
  const now = new Date().toISOString();
  const existing = await state.get<Gap>("gap", key);
  const gap: Gap = existing
    ? { ...existing, count: existing.count + 1, lastAsked: now, reason, resolved: false }
    : { id: key, question, reason, persona, count: 1, firstAsked: now, lastAsked: now };
  await state.put("gap", key, gap);
  return gap;
}

export async function listGaps(): Promise<Gap[]> {
  return (await state.list<Gap>("gap"))
    .map((g) => g.value)
    .sort((a, b) => Number(!!a.resolved) - Number(!!b.resolved) || b.lastAsked.localeCompare(a.lastAsked));
}

export async function resolveGap(id: string): Promise<boolean> {
  const g = await state.get<Gap>("gap", id);
  if (!g) return false;
  await state.put("gap", id, { ...g, resolved: true });
  return true;
}

// ---------- Per-user memory ----------

export interface Memory { id: string; fact: string; at: string }

export async function getMemories(userId: string): Promise<Memory[]> {
  return (await state.get<Memory[]>("memory", userId)) ?? [];
}

export async function remember(userId: string, fact: string): Promise<Memory> {
  const list = await getMemories(userId);
  const m = { id: `m${Date.now().toString(36)}`, fact: fact.trim().slice(0, 300), at: new Date().toISOString() };
  list.push(m);
  await state.put("memory", userId, list.slice(-30));
  return m;
}

export async function forget(userId: string, id: string): Promise<void> {
  await state.put("memory", userId, (await getMemories(userId)).filter((m) => m.id !== id));
}

// ---------- helpers ----------

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

