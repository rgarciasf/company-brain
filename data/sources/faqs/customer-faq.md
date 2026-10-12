---
title: Customer FAQ (Public)
owner: Customer Success
updated: 2026-09-15
---

# Pulse Customer FAQ

## Can I export my data?

Yes. Any admin can export raw events as CSV or Parquet from **Settings > Data > Export**. Exports over 10 GB are delivered to an S3 bucket you configure. Enterprise customers can also use the nightly warehouse sync to Snowflake or BigQuery.

## Do you support SSO?

SAML and OIDC SSO are available on Growth and Enterprise. SCIM user provisioning is Enterprise-only.

## Where is my data stored?

In the `us-east` region by default. Customers can choose `eu-central` at workspace creation for EU data residency. Region cannot be changed after creation without a migration request to Support.

## What happens if I exceed my event quota?

We never drop your data. Overage is billed at the plan's per-million-event rate. You get an email alert at 80% and 100% of quota.

## How do I cancel?

Admins can cancel from **Settings > Billing**. Annual contracts cancel at the end of the term. Monthly plans cancel at the end of the current billing period; no partial refunds.

## Is there an uptime SLA?

Enterprise plans include a 99.9% monthly uptime SLA with service credits. Growth and Free plans have no contractual SLA.
