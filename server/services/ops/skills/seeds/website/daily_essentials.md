---
slug: website.daily_essentials
umbrella: website
title: Website daily essentials
collectors: [web.psi, web.ssl.expiry_within_30d, web.ssl.expiry_within_7d, web.uptime.reachable, web.kinsta.drift]
cost_estimate_cents: 4
---

# What to check

- **PageSpeed Insights mobile score**: flag if < 70, or if 5+ point drop vs prior 7-day median.
- **SSL certificate**: warn if expiry < 30 days, fail if < 7 days.
- **Uptime**: flag any 5xx or downtime within last 24h.
- **Kinsta drift**: flag any new high/critical findings since last run.

# How to interpret

A finding is **critical** only when user-facing. Internal-only deltas roll up as **info**. Always include the affected URL(s) in the finding payload. If you find that the same false-positive recurs across runs, propose a refinement to this skill (do not modify it directly).
