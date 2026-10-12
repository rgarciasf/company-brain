---
title: Engineering Onboarding Guide
owner: Priya Nair (Eng Enablement)
updated: 2026-08-14
---

# Engineering Onboarding Guide

Welcome to Acme engineering! This guide covers your first two weeks.

## Day 1: Accounts and access

- Your laptop is pre-provisioned by IT. Sign in with your Acme SSO account.
- Request GitHub access through the **Access Portal** (go/access). Select the `acme-eng` group. Approval is automatic for engineers.
- Request AWS read-only access via the Access Portal (`aws-readonly`). Production write access (`aws-prod-deploy`) requires manager approval and completion of the Production Safety training.
- Join Slack channels: #eng-general, #eng-help, #deploys, #incidents.

## Day 2-3: Local development environment

1. Install Homebrew, then run `brew bundle` in the `acme/dev-setup` repo.
2. Clone the `pulse` monorepo and run `make bootstrap`. This installs Node 24, pnpm, Postgres 17 via Docker, and seeds a local database.
3. Run `make dev` to start the API on port 4000 and the web app on port 3000.
4. If `make bootstrap` fails on Apple Silicon with a Docker platform error, set `DOCKER_DEFAULT_PLATFORM=linux/arm64` and retry.

## Week 1: Your first change

- Every new engineer ships a small change in week one. Your onboarding buddy will pick a `good-first-issue` ticket with you.
- All PRs need one approving review and green CI. Use conventional commit titles (`feat:`, `fix:`, `chore:`).
- Read the Deploy Runbook before your first deploy. New engineers deploy with their buddy for their first two deploys.

## Week 2: Production readiness

- Complete Production Safety training (in the LMS, about 45 minutes).
- Shadow one on-call shift. Ask the current on-call engineer in #oncall.
- You join the on-call rotation after 6 weeks.

## Who to ask

- Onboarding questions: your buddy, or #eng-help
- Access problems: #it-help or the IT Service Desk tool
- Engineering Enablement owner: Priya Nair
