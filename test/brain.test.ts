// Offline regression suite: retrieval quality, permissions, graph and ingestion. No API key needed.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as kb from "../src/kb.ts";

const engineer = kb.getPersona("engineer");
const manager = kb.getPersona("manager");

before(() => {
  kb.reload();
});

// Cross-source questions -> the document that must appear in the top 3 results.
const RETRIEVAL_CASES: [string, string][] = [
  ["meal per diem international travel", "policies/travel-expense-policy-2026"],
  ["deploy on friday", "docs/deploy-runbook"],
  ["billing outage root cause rounding", "meetings/2026-09-22-incident-review"],
  ["AI Insights price growth plan", "product/pricing"],
  ["export stuck preparing", "support/tickets#1"],
  ["how many days in office hub employees", "policies/remote-work-policy"],
  ["who is on call week of 2026-10-19", "tools/oncall"],
  ["request access production deploy", "tools/internal-tools#1"],
  ["android 15 crash workaround", "support/known-issues"],
  ["referral bonus engineering", "faqs/employee-faq"],
];

for (const [query, docId] of RETRIEVAL_CASES) {
  test(`retrieval: "${query}" finds ${docId}`, () => {
    const top = kb.search(query, engineer, { limit: 3 }).map((h) => h.chunk.docId);
    assert.ok(top.includes(docId), `top 3 were ${top.join(", ")}`);
  });
}

test("current policy outranks superseded policy", () => {
  const top = kb.search("meal per diem", engineer, { limit: 2 });
  assert.equal(top[0].chunk.docId, "policies/travel-expense-policy-2026");
});

test("permissions: restricted docs are filtered before retrieval", () => {
  const asEngineer = kb.search("staff engineer salary band", engineer, { limit: 10 }).map((h) => h.chunk.docId);
  const asManager = kb.search("staff engineer salary band", manager, { limit: 10 }).map((h) => h.chunk.docId);
  assert.ok(!asEngineer.includes("policies/compensation-bands"));
  assert.ok(asManager.includes("policies/compensation-bands"));
  assert.equal(kb.getDoc("policies/compensation-bands", engineer), undefined);
});

test("graph: impact of the query engine reaches dependent features and owner", () => {
  const g = kb.exploreGraph("query engine", 2);
  assert.ok(g);
  const names = g.nodes.map((n) => n.name);
  for (const n of ["Data Infra Team", "Dashboards v2", "AI Insights", "ClickHouse"]) assert.ok(names.includes(n), `missing ${n}`);
});

test("graph: aliases resolve", () => {
  assert.equal(kb.findEntity("billing")?.name, "Billing Service");
  assert.equal(kb.findEntity("ciso")?.name, "Hannah Cho");
});

test("chunks are heading-aware and bounded", () => {
  const chunks = kb.chunksOf("policies/travel-expense-policy-2026");
  assert.ok(chunks.some((c) => c.heading === "Meals"));
  for (const c of chunks) assert.ok(c.text.length <= 2000);
});
