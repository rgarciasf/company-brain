// Create least-privilege ClickHouse users for agent SQL (database-level enforcement of personas):
//   brain_reader     SELECT on pulse.* and brain.traces/spans/feedback
//   brain_hr_reader  the same plus hr.*  (used only for the HR persona)
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
if (wroteEnv) console.log("   passwords saved to .env (add CLICKHOUSE_READER_PASSWORD and CLICKHOUSE_HR_READER_PASSWORD to Vercel too)");
ch.stopServer();
process.exit(0);
