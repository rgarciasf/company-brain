// Sync the knowledge base into HydraDB (for KNOWLEDGE_BACKEND=hydradb).
// Creates the database with its metadata schema if needed, upserts every chunk (repo sources and
// uploads) as a HydraDB source, waits until they're searchable and runs a test query.
// Run: npm run hydra:sync      (safe to re-run: ingestion is an upsert keyed by stable ids)
try {
  process.loadEnvFile();
} catch {}

const hydra = await import("../src/hydra.ts");
const kb = await import("../src/kb.ts");
const state = await import("../src/state.ts");

if (!hydra.hydraConfigured()) {
  console.error("Set HYDRA_DB_API_KEY in .env first.");
  process.exit(1);
}

console.log(`Syncing knowledge to HydraDB (database "${hydra.HYDRA_DATABASE}", collection "${hydra.HYDRA_COLLECTION}")…`);
await state.initState(); // so uploaded sources (stored in ClickHouse) are included
const loaded = await kb.reload();
const chunks = kb.allChunks();
console.log(`   ${loaded.docs} documents → ${chunks.length} chunks`);

await hydra.ensureDatabase();
const ids = await hydra.ingestChunks(chunks);
const { ready, failed } = await hydra.waitIndexed(ids);
console.log(`   ${ready}/${ids.length} chunks searchable${failed ? `, ${failed} failed` : ""}`);

process.env.KNOWLEDGE_BACKEND = "hydradb";
const probe = await kb.search("meal per diem for international travel", kb.getPersona("engineer"), { limit: 3 });
console.log(`   test query via ${probe.backend}${probe.fallback ? ` (fallback: ${probe.fallback})` : ""}:`);
for (const h of probe.hits) console.log(`     [${h.chunk.id}] ${h.chunk.title} › ${h.chunk.heading} (${h.score.toFixed(3)})`);
if (probe.graph.length) console.log(`   graph context: ${probe.graph.slice(0, 3).join(" | ")}`);
process.exit(failed ? 1 : 0);
