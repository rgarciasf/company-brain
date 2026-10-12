---
title: Release Notes - Pulse 4.2
owner: Product Eng
updated: 2026-09-29
---

# Pulse 4.2 Release Notes (September 29, 2026)

## New

- Funnel step limit raised from 10 to 20 steps.
- Alerts can now post to PagerDuty.
- Dashboard tiles support custom date comparisons ("vs. same period last year").

## Improved

- CSV export is 3x faster for exports under 1 GB.
- iOS SDK reduces battery usage during background sync.

## Fixed

- Retention chart showed wrong cohort sizes when a timezone other than UTC was set.
- SSO login loop for Entra ID users with more than 150 groups.

## Known issues

- Android 15 devices: app may crash when opening a dashboard with more than 12 tiles. Fix coming in 4.3. Workaround: use the web app or split the dashboard.
