---
slug: meta.daily_essentials
umbrella: meta
title: Meta daily essentials
collectors: [meta.account.spending_limit, meta.account.disapproved_ads, meta.pixel.health, meta.capi.health]
cost_estimate_cents: 5
---

# What to check

- Account status: flag any restriction or pixel access issue.
- Spend pacing: flag if daily spend deviates >50% from 7-day median.
- Disapprovals: flag any rejected ads or pixels with elevated event-quality issues.

# How to interpret

Never run this skill against a `client_type='medical'` client — Meta is HIPAA-blocked. The runner enforces this; if you ever see a medical client reach this skill, treat it as a critical finding ("HIPAA gate breach") and abort.
