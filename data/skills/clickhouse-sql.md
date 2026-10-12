# ClickHouse SQL practices

- Fully qualify tables: `pulse.events`, `pulse.workspaces`, `pulse.invoices`, `pulse.support_tickets`.
- `pulse.events` is large (tens of millions of rows). It is sorted by `(event_name, toDate(event_time), workspace_id, event_time)` and partitioned by month, so filtering on `event_name` and `event_time` is very cheap. A full scan without these filters reads every row and needs user approval.
- Time bucketing: `toDate(event_time)`, `toStartOfWeek(event_time, 1)` (Monday weeks), `toStartOfMonth(event_time)`, `toStartOfHour(event_time)`.
- Distinct counts: `uniqExact(x)` is exact; `uniq(x)` is a fast approximation that's fine for trends.
- Conditional aggregates: `countIf(cond)`, `sumIf(x, cond)`, `avgIf(x, cond)`, `uniqExactIf(x, cond)`.
- Percentiles: `quantile(0.95)(duration_ms)`; several at once: `quantiles(0.5, 0.95, 0.99)(x)`.
- Ratios: `round(100 * countIf(cond) / count(), 2) AS pct`. Guard division by zero with `if(d = 0, NULL, n / d)`.
- Joins: put the smaller table on the right side: `FROM pulse.events AS e INNER JOIN pulse.workspaces AS w ON e.workspace_id = w.workspace_id`.
- The `events` table already carries `plan`, `region` and `country` (ISO codes), so many questions need no join.
- Dates are UTC. Today is the last day of data; the dataset covers 2026-04-01 to 2026-10-11, and the last day may be partial.
- For quick exploration of huge scans you can use `LIMIT` on aggregated results. Never `SELECT *` without `LIMIT`.
- Don't add `FORMAT`; the system returns JSON.
- Name output columns clearly (`day`, `crash_rate_pct`, `revenue_usd`); they become chart labels.
