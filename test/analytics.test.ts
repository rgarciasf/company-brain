// Analytics layer tests: SQL guardrails always run; data checks run when ClickHouse is reachable.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as ch from "../src/clickhouse.ts";
import { computeNextRun } from "../src/reports.ts";

test("SQL guard allows read-only queries", () => {
  for (const sql of [
    "SELECT 1",
    "  with x AS (SELECT 1) SELECT * FROM x",
    "SELECT count() FROM pulse.events WHERE event_name = 'drop table' -- comment",
    "DESCRIBE TABLE pulse.events",
    "SELECT 1;",
  ]) assert.equal(ch.validateReadOnly(sql), null, sql);
});

test("SQL guard blocks writes, multi-statements, system tables and external table functions", () => {
  for (const sql of [
    "DROP TABLE pulse.events",
    "INSERT INTO pulse.events SELECT * FROM pulse.events",
    "SELECT 1; DROP TABLE pulse.events",
    "ALTER TABLE pulse.events DELETE WHERE 1",
    "SELECT * FROM system.users",
    "SELECT * FROM url('http://example.com/x.csv', CSV)",
    "SELECT * FROM s3('https://bucket/x')",
    "SELECT * FROM remote('other:9000', db.t)",
    "SELECT 1 FORMAT CSV",
    "",
  ]) assert.notEqual(ch.validateReadOnly(sql), null, sql);
});

test("schedules compute the next run in the future", () => {
  const from = new Date("2026-10-12T10:00:00");
  assert.equal(new Date(computeNextRun({ frequency: "daily", time: "09:00" }, from)).getDate(), 13);
  assert.equal(new Date(computeNextRun({ frequency: "daily", time: "11:30" }, from)).getHours(), 11);
  assert.equal(new Date(computeNextRun({ frequency: "weekly", time: "09:00", weekday: 1 }, from)).getDay(), 1);
  assert.ok(new Date(computeNextRun({ frequency: "minutes", minutes: 15 }, from)).getTime() - from.getTime() === 15 * 60_000);
});

const up = await ch.ping();

test("planted data signals are present", { skip: !up && "ClickHouse not running" }, async () => {
  const crash = await ch.query(
    `SELECT os_version, app_version, round(100 * countIf(event_name = 'app_crash') / count(), 2) AS pct
     FROM pulse.events WHERE platform = 'android' AND event_time >= '2026-09-29' GROUP BY 1, 2 ORDER BY pct DESC LIMIT 1`,
  );
  assert.equal(crash.rows[0].os_version, "Android 15");
  assert.ok(Number(crash.rows[0].pct) > 1.5);

  const names = await ch.query(`SELECT groupArray(DISTINCT event_name) AS n FROM pulse.events WHERE event_name IN ('dashboard_view', 'Dashboard Viewed')`);
  assert.equal((names.rows[0].n as string[]).length, 2, "legacy event name variant should exist");

  const voided = await ch.query(`SELECT countIf(status = 'void') AS v, countIf(status = 'reissued') AS r FROM pulse.invoices WHERE invoice_month = '2026-09-01'`);
  assert.ok(Number(voided.rows[0].v) > 500 && voided.rows[0].v === voided.rows[0].r);
});

test("estimates flag full scans but not narrow queries", { skip: !up && "ClickHouse not running" }, async () => {
  const full = await ch.estimateRows("SELECT uniq(user_id) FROM pulse.events");
  const narrow = await ch.estimateRows("SELECT count() FROM pulse.events WHERE event_name = 'app_crash' AND event_time >= '2026-10-01'");
  assert.ok(full! > 30_000_000);
  assert.ok(narrow! < 1_000_000);
});

test("readonly setting blocks writes even if the guard were bypassed", { skip: !up && "ClickHouse not running" }, async () => {
  await assert.rejects(ch.query("CREATE TABLE pulse.should_not_exist (x UInt8) ENGINE = Memory"));
});
