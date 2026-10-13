# Acme metric definitions (semantic layer)

Use these definitions unless the question asks for something else, and state which one you used.

- **Active workspace**: a workspace with at least one event in the period. Exclude churned workspaces (`workspaces.churned_at IS NOT NULL` and `churned_at <= period end`) when counting the current customer base.
- **DAU / WAU / MAU**: distinct `user_id` with any event per day / Monday-week / month.
- **Revenue** for a month: `sum(amount_usd)` from `pulse.invoices` for that `invoice_month`, **excluding `status = 'void'`** (voided invoices were cancelled and replaced; `reissued` rows are the valid replacements). October 2026 invoices are `open` (not yet paid).
- **MRR**: `sum(mrr_usd)` from `pulse.workspaces` where `churned_at IS NULL` (current snapshot). For trends, use monthly revenue from invoices.
- **Paying customer**: plan `Growth` or `Enterprise`.
- **Mobile crash rate**: `countIf(event_name = 'app_crash')` divided by the count of all mobile events (`platform IN ('ios','android')`) in the same slice, as a percentage. Product target: below 1%.
- **Query latency**: `duration_ms` on `event_name = 'query_run'`; the product promise is p95 under 2,000 ms.
- **Dashboard load time**: `duration_ms` on dashboard view events.
- **Ingestion delay**: `ingest_delay_ms`; normal is under 2 seconds. Anything over 5 minutes is considered delayed.
- **Reports v1 adoption**: workspaces with at least one `reports_v1_view` event in the period (feature is being deprecated and replaced by Dashboards v2).
- **Support load**: tickets per day from `pulse.support_tickets`; **first response SLA**: Enterprise within 60 minutes.
- **CSAT**: average of non-NULL `csat` (1-5).

Agent self-observability: the `brain` database has `brain.traces` (one row per question: latency_ms, cost_usd, tokens, persona) and `brain.spans` (model calls and tool calls) and `brain.feedback` (score 1 / -1), if the user asks how Ingestion itself is being used.

Meeting follow-ups: `brain.meeting_items` holds action items, commitments and decisions extracted from meeting notes and transcripts (kind, text, owner, counterparty = customer a commitment was made to, due_date, status open/done, meeting_title, meeting_date). It is a ReplacingMergeTree: always query `FROM brain.meeting_items FINAL WHERE deleted = 0`. Overdue = `status = 'open' AND due_date < today()`. Use it for counts and trends (overdue items by owner, commitments per customer); for listing specific items the main agent has a dedicated tool.
