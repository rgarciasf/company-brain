// HydraDB backend adapter tests with a fake client (no network): filters, id mapping back to local
// chunks, defence-in-depth access checks, graph context and fallback to local search.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as kb from "../src/kb.ts";
import * as hydra from "../src/hydra.ts";

const engineer = kb.getPersona("engineer");
const saved = { backend: process.env.KNOWLEDGE_BACKEND, key: process.env.HYDRA_DB_API_KEY };
let lastRequest: any = null;
let respond: () => any = () => ({ data: { chunks: [] } });

before(async () => {
  process.env.KNOWLEDGE_BACKEND = "hydradb";
  process.env.HYDRA_DB_API_KEY = "test-key";
  await kb.reload();
  hydra.setClientForTests({ query: async (req: any) => ((lastRequest = req), respond()) });
});
after(() => {
  process.env.KNOWLEDGE_BACKEND = saved.backend ?? "";
  process.env.HYDRA_DB_API_KEY = saved.key ?? "";
  if (!saved.key) delete process.env.HYDRA_DB_API_KEY;
  if (!saved.backend) delete process.env.KNOWLEDGE_BACKEND;
});

const chunkOf = (docId: string) => kb.chunksOf(docId)[0];

test("backend switch is active", () => {
  assert.equal(kb.knowledgeBackend(), "hydradb");
});

test("sends persona access groups and source types as metadata filters", async () => {
  respond = () => ({ data: { chunks: [] } });
  await kb.search("per diem", engineer, { sourceTypes: ["policies"], limit: 3 });
  assert.equal(lastRequest.queryBy, "hybrid");
  assert.deepEqual(lastRequest.metadataFilters.access, { contains_any: ["all", "engineering"] });
  assert.deepEqual(lastRequest.metadataFilters.source_type, { contains_any: ["policies"] });
});

test("maps HydraDB hits back to local chunks and drops chunks the persona can't access", async () => {
  const pub = chunkOf("policies/travel-expense-policy-2026");
  const restricted = chunkOf("policies/compensation-bands");
  respond = () => ({
    data: {
      chunks: [
        { id: hydra.sourceId(restricted), relevancyScore: 0.99 },
        { id: hydra.sourceId(pub), relevancyScore: 0.9 },
        { id: "unknown-source", relevancyScore: 0.8 },
      ],
      graphContext: { queryPaths: [{ triplets: [{ source: { name: "Finance Team" }, relation: { canonical_predicate: "OWNS" }, target: { name: "Travel Policy" } }] }] },
    },
  });
  const r = await kb.search("anything", engineer, { limit: 5 });
  assert.equal(r.backend, "hydradb");
  assert.deepEqual(r.hits.map((h) => h.chunk.id), [pub.id]);
  assert.deepEqual(r.graph, ["Finance Team --OWNS--> Travel Policy"]);
});

test("falls back to local search when HydraDB errors", async () => {
  respond = () => {
    throw new Error("network down");
  };
  const r = await kb.search("meal per diem", engineer, { limit: 2 });
  assert.equal(r.backend, "local");
  assert.match(r.fallback ?? "", /network down/);
  assert.equal(r.hits[0].chunk.docId, "policies/travel-expense-policy-2026");
});

test("source ids are stable and safe", () => {
  assert.equal(hydra.sourceId({ docId: "support/tickets#1", ord: 0 }), "support_tickets_1--0");
});
