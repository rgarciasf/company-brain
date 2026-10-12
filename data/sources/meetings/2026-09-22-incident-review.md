---
title: Incident Review - Billing Outage (INC-2291)
owner: Marcus Webb (Platform Team)
updated: 2026-09-22
---

# Incident Review: Billing Outage INC-2291

**Date of incident:** September 19, 2026 (a Friday)
**Duration:** 2 hours 14 minutes
**Severity:** SEV-1
**Incident Commander:** Marcus Webb

## Summary

A deploy to the billing service introduced a currency-rounding bug that caused about 1,200 invoices to be generated with incorrect totals (overcharges of $0.01 to $4.20). The nightly Stripe sync pushed the incorrect invoices before the issue was detected.

## Timeline (UTC)

- 01:40 Deploy of billing build 8812 to 100% after a 5-minute canary
- 02:00 Nightly Stripe invoice sync runs
- 03:10 Customer Support receives first tickets about wrong invoice amounts
- 03:25 Incident declared, SEV-1
- 03:41 Rollback to build 8809 complete
- 03:54 Stripe sync paused; affected invoices voided and reissued

## Root cause

The rounding helper switched from banker's rounding to round-half-up, but the unit tests only covered USD. Invoices in EUR and GBP with three-decimal intermediate values were affected.

## Follow-ups

1. Canary duration raised from 5 to 15 minutes (done; Deploy Runbook updated).
2. Billing deploys require a second approver from Payments (done).
3. Add multi-currency test fixtures (owner: Payments, due Oct 15).
4. Support macro for affected customers: apologize, confirm the reissued invoice, and offer a one-month 10% credit (done).
5. Reinforce the no-Friday-deploy rule; this deploy happened outside the deploy window.
