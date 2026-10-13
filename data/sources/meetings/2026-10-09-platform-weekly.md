---
title: Platform Weekly - 2026-10-09 (call transcript)
owner: Marcus Webb (Platform Team)
updated: 2026-10-09
---

# Platform Weekly - October 9, 2026

**Attendees:** Marcus Webb (chair), Lena Okafor, Priya Nair, Hannah Cho, Aisha Khan

## Transcript

[00:00:08] Marcus Webb: Morning. Agenda: the EU ingestion delay, the Query Engine runbook, the AI Insights security review, onboarding, and the 4.3 release.
[00:00:25] Lena Okafor: EU first. DI-4410 is still open. Events in eu-central are arriving six to nine minutes late at peak. The root cause is an unbalanced Kafka partition on the ingest service.
[00:01:02] Marcus Webb: Customers are noticing. Nordvik Retail opened a ticket, SUP-10488.
[00:01:15] Lena Okafor: The partition rebalance fix is ready. I'll deploy it to eu-central by Tuesday, October 14, and then confirm the delay is back under one minute.
[00:01:40] Marcus Webb: And someone needs to update Nordvik when it lands.
[00:01:48] Lena Okafor: I'll update the Nordvik ticket the same day the fix is deployed.
[00:02:20] Marcus Webb: Next, the Query Engine. People keep asking what to do when it goes down, and we have no runbook for it.
[00:02:38] Priya Nair: The knowledge base flags it as a gap too. New on-call engineers have nothing to follow.
[00:02:50] Marcus Webb: That's on me. I'll write the Query Engine outage runbook, with diagnosis commands, failover and what degrades for Dashboards v2 and AI Insights, by October 17.
[00:03:30] Hannah Cho: Security review for AI Insights. Before any customer sees the beta, I need to review the permission model.
[00:03:45] Lena Okafor: The design doc is ready. I'm also sharing it with Brightline Health's security team next week.
[00:03:58] Hannah Cho: Then I'll complete the AI Insights security review by October 24, before the beta on November 12.
[00:04:30] Priya Nair: Quick update on onboarding: I finished updating the onboarding guide with the new Deploy Console steps on Monday. That one's done.
[00:04:45] Marcus Webb: Nice, thanks Priya.
[00:05:10] Aisha Khan: Release 4.3. The Android 15 crash fix is on track. Code complete by October 20, release on October 27.
[00:05:30] Marcus Webb: Then we should protect the release. Proposal: no production deploys from October 24 until the 4.3 release on the 27th, except hotfixes.
[00:05:44] Lena Okafor: That collides with nothing on my side once the EU fix is out on the 14th.
[00:05:52] Marcus Webb: Decision then: deploy freeze from October 24 to October 27, hotfixes only.
[00:06:15] Aisha Khan: I'll also post the 4.3 release notes draft for review by October 22.
[00:06:40] Marcus Webb: Good. Action items are in the notes. Thanks, all.
