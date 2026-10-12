---
title: Pulse Architecture Overview
owner: Lena Okafor (Principal Engineer)
updated: 2026-07-30
---

# Pulse Architecture Overview

## High-level components

- **Web app**: Next.js frontend served from the edge.
- **API gateway**: Handles auth (SSO/OIDC), rate limiting (600 requests/minute per workspace by default), and routing.
- **Ingest service**: Receives events from customer SDKs, validates them, and writes to Kafka. Handles about 2.1 billion events per day.
- **Query engine**: Runs analytics queries over ClickHouse. Hot data (last 90 days) lives on SSD; older data is in object storage.
- **Billing service**: Computes usage from event counts, syncs invoices to Stripe nightly at 02:00 UTC.
- **Postgres**: Stores workspaces, users, dashboards, and permissions.

## Data retention

- Raw events: 13 months on Growth plan, 25 months on Enterprise.
- Aggregated metrics: retained indefinitely.
- Deleted workspaces are purged after 30 days.

## Regions

Pulse runs in two regions: `us-east` (default) and `eu-central`. EU customers can pin data residency to `eu-central`; data never leaves the region.

## Service ownership

| Service | Team | Slack |
|---|---|---|
| API gateway | Platform | #team-platform |
| Ingest | Data Infra | #team-data-infra |
| Query engine | Data Infra | #team-data-infra |
| Billing | Payments | #team-payments |
| Web app | Product Eng | #team-product-eng |
