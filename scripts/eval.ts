// End-to-end answer eval against Claude. Requires ANTHROPIC_API_KEY (costs a few cents per run).
// Each case lists facts that must appear in the answer, and optionally a source that must be cited.
// Run: npm run eval
try {
  process.loadEnvFile();
} catch {}

const { ask, aiEnabled } = await import("../src/brain.ts");
const kb = await import("../src/kb.ts");
const ch = await import("../src/clickhouse.ts");
const { initTraceStore } = await import("../src/trace.ts");
const { initState } = await import("../src/state.ts");

interface Case { q: string; persona: string; mustInclude: (string | RegExp)[]; mustCite?: string; mustCiteData?: boolean }

const CASES: Case[] = [
  { q: "What's the meal per diem for international travel?", persona: "engineer", mustInclude: ["$120", /2024|outdated|supersed/i], mustCite: "policies/travel-expense-policy-2026" },
  { q: "Can I deploy on a Friday?", persona: "engineer", mustInclude: [/no|not allowed/i, /hotfix/i], mustCite: "docs/deploy-runbook" },
  { q: "What breaks if the Query Engine goes down, and which team owns it?", persona: "engineer", mustInclude: ["Data Infra", /dashboard/i, /AI Insights/i] },
  { q: "A EUR customer says they were charged twice in September. What should I tell them?", persona: "support", mustInclude: [/reissu/i, "10%"] },
  { q: "When does AI Insights launch and what does it cost on Growth?", persona: "sales", mustInclude: [/November 12|Nov 12/i, "$49"] },
  { q: "What is the salary band for a Staff Engineer?", persona: "engineer", mustInclude: [/access|restricted|can't|cannot|not able/i] },
  { q: "What is the salary band for a Staff Engineer?", persona: "manager", mustInclude: ["$215,000"] },
  // Data questions (answered by the ClickHouse analyst sub-agent)
  { q: "What's the crash rate for Android 15 users on app 4.2 since Sep 29, versus other mobile users?", persona: "engineer", mustInclude: [/1\.[6-9]\d?\s?%/], mustCiteData: true },
  { q: "How many September 2026 invoices were voided, and why?", persona: "support", mustInclude: ["791", /INC-2291|rounding/i], mustCiteData: true },
  { q: "What is our current ARR from active workspaces, and how does it compare to the Q4 goal?", persona: "manager", mustInclude: [/43\.[5-9]|43\.9/, "48"], mustCiteData: true },
];

if (!aiEnabled()) {
  console.error("Set ANTHROPIC_API_KEY to run the answer eval (npm test runs the offline suite).");
  process.exit(1);
}

await ch.ensureServer();
await initState();
await initTraceStore();
await kb.reload();
let passed = 0;
for (const c of CASES) {
  let answer = "";
  const cited = new Set<string>();
  await ask({ question: c.q, history: [], persona: kb.getPersona(c.persona), userId: "eval", source: "eval" }, (event, data: any) => {
    if (event === "delta") answer += data.text;
    if (event === "error") answer += `\n[error] ${data.message}`;
  });
  for (const id of answer.match(/c\d+/g) ?? []) {
    const chunk = kb.getChunk(id);
    if (chunk) cited.add(chunk.docId);
  }
  const missing = c.mustInclude.filter((m) => (typeof m === "string" ? !answer.includes(m) : !m.test(answer)));
  const citeOk = (!c.mustCite || cited.has(c.mustCite)) && (!c.mustCiteData || /\[q\d+\]/.test(answer));
  const ok = !missing.length && citeOk;
  if (ok) passed++;
  console.log(`${ok ? "PASS" : "FAIL"} [${c.persona}] ${c.q}`);
  if (!ok) {
    if (missing.length) console.log(`   missing: ${missing.map(String).join(", ")}`);
    if (!citeOk) console.log(`   expected citation of ${c.mustCite ?? "a data query [qN]"}; cited ${[...cited].join(", ") || "no documents"}`);
    console.log(`   answer: ${answer.slice(0, 400).replace(/\n/g, " ")}`);
  }
}
console.log(`\n${passed}/${CASES.length} passed`);
ch.stopServer();
process.exit(passed === CASES.length ? 0 : 1);
