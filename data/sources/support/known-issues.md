---
title: Support Known Issues & Macros
owner: Support Team (Lead: Ben Torres)
updated: 2026-10-06
---

# Support Known Issues & Macros

## Known issues

### Android 15 dashboard crash
- Symptom: Pulse Android app crashes on dashboards with more than 12 tiles.
- Status: Fix in release 4.3 (Oct 27).
- Workaround: Use web app, or split dashboard into smaller ones.

### Incorrect invoice after INC-2291
- Symptom: Customer reports an invoice amount was wrong in September 2026 (EUR/GBP customers).
- Status: Resolved. Invoices were voided and reissued.
- Macro: Apologize, confirm the reissued invoice number, and apply a one-month 10% credit (Support leads can apply this in the Billing Admin tool).

### Events delayed in eu-central
- Symptom: Events show up 10-20 minutes late for eu-central workspaces during peak hours.
- Status: Investigating (Data Infra, JIRA DI-4410).
- Response: Data is not lost; it will appear once ingestion catches up.

## Escalation paths

- Billing issues: #team-payments, or escalate in the Support Desk to tier "Billing L2".
- Suspected security issue reported by customer: page Security on-call immediately.
- Enterprise customers with SLA impact: notify their Customer Success Manager within 1 hour.

## Response time targets

- Enterprise: first response within 1 hour (24/7 for SEV-1).
- Growth: first response within 8 business hours.
- Free: community forum only.
