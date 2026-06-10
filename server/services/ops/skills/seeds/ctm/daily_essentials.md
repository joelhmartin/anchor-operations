---
slug: ctm.daily_essentials
umbrella: ctm
title: CTM daily essentials
collectors: [ctm.tracking_number_health, ctm.classification_quality, ctm.form_flow, ctm.webhook_sync]
cost_estimate_cents: 0
---

# What to check

- Tracking number health: any disabled, errored, or stale (no calls in 14d) numbers.
- Classification quality: backlog of `pending_review`/`unreviewed` rows, autostar drift, spam %.
- Form flow: forms with autoresponder enabled but missing reply-to/subject; forms with no submissions in 7d.
- Webhook sync: most recent CTM-sourced call vs now (warn if > 24h).

# How to interpret

A `volume_drop` from classification_quality combined with a stale webhook_sync is a critical compound finding ("CTM ingestion broken"). Tag accordingly. If the same client repeatedly shows zero submissions on a specific form, propose a tighter form-flow check via a suggestion.
