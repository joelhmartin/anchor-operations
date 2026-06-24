# Content Marketing Suite — North Star

**Date:** 2026-06-23
**Status:** Vision / architecture reference. Each sub-project below gets its own spec → plan → build cycle and references this doc.
**Home:** `anchor-operations` (everything content-related lives here — decided 2026-06-23).

---

## 1. Why

`anchor-operations` is already the agency's **automation + intelligence brain**: it
runs cross-platform health checks (website / Google Ads / Meta), pulls SEMrush +
Google Search Console data, exposes a per-client AI supervisor with approval-gated
mutations, correlates anomalies across platforms, and emails clients digest reports —
all under per-client cost caps and an immutable approval audit trail.

What it can't do yet is **act on the marketing side**: plan content, draft it, publish
it, and measure whether it worked. Today the agency does that by hand in the main
dashboard's social tool, with SEO research happening nowhere systematic.

The goal is to turn ops from "tells you what's wrong" into "fixes the marketing too":

> *"GSC says you're slipping on 'emergency dentist'. CTM says those calls convert at
> 40%. Here's a 6-post plan to win the term back — 4 social posts + 2 blogs, drafts
> attached. Approve and I'll schedule, publish, and track the lift in rankings and
> calls."*

That sentence only works because the planning brain (SEMrush/GSC/AI), the publishing
rails (FB/IG/blog), and the measurement loop (Ads/Meta/CTM/correlator) all live in the
**same app, over the same client roster, under the same cost + approval governance.**
That co-location is the entire reason for putting content in ops rather than the main
dashboard.

---

## 2. End-state pipeline

```
   SEMrush + GSC           AI supervisor          publish rails          measurement
   (already in ops)        (already in ops)       (sub-projects A/B)     (already in ops)
        │                       │                      │                      │
        ▼                       ▼                      ▼                      ▼
   keyword gaps,   ──▶   content plan      ──▶   draft posts/blogs  ──▶  schedule + publish
   ranking drops,        (proposed,              (AI, approval-           (FB/IG cron, WP)
   competitor moves      cost-capped)            gated to live pages)          │
                                                                               ▼
                                                            correlate lift: rankings (GSC),
                                                            impressions/spend (Ads/Meta),
                                                            calls/leads (CTM) → reports + digest
```

Every arrow that touches a client's live property (publishing, plugin/site mutations)
passes through the **existing approval gate** (`ops_tool_approvals` + four security
events). Every AI hop counts against the client's **existing monthly cost cap**
(`budgetGuard.js`). Nothing about the governance model is new — content is just a new
surface that rides the rails ops already has.

---

## 3. Integration map — how content marries the existing ops brain

The content suite is **not a silo**. It plugs into systems that already exist:

| Existing ops capability | File(s) today | How content uses it | Sub-project |
|---|---|---|---|
| SEMrush + GSC checks / agent tools | `checks/website/`, `agents/subAgents/websiteTools.js` | Source the keyword gaps, ranking drops, and competitor signals that seed a content plan | **D** |
| AI supervisor + sub-agents | `agents/supervisor.js`, `agents/vertexRuntime.js`, `subAgents/` | Generate content plans, draft posts/blogs, all approval-gated and cost-capped | **D** (drafting), **A+** (governance) |
| Google Ads + Meta analytics | `services/analytics/` (main) / ops Ads+Meta checks | Correlate content cadence against impressions / spend / CTR | **C/D** (reporting) |
| CTM (calls + leads) | `services/ctm.js` (slim shim in ops) | The ROI signal — did published content drive calls/leads | **C/D** (reporting) |
| Cross-platform correlator | `correlator.js`, `correlatorRules.js` | Emit content-performance findings ("published 6 posts, rankings up, calls flat — investigate") | **C/D** |
| Reports + email digest | `reportRenderer.js`, `emailDigest.js` | Fold content activity + lift into the client reports/digests clients already receive | **C/D** |
| Cost caps + approval audit | `budgetGuard.js`, `costTracker.js`, `ops_tool_approvals` | Govern AI drafting spend + gate publishing to live FB/IG pages and WP sites | **A onward** |

---

## 4. Roadmap (each = its own spec → plan → build)

| # | Sub-project | What it delivers | Depends on | Status of building blocks |
|---|---|---|---|---|
| **A** | **Port social publisher → ops** | FB/IG posting + Calendar/Queue/Compose UI under a new **Content** tab; removed from main app | — | Mature code in main app; lift-and-shift |
| **B** | **Blog: WordPress publishing + scheduling** | Real `POST` to client WordPress + scheduled blog posts (drafting already exists) | A (publish-rail patterns) | Connection layer mature; publish + schedule absent |
| **C** | **Editorial content calendar** | Plan months out, approval workflow, unified social + blog view; first content-performance reporting | A, B | Partial calendar exists in main app |
| **D** | **SEO content brain** | SEMrush/GSC → AI content plan → drafts → approval → publish → measured lift | A, B, C | Brain (SEMrush/GSC/AI) already in ops |

**Build order rationale:** rails before intelligence. A and B give ops the dumb-but-
reliable ability to *publish*. C organizes *what's scheduled*. D is the payoff that
orchestrates all of it and closes the measurement loop. Starting at D first would
produce plans/drafts that can't actually ship until A/B land.

---

## 5. Non-goals (for the whole suite, unless a later spec revisits)

- **TikTok / LinkedIn / X publishing** — TikTok is a stubbed OAuth provider only; out
  of scope until explicitly prioritized.
- **Replacing the existing health-check / Ads / Meta / CTM systems** — content is
  *added alongside* them and *reads* them; none are rebuilt or removed.
- **Client self-serve content authoring** — the suite is a staff/agency tool inside the
  ops command center; clients receive results via the existing reports/digests, not a
  new authoring UI.
- **Fully autonomous publishing** — anything hitting a client's live property stays
  behind the approval gate. "Implementation" means AI does the work; a human approves
  the live action.

---

*References: `docs/OPERATIONS.md` (existing ops architecture). Sub-project specs live
alongside this file in `docs/superpowers/specs/`.*
