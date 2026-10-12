// HydraDB retrieval backend (KNOWLEDGE_BACKEND=hydradb).
// Each of our chunks is ingested as its own HydraDB source with a stable id and filterable metadata,
// so every HydraDB hit maps straight back to a local chunk: citations, read_document, permissions
// and conflict handling keep working unchanged. HydraDB adds hybrid (semantic + keyword) retrieval
// and graph context; the local index stays the source of truth for content.
import { HydraDBClient, HydraDB } from "@hydradb/sdk";
import type { Chunk } from "./ingest.ts";

export const HYDRA_DATABASE = process.env.HYDRA_DB_DATABASE ?? "company_brain";
export const HYDRA_COLLECTION = process.env.HYDRA_DB_COLLECTION ?? "knowledge";
const MODE = (process.env.HYDRA_DB_MODE ?? "fast") as HydraDB.SearchRecallMode;
const BATCH = 25;

/** Metadata fields declared on the HydraDB database (filterable). */
const SCHEMA: HydraDB.TenantsCustomPropertyDefinition[] = [
  { name: "source_type", dataType: "VARCHAR", maxLength: 64 },
  { name: "access", dataType: "VARCHAR", maxLength: 256 }, // comma-joined access groups
  { name: "doc_id", dataType: "VARCHAR", maxLength: 256 },
  { name: "doc_status", dataType: "VARCHAR", maxLength: 32 },
  { name: "updated_on", dataType: "VARCHAR", maxLength: 32 },
];

export function hydraConfigured(): boolean {
  return !!process.env.HYDRA_DB_API_KEY;
}

let client: HydraDBClient | null = null;
function getClient(): HydraDBClient {
  return (client ??= new HydraDBClient({ token: process.env.HYDRA_DB_API_KEY }));
}

/** Test hook: swap in a fake client. */
export function setClientForTests(c: unknown) {
  client = c as HydraDBClient;
}

/** Stable HydraDB source id for a chunk (doc id + position, sanitised). */
export function sourceId(c: Pick<Chunk, "docId" | "ord">): string {
  return `${c.docId}--${c.ord}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

function chunkMarkdown(c: Chunk): string {
  return `# ${c.title}\n${c.heading ? `## ${c.heading}\n` : ""}\n${c.text}\n`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Create the database (with metadata schema) if needed and wait until it accepts ingestion. */
export async function ensureDatabase(log = console.log): Promise<void> {
  const db = getClient().databases;
  try {
    await db.create({ database: HYDRA_DATABASE, databaseMetadataSchema: SCHEMA });
    log(`   created HydraDB database "${HYDRA_DATABASE}"`);
  } catch (err) {
    if (!(err instanceof HydraDB.ConflictError)) throw err;
  }
  for (let i = 0; i < 90; i++) {
    const s = await db.status({ database: HYDRA_DATABASE });
    if (s.data?.infra?.readyForIngestion) return;
    if (i === 0) log("   waiting for HydraDB database to be ready…");
    await sleep(2000);
  }
  throw new Error(`HydraDB database "${HYDRA_DATABASE}" did not become ready for ingestion`);
}

/** Upsert chunks as HydraDB sources. Returns the source ids submitted. */
export async function ingestChunks(chunks: Chunk[], log = console.log): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const res = await getClient().context.ingest({
      type: "knowledge",
      database: HYDRA_DATABASE,
      collection: HYDRA_COLLECTION,
      upsert: "true",
      documents: batch.map((c) => ({ data: Buffer.from(chunkMarkdown(c), "utf8"), filename: `${sourceId(c)}.md`, contentType: "text/markdown" })),
      documentMetadata: JSON.stringify(
        batch.map((c) => ({
          id: sourceId(c),
          metadata: { source_type: c.sourceType, access: c.access.join(","), doc_id: c.docId, doc_status: c.status ?? "", updated_on: c.updated ?? "" },
          additional_metadata: { title: c.title.slice(0, 200), heading: c.heading.slice(0, 200) },
        })),
      ),
    });
    const failed = res.data?.results?.filter((r) => r.error) ?? [];
    if (failed.length) log(`   ⚠ ${failed.length} chunk(s) rejected: ${failed[0].error}`);
    ids.push(...batch.map(sourceId));
    log(`   ingested ${Math.min(i + BATCH, chunks.length)}/${chunks.length} chunks`);
  }
  return ids;
}

/** Wait until sources are searchable (graph_creation or completed). */
export async function waitIndexed(ids: string[], log = console.log, timeoutMs = 10 * 60_000): Promise<{ ready: number; failed: number }> {
  const started = Date.now();
  let ready = 0;
  let failed = 0;
  while (Date.now() - started < timeoutMs) {
    ready = 0;
    failed = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const res = await getClient().context.status({ database: HYDRA_DATABASE, collection: HYDRA_COLLECTION, ids: ids.slice(i, i + 100) });
      for (const s of res.data?.statuses ?? []) {
        if (s.indexingStatus === "graph_creation" || s.indexingStatus === "completed") ready++;
        else if (s.indexingStatus === "errored" || s.indexingStatus === "failed") failed++;
      }
    }
    log(`   indexing: ${ready}/${ids.length} searchable${failed ? `, ${failed} failed` : ""}`);
    if (ready + failed >= ids.length) break;
    await sleep(5000);
  }
  return { ready, failed };
}

export interface HydraHit {
  sourceId: string;
  score: number;
}

/** Name of a graph entity / relation from HydraDB's loosely-typed triplet records. */
function label(v: Record<string, unknown> | undefined, ...keys: string[]): string {
  for (const k of keys) if (v && typeof v[k] === "string") return v[k] as string;
  return "";
}

/** Hybrid search, filtered to the persona's access groups (and optional source types). */
export async function search(query: string, opts: { groups: string[]; sourceTypes?: string[]; limit: number }): Promise<{ hits: HydraHit[]; graph: string[] }> {
  const metadataFilters: Record<string, unknown> = { access: { contains_any: opts.groups } };
  if (opts.sourceTypes?.length) metadataFilters.source_type = { contains_any: opts.sourceTypes };
  const res = await getClient().query({
    database: HYDRA_DATABASE,
    collection: HYDRA_COLLECTION,
    query,
    type: "knowledge",
    queryBy: "hybrid",
    mode: MODE,
    maxResults: Math.min(opts.limit * 2, 50),
    graphContext: true,
    metadataFilters,
  });
  const data = res.data;
  if (!data || typeof data === "string") throw new Error(`HydraDB returned no structured results${typeof data === "string" ? `: ${data.slice(0, 200)}` : ""}`);
  const hits = (data.chunks ?? []).filter((c) => c.id).map((c) => ({ sourceId: c.id!, score: c.relevancyScore ?? 0 }));
  const graph = (data.graphContext?.queryPaths ?? [])
    .flatMap((p) => p.triplets ?? [])
    .map((t) => {
      const s = label(t.source, "name", "entity", "alias");
      const r = label(t.relation, "canonical_predicate", "canonicalPredicate", "predicate", "name");
      const o = label(t.target, "name", "entity", "alias");
      return s && r && o ? `${s} --${r}--> ${o}` : "";
    })
    .filter(Boolean);
  return { hits, graph: [...new Set(graph)].slice(0, 12) };
}
