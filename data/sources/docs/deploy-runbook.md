---
title: Deploy Runbook
owner: Marcus Webb (Platform Team)
updated: 2026-09-25
---

# Deploy Runbook

## Deploy windows

- Production deploys are allowed Monday to Thursday, 9:00-16:00 Pacific.
- **No deploys on Fridays** or the day before a company holiday, except for hotfixes approved by the on-call Incident Commander.
- Deploy freeze for the year-end period runs from December 18 to January 4.

## Standard deploy steps

1. Merge your PR to `main`. CI builds a release artifact automatically.
2. In the Deploy Console (go/deploy), select the build and click **Deploy to staging**.
3. Run the smoke test suite: `make smoke ENV=staging`. All checks must pass.
4. Promote to production with **Canary 10%**. Watch the Pulse Health dashboard for 15 minutes.
5. If error rate stays under 0.5% and p95 latency stays under 400ms, promote to 100%.
6. Post a message in #deploys with the build number and a summary.

## Rollback

- In the Deploy Console, click **Rollback** on the previous healthy build. Rollback takes about 3 minutes.
- Database migrations must be backwards-compatible for one release so rollback is always safe.
- After a rollback, open an incident in the Incident Tracker if customers were affected.

## Feature flags

- All user-facing changes ship behind a feature flag in FlagHouse.
- Flags must be removed within 30 days of reaching 100% rollout.

## Changes since the September incident

After the 2026-09-19 billing outage (see the incident review), canary duration was raised from 5 minutes to 15 minutes, and any deploy that touches the `billing` service now requires a second approver from the Payments team.
