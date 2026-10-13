---
title: Brightline Health - Quarterly Business Review (call transcript)
owner: Sofia Marin (Product)
updated: 2026-10-06
---

# Brightline Health - Quarterly Business Review

**Attendees:** Sofia Marin (Acme), Ben Torres (Acme Support), Lena Okafor (Acme Data Infra), Tom Becker (Acme Product), Maya Chen (Brightline Health, Head of Analytics), Daniel Ortiz (Brightline Health, IT Admin)

## Transcript

[00:00:12] Sofia Marin: Thanks for making time, Maya, Daniel. The plan today is the September billing incident, the Okta login issue, AI Insights, and the Reports v1 deprecation.
[00:00:31] Maya Chen: Sounds good. Billing first, please. Our finance team noticed the invoice was off and then got a corrected one.
[00:01:05] Ben Torres: Yes, that was INC-2291 on September 19. A rounding bug in the billing service produced wrong invoices for about 1,200 customers. Yours was voided and reissued on September 24.
[00:01:40] Maya Chen: Our CFO wants something in writing for the audit file. Can you send a written summary of the incident and confirm the reissued amount?
[00:01:58] Ben Torres: Absolutely. I'll send you a written incident summary with the corrected invoice amount by Thursday, October 9.
[00:02:30] Daniel Ortiz: On my side, the Okta problem. After we renamed our domain, nobody could sign in for half a day.
[00:02:52] Ben Torres: That was ticket SUP-10421. The fix was re-verifying the domain in the SSO settings. It's solved, but you shouldn't have had to find that out the hard way.
[00:03:20] Daniel Ortiz: We're renaming two more subsidiaries' domains next month. Is there a checklist?
[00:03:35] Ben Torres: We'll write you a step-by-step runbook for renaming an SSO domain without locking anyone out. I'll get that to you by October 15.
[00:04:10] Maya Chen: Okay. Now the fun part: AI Insights. We'd really like to be in the beta.
[00:04:28] Sofia Marin: You're a great fit, you're on Enterprise and heavy dashboard users. I'll add Brightline Health to the beta list. We finalise the 25 accounts by October 10, and the beta starts November 12.
[00:05:02] Maya Chen: Our security team will ask how permissions work. We have dashboards that only some analysts can see.
[00:05:20] Lena Okafor: Insights will respect workspace permissions, so no insight is ever generated from a dashboard a user can't open. I can share the permission model design doc with your security team.
[00:05:44] Maya Chen: Please do. When could they have it?
[00:05:50] Lena Okafor: I'll send the AI Insights permission design doc to your security team by October 17.
[00:06:30] Tom Becker: Last topic: Reports v1 is being retired. Removal is January 13, 2027. Your workspace still has 14 reports on v1.
[00:06:55] Maya Chen: Fourteen? I thought we'd moved everything. What's the easiest path?
[00:07:10] Tom Becker: Dashboards v2 can import most v1 reports. I'll set up a migration workshop with your analysts. Let's aim to hold it before October 24.
[00:07:35] Maya Chen: Great. Then we agree: Brightline migrates all Reports v1 to Dashboards v2 by December 15, well before the removal date.
[00:07:48] Tom Becker: Agreed. I'll also send you the list of the 14 reports today.
[00:08:20] Daniel Ortiz: One more thing, can we get a sandbox workspace to test the domain rename?
[00:08:32] Ben Torres: Yes, I'll set up a sandbox workspace for you this week, by October 10.
[00:09:05] Sofia Marin: Great. To recap: incident summary from Ben by the 9th, the beta spot by the 10th, the sandbox by the 10th, the SSO runbook by the 15th, Lena's permission doc by the 17th, and the migration workshop before the 24th.
[00:09:30] Maya Chen: Perfect. Thanks, everyone.
