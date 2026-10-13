// Local server: starts (or connects to) ClickHouse, seeds it on first run, runs the in-process
// scheduler and serves the app. On Vercel, api/index.ts serves the same handler instead.
import http from "node:http";

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on the environment
}

const { handle, init } = await import("./app.ts");
const kb = await import("./kb.ts");
const ch = await import("./clickhouse.ts");
const traces = await import("./trace.ts");
const state = await import("./state.ts");
const reports = await import("./reports.ts");
const { aiEnabled, MODEL } = await import("./brain.ts");
const { ANALYST_MODEL } = await import("./analyst.ts");
const { authEnabled } = await import("./auth.ts");

const PORT = Number(process.env.PORT ?? 3000);

console.log(`\nIngestion`);
const clickhouseUp = await ch.ensureServer((m) => console.log(m));
if (clickhouseUp && !(await ch.databaseExists())) {
  console.log("   Seeding analytics database (first run)…");
  const { seed } = await import("../scripts/seed.ts");
  await seed((m) => console.log(m));
}
await init();
const s = await kb.stats();
console.log(`   ${s.docs} documents, ${s.chunks} chunks indexed`);
console.log(clickhouseUp ? `   ClickHouse: ${new URL(ch.CH_URL).host} (database ${ch.ANALYTICS_DB})` : "   ClickHouse: not available (data questions disabled). Run `npm run db:install`.");
console.log(`   State: ${state.stateBackend()} · traces: ${traces.traceBackend()}`);
console.log(aiEnabled() ? `   AI: ${MODEL} (+ ${ANALYST_MODEL} data analyst)` : "   AI answers: OFF (search-only). Set ANTHROPIC_API_KEY in .env to enable.");
if (authEnabled()) console.log("   Login: APP_PASSWORD required");
reports.startScheduler();
// Extract action items from new or changed meetings in the background.
const meetings = await import("./meetings.ts");
void meetings.syncAll({ log: (m) => console.log(`   ${m}`) }).catch((err) => console.warn(`[meetings] ${(err as Error).message}`));
http.createServer(handle).listen(PORT, () => console.log(`   Running at http://localhost:${PORT}\n`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    ch.stopServer();
    process.exit(0);
  });
}
