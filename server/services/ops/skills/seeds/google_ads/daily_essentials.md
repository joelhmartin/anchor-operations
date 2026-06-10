---
slug: google_ads.daily_essentials
umbrella: google_ads
title: Google Ads daily essentials
collectors: [gads.account.disapproved_ads, gads.account.budget_pacing, gads.conversion_tag.firing, gads.conversion_action.cpa_drift]
cost_estimate_cents: 6
---

# What to check

- Account status: flag suspended or limited.
- Disapprovals: any policy violations on active ads or extensions.
- Budget pacing: flag if daily spend < 50% or > 150% of plan.
- Conversion health: flag if conversion volume drops 30%+ vs 7-day median, or if no conversions in 48h on an account that had them.

# How to interpret

Disapprovals are always actionable. Budget pacing flags should reference the campaign and a 7-day chart. If conversion volume drops, cross-check with website uptime findings before raising critical.
