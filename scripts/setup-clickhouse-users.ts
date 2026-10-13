// Create least-privilege ClickHouse users for agent SQL (database-level enforcement of personas):
//   brain_reader     SELECT on pulse.* and brain.traces/spans/feedback
//   brain_hr_reader  the same plus hr.*  (used only for the HR persona)
// Both get a server-side settings profile (read-only, hard caps the client can't raise) and an
// hourly quota, so limits hold even if a reader password leaks.
// Passwords are generated once and stored in .env (copy them to Vercel for production).
// Run: npm run db:users        (idempotent; re-running re-applies grants and keeps passwords)
import { randomBytes } from "node:crypto";
import fs from "node:fs";

try {
  process.loadEnvFile();
} catch {}

const ch = await import("../src/clickhouse.ts");
if (!(await ch.ensureServer())) {
  console.error("ClickHouse is not reachable.");
  process.exit(1);
}

// Meets ClickHouse Cloud's password policy (length, upper, lower, digit, special character).
const strong = () => `Br${randomBytes(18).toString("base64url")}9!`;

const users = [
  { name: "brain_reader", env: "CLICKHOUSE_READER_PASSWORD", grants: ["pulse.*", "brain.traces", "brain.spans", "brain.feedback"] },
  { name: "brain_hr_reader", env: "CLICKHOUSE_HR_READER_PASSWORD", grants: ["pulse.*", "hr.*", "brain.traces", "brain.spans", "brain.feedback"] },
];

await ch.exec("CREATE DATABASE IF NOT EXISTS hr");
await ch.exec("CREATE DATABASE IF NOT EXISTS brain");
let wroteEnv = false;
for (const u of users) {
  let password = process.env[u.env];
  if (!password) {
    password = strong();
    fs.appendFileSync(".env", `${wroteEnv ? "" : "\n# Least-privilege ClickHouse users for agent SQL (npm run db:users)\n"}${u.env}=${password}\n`);
    wroteEnv = true;
  }
  const quoted = password.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  await ch.exec(`CREATE USER IF NOT EXISTS ${u.name} IDENTIFIED WITH sha256_password BY '${quoted}'`);
  await ch.exec(`ALTER USER ${u.name} IDENTIFIED WITH sha256_password BY '${quoted}'`);
  await ch.exec(`REVOKE ALL ON *.* FROM ${u.name}`);
  for (const g of u.grants) await ch.exec(`GRANT SELECT ON ${g} TO ${u.name}`);
  // Verify: can read what it should, and cannot read what it shouldn't.
  const creds = { user: u.name, password };
  const can = await ch.query("SELECT count() AS n FROM pulse.workspaces", { creds }).then(() => true, () => false);
  const hr = await ch.query("SELECT 1 FROM hr.employees LIMIT 1", { creds }).then(() => "yes", (e) => (String(e.message).includes("UNKNOWN_TABLE") || String(e.message).includes("doesn't exist") ? "no table yet" : "no"));
  const state = await ch.query("SELECT count() FROM brain.state", { creds }).then(() => "yes", () => "no");
  console.log(`   ✓ ${u.name.padEnd(16)} pulse: ${can ? "yes" : "NO"} · hr: ${hr} · brain.state: ${state}`);
}
// Server-side guardrails. readonly=2 lets the app tune settings per query, but only within these
// MAX constraints; readonly itself can't be lowered. Values sit above what the app requests.
const readers = users.map((u) => u.name).join(", ");
await ch.exec(`CREATE SETTINGS PROFILE OR REPLACE brain_agent_profile SETTINGS
  readonly = 2,
  max_execution_time = 30 MAX 60,
  max_result_rows = 10000 MAX 100000,
  max_rows_to_read = 500000000 MAX 500000000,
  max_bytes_to_read = 20000000000 MAX 20000000000,
  max_memory_usage = 4000000000 MAX 4000000000
  TO ${readers}`);
await ch.exec(`CREATE QUOTA OR REPLACE brain_agent_quota
  FOR INTERVAL 1 hour MAX queries = 3000, read_rows = 20000000000, execution_time = 3600
  TO ${readers}`);
for (const u of users) {
  const password = process.env[u.env] ?? fs.readFileSync(".env", "utf8").match(new RegExp(`^${u.env}=(.*)$`, "m"))?.[1];
  if (!password) continue;
  const creds = { user: u.name, password };
  const raised = await ch.query("SELECT 1", { creds, timeoutSec: 3600 }).then(() => "NOT enforced", () => "enforced");
  const writes = await ch.exec("CREATE TABLE brain.__probe (x UInt8) ENGINE = Memory", {}, undefined, {}, creds).then(() => "ALLOWED", () => "blocked");
  console.log(`   ✓ ${u.name.padEnd(16)} profile caps: ${raised} · writes: ${writes}`);
}

if (wroteEnv) console.log("   passwords saved to .env (add CLICKHOUSE_READER_PASSWORD and CLICKHOUSE_HR_READER_PASSWORD to Vercel too)");
ch.stopServer();
process.exit(0);
