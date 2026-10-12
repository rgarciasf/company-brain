// Creates and fills the `pulse` analytics database in ClickHouse with deterministic synthetic data
// that matches the fictional Acme story in data/sources (incidents, releases, policies).
// Run: npm run db:seed            (EVENTS=100000000 npm run db:seed for a bigger dataset)
try {
  process.loadEnvFile();
} catch {}

const ch = await import("../src/clickhouse.ts");

export async function seed(log = console.log, events = Number(process.env.EVENTS ?? 40_000_000)) {
  const DB = ch.ANALYTICS_DB;
  const run = async (label: string, sql: string) => {
    const t = Date.now();
    await ch.exec(sql, { max_execution_time: 600, max_partitions_per_insert_block: 1000 });
    log(`   ✓ ${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  };

  await run("database", `CREATE DATABASE IF NOT EXISTS ${DB}`);
  for (const t of ["events", "workspaces", "invoices", "support_tickets"]) await ch.exec(`DROP TABLE IF EXISTS ${DB}.${t} SYNC`);

  // ---------------- workspaces ----------------
  await run(
    "workspaces table",
    `CREATE TABLE ${DB}.workspaces (
      workspace_id UInt32 COMMENT 'Primary key. Joins to events/invoices/support_tickets.workspace_id',
      name String COMMENT 'Customer company name',
      plan LowCardinality(String) COMMENT 'Current plan: Free, Growth or Enterprise',
      region LowCardinality(String) COMMENT 'Data residency region: us-east or eu-central',
      country String COMMENT 'Billing country as entered in the CRM (free text, legacy rows are not normalised)',
      industry LowCardinality(String),
      created_at Date COMMENT 'Workspace creation date',
      mrr_usd Decimal(12, 2) COMMENT 'Current monthly recurring revenue in USD (0 for Free)',
      csm LowCardinality(String) COMMENT 'Customer Success Manager (Enterprise only, empty otherwise)',
      churned_at Nullable(Date) COMMENT 'Date the workspace cancelled; NULL if still active'
    ) ENGINE = MergeTree ORDER BY workspace_id
    COMMENT 'One row per customer workspace (CRM + billing snapshot as of 2026-10-11)'`,
  );
  await run(
    "workspaces data (6,000)",
    `INSERT INTO ${DB}.workspaces
    WITH
      number + 1 AS w,
      cityHash64(w, 'h') AS h,
      multiIf(w <= 480, 'Enterprise', w <= 2400, 'Growth', 'Free') AS plan_,
      arrayElement(['US','US','US','US','US','GB','DE','FR','NL','ES','PT','CA','BR','IN','AU','JP','SE'], 1 + cityHash64(w, 'country') % 17) AS cc,
      toDate('2021-01-01') + toIntervalDay(cityHash64(w, 'created') % 1900) AS created
    SELECT
      w,
      concat(arrayElement(['Bright','Nord','Kestrel','Lumio','Fern','Atlas','Cobalt','Juniper','Vela','Orchid','Quarry','Tidal','Summit','Ember','Harbor','Pioneer'], 1 + h % 16),
             ' ', arrayElement(['Labs','Health','Games','Retail','Analytics','Systems','Bank','Media','Learning','Logistics'], 1 + intDiv(h, 16) % 10),
             ' ', toString(w)),
      plan_,
      if(cc IN ('GB','DE','FR','NL','ES','PT','SE') AND cityHash64(w, 'reg') % 10 < 7, 'eu-central', 'us-east'),
      if(cc = 'US' AND created < '2023-01-01', arrayElement(['USA','United States','us','US'], 1 + cityHash64(w, 'messy') % 4), cc),
      arrayElement(['SaaS','E-commerce','Fintech','Healthcare','Gaming','Media','Education','Marketplace'], 1 + intDiv(h, 7) % 8),
      created,
      multiIf(plan_ = 'Enterprise', 2000 + (h % 8100), plan_ = 'Growth', if(h % 3 = 0, 479, 399) + if(h % 5 = 0, (h % 40) * 12, 0), 0),
      if(plan_ = 'Enterprise', arrayElement(['Ava Brooks','Diego Santos','Mei Chen','Liam O''Neil'], 1 + h % 4), ''),
      if(cityHash64(w, 'churn') % 100 < if(plan_ = 'Enterprise', 3, 9), toDate('2026-04-01') + toIntervalDay(cityHash64(w, 'cd') % 190), NULL)
    FROM numbers(6000)`,
  );

  // ---------------- events ----------------
  await run(
    "events table",
    `CREATE TABLE ${DB}.events (
      event_time DateTime CODEC(DoubleDelta, ZSTD(1)) COMMENT 'When the event happened (UTC)',
      workspace_id UInt32,
      user_id UInt64 CODEC(T64, ZSTD(1)) COMMENT 'End user inside the customer workspace',
      session_id UInt64 CODEC(T64, ZSTD(1)),
      event_name LowCardinality(String) COMMENT 'Product event, e.g. page_view, dashboard_view, query_run, reports_v1_view, app_crash',
      platform LowCardinality(String) COMMENT 'web, ios or android',
      os_version LowCardinality(String) COMMENT 'Mobile OS version, e.g. Android 15 / iOS 18 (empty for web)',
      app_version LowCardinality(String) COMMENT 'Mobile app release, e.g. 4.1, 4.2 (empty for web)',
      country LowCardinality(String) COMMENT 'ISO country code of the workspace',
      region LowCardinality(String) COMMENT 'Data residency region: us-east or eu-central',
      plan LowCardinality(String) COMMENT 'Workspace plan at event time',
      duration_ms UInt32 CODEC(T64, ZSTD(1)) COMMENT 'Query run time / dashboard load time in ms (0 for other events)',
      is_error UInt8 COMMENT '1 if the action failed',
      ingest_delay_ms UInt32 CODEC(T64, ZSTD(1)) COMMENT 'Delay between event_time and when the event became queryable'
    ) ENGINE = MergeTree
    PARTITION BY toYYYYMM(event_time)
    ORDER BY (event_name, toDate(event_time), workspace_id, event_time)
    COMMENT 'Product usage events from customer SDKs, 2026-04-01 to 2026-10-11'`,
  );
  await run(
    `events data (${(events / 1e6).toFixed(0)}M rows)`,
    `INSERT INTO ${DB}.events
    SELECT
      g.event_time, g.workspace_id, g.user_id,
      g.user_id * 10000 + toDayOfYear(g.event_time) * 24 + toHour(g.event_time) AS session_id,
      g.event_name, g.platform, g.os_version, g.app_version,
      multiIf(w.country IN ('USA','United States','us'), 'US', w.country) AS country,
      w.region, w.plan,
      toUInt32(multiIf(g.event_name = 'query_run', 40 + (g.h % 140) * 10 + if(g.h % 20 = 0, 1500 + (g.h % 400) * 10, 0),
              g.event_name IN ('dashboard_view','Dashboard Viewed'), 250 + (g.h % 180) * 10, 0)),
      if(g.event_name = 'query_run' AND g.h % 1000 < 12, 1, 0),
      if(w.region = 'eu-central' AND g.event_time >= '2026-10-01' AND toHour(g.event_time) BETWEEN 13 AND 17,
         600000 + (g.h % 600) * 1000, 80 + (g.h % 150) * 10)
    FROM
    (
      WITH
        toDateTime('2026-04-01 00:00:00') AS t0,
        toUInt32(dateDiff('second', t0, toDateTime('2026-10-12 00:00:00'))) AS span,
        cityHash64(number, 'h') AS h,
        (cityHash64(number, 't') % 1000000) / 1000000.0 AS ut,
        t0 + toIntervalSecond(toUInt32(span * pow(ut, 0.85))) AS ts,
        least(6000, 1 + toUInt32(6000 * pow((cityHash64(number, 'w') % 1000000) / 1000000.0, 1.7))) AS wid,
        cityHash64(number, 'p') % 100 AS p,
        multiIf(p < 70, 'web', p < 85, 'ios', 'android') AS plat,
        multiIf(plat = 'android', arrayElement(['Android 13','Android 14','Android 15','Android 15'], 1 + h % 4),
                plat = 'ios', arrayElement(['iOS 17','iOS 18','iOS 18'], 1 + h % 3), '') AS os,
        if(plat = 'web', '', multiIf(ts < '2026-08-15 00:00:00', '4.0', ts < '2026-09-29 00:00:00', '4.1', '4.2')) AS ver,
        cityHash64(number, 'e') % 10000 AS r,
        cityHash64(number, 'e2') % 1000 AS r2,
        toUInt32(110 * greatest(0.15, 1 - ut * 0.95)) AS reports_share
      SELECT
        ts AS event_time,
        wid AS workspace_id,
        toUInt64(wid) * 1000 + (h % multiIf(wid <= 480, 800, wid <= 2400, 120, 15)) AS user_id,
        plat AS platform, os AS os_version, ver AS app_version, h,
        multiIf(
          plat = 'android' AND os = 'Android 15' AND ver = '4.2' AND r < 180, 'app_crash',
          plat != 'web' AND r < 40, 'app_crash',
          r2 < 300, 'page_view',
          r2 < 500, if(wid % 13 = 0, 'Dashboard Viewed', 'dashboard_view'),
          r2 < 640, 'query_run',
          r2 < 640 + reports_share AND wid % 17 = 0, 'reports_v1_view',
          r2 < 830, 'funnel_viewed',
          r2 < 880, 'export_started',
          r2 < 930, 'alert_triggered',
          r2 < 965, 'experiment_viewed',
          r2 < 985, 'login',
          r2 < 990, 'signup',
          wid <= 25 AND ts >= '2026-10-01 00:00:00', 'ai_insights_query',
          'login') AS event_name
      FROM numbers(${Math.round(events)})
    ) AS g
    INNER JOIN ${DB}.workspaces AS w ON g.workspace_id = w.workspace_id
    WHERE w.churned_at IS NULL OR toDate(g.event_time) < w.churned_at`,
  );

  // ---------------- invoices ----------------
  await run(
    "invoices table",
    `CREATE TABLE ${DB}.invoices (
      invoice_id String,
      workspace_id UInt32,
      invoice_month Date COMMENT 'First day of the billed month',
      issued_at DateTime,
      currency LowCardinality(String) COMMENT 'USD, EUR or GBP',
      amount Decimal(12, 2) COMMENT 'Invoice total in invoice currency',
      amount_usd Decimal(12, 2) COMMENT 'Invoice total converted to USD',
      status LowCardinality(String) COMMENT 'paid, open, void (cancelled, not owed) or reissued (replacement for a voided invoice)',
      plan LowCardinality(String)
    ) ENGINE = MergeTree ORDER BY (invoice_month, workspace_id)
    COMMENT 'Monthly invoices for paying workspaces. Revenue = sum(amount_usd) excluding status = void'`,
  );
  await run(
    "invoices data",
    `INSERT INTO ${DB}.invoices
    WITH
      multiIf(w.country IN ('DE','FR','NL','ES','PT'), 'EUR', w.country = 'GB', 'GBP', 'USD') AS cur,
      multiIf(cur = 'EUR', 0.92, cur = 'GBP', 0.79, 1.0) AS fx,
      cityHash64(w.workspace_id, m) AS h,
      toDecimal64(w.mrr_usd + if(w.plan = 'Growth' AND h % 10 < 3, (h % 20) * 12, 0), 2) AS usd,
      toDecimal64(round(usd * fx, 2), 2) AS amt,
      m = toDate('2026-09-01') AND cur IN ('EUR','GBP') AS hit_by_incident,
      arrayJoin(if(hit_by_incident, ['void','reissued'], [if(m = toDate('2026-10-01'), 'open', 'paid')])) AS st
    SELECT
      concat('INV-', toString(70000 + rowNumberInAllBlocks())),
      w.workspace_id, m,
      toDateTime(m) + toIntervalHour(2) + if(st = 'reissued', toIntervalDay(19), toIntervalDay(0)),
      cur,
      if(st = 'void', amt + toDecimal64((h % 420 + 1) / 100.0, 2), amt),
      if(st = 'void', usd + toDecimal64((h % 420 + 1) / 100.0 / fx, 2), usd),
      st, w.plan
    FROM ${DB}.workspaces AS w
    ARRAY JOIN [toDate('2026-04-01'), toDate('2026-05-01'), toDate('2026-06-01'), toDate('2026-07-01'), toDate('2026-08-01'), toDate('2026-09-01'), toDate('2026-10-01')] AS m
    WHERE w.plan != 'Free' AND w.created_at <= m AND (w.churned_at IS NULL OR w.churned_at > m)`,
  );

  // ---------------- support tickets ----------------
  await run(
    "support_tickets table",
    `CREATE TABLE ${DB}.support_tickets (
      ticket_id String,
      created_at DateTime,
      workspace_id UInt32,
      category LowCardinality(String) COMMENT 'billing, login_sso, data_delay, mobile_crash, export, how_to, bug',
      priority LowCardinality(String) COMMENT 'low, normal, high, urgent',
      first_response_minutes UInt32,
      csat Nullable(UInt8) COMMENT 'Customer satisfaction 1-5, NULL if no survey response',
      status LowCardinality(String) COMMENT 'open or solved'
    ) ENGINE = MergeTree ORDER BY (created_at, workspace_id)
    COMMENT 'Customer support tickets from the Support Desk'`,
  );
  const tickets = (n: number, seedKey: string, from: string, days: number, category: string, wsFilter: string) => `
    INSERT INTO ${DB}.support_tickets
    WITH cityHash64(number, '${seedKey}') AS h,
      toDateTime('${from}') + toIntervalSecond(h % (${days} * 86400)) AS ts,
      ${category} AS cat
    SELECT concat('SUP-', toString(cityHash64(number, '${seedKey}', 'id') % 900000 + 100000)), ts, ws.workspace_id, cat,
      arrayElement(['low','normal','normal','normal','high','urgent'], 1 + h % 6),
      if(ws.plan = 'Enterprise', 5 + h % 55, 30 + h % 600),
      if(h % 3 = 0, NULL, toUInt8(if(cat IN ('billing','data_delay','mobile_crash'), 1 + h % 4, 2 + h % 4))),
      if(ts > '2026-10-08 00:00:00' AND h % 3 = 0, 'open', 'solved')
    FROM numbers(${n}) AS n
    INNER JOIN (SELECT workspace_id, plan, region, row_number() OVER (ORDER BY workspace_id) AS rn FROM ${DB}.workspaces WHERE ${wsFilter}) AS ws
      ON ws.rn = 1 + cityHash64(n.number, '${seedKey}', 'w') % (SELECT count() FROM ${DB}.workspaces WHERE ${wsFilter})`;
  await run("support tickets (baseline)", tickets(26000, "base", "2026-04-01 00:00:00", 194, "arrayElement(['how_to','how_to','how_to','bug','bug','export','login_sso','billing','data_delay','mobile_crash'], 1 + h % 10)", "plan != 'Free'"));
  await run("support tickets (INC-2291 billing spike)", tickets(950, "inc2291", "2026-09-19 03:00:00", 5, "'billing'", "plan != 'Free' AND country IN ('GB','DE','FR','NL','ES','PT')"));
  await run("support tickets (DI-4410 EU delays)", tickets(700, "di4410", "2026-10-01 00:00:00", 11, "'data_delay'", "region = 'eu-central'"));
  await run("support tickets (Android 15 crashes)", tickets(800, "android", "2026-09-29 00:00:00", 13, "'mobile_crash'", "plan != 'Free'"));

  const stats = await ch.storageStats();
  for (const s of stats) log(`   ${s.table.padEnd(16)} ${s.rows.toLocaleString().padStart(12)} rows  ${(s.uncompressed / 1e6).toFixed(0)} MB → ${(s.compressed / 1e6).toFixed(0)} MB on disk (${(s.uncompressed / Math.max(1, s.compressed)).toFixed(1)}x)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!(await ch.ensureServer())) {
    console.error("ClickHouse is not reachable and no local binary found. Run `npm run db:install` first.");
    process.exit(1);
  }
  console.log("Seeding ClickHouse…");
  await seed();
  ch.stopServer();
  process.exit(0);
}
