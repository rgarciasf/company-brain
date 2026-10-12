---
title: Information Security Policy
owner: Security Team (CISO Hannah Cho)
updated: 2026-05-20
---

# Information Security Policy

## Passwords and authentication

- All company systems use SSO with a hardware security key (YubiKey) as the second factor. SMS codes are not permitted.
- Lost a security key? Report it in #security-help immediately; IT ships a replacement the next business day. Use your backup key in the meantime.

## Data classification

- **Public**: marketing site, public docs.
- **Internal**: wiki, meeting notes, roadmaps. Do not share outside Acme.
- **Confidential**: customer data, financials, HR records. Access is need-to-know and logged.
- Customer data must never be copied to personal devices or pasted into unapproved AI tools. The approved AI tools list is maintained in the Internal Tools directory.

## Devices

- Laptops must have disk encryption, auto-lock after 5 minutes, and the endpoint agent installed.
- Personal phones may access Slack and email only after enrolling in device management.

## Reporting a security incident

- Suspected phishing: use the **Report Phish** button in email, or forward to phish@acme.example.
- Any suspected data exposure: page the Security on-call via the Incident Tracker immediately, severity SEV-1 by default.

## Vendor access

- New vendors handling Confidential data require a security review (allow 2-3 weeks). Request via the Vendor Review form.
