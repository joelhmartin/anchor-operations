/**
 * Meta umbrella — Audience & delivery checks (Plan §7.3).
 *
 * Read-only in v1 (P5). Every check enforces the HIPAA gate up-front.
 *
 * Each check is intentionally narrow: one Graph call per check at most, with
 * per-run memoization where two checks share the same upstream payload.
 */

import { registerCheck } from '../registry.js';
import { assertNonMedical } from './_hipaaGate.js';
import { getAdAccountClient, adapterSkipOutcome } from './_client.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const COST_CENTS = 1;

const _adsetsCacheKey = '_metaAdsetsCache';
const _audiencesCacheKey = '_metaAudiencesCache';

async function loadAdSets(ctx, client) {
  if (ctx && ctx[_adsetsCacheKey] !== undefined) return ctx[_adsetsCacheKey];
  let payload = null;
  try {
    const res = await client.graph(
      `${client.adAccountId}/adsets?fields=id,name,status,effective_status,configured_status,learning_stage_info,issues_info,daily_budget,lifetime_budget,created_time,start_time,end_time&limit=200&filtering=${encodeURIComponent(
        JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'LEARNING'] }])
      )}`
    );
    payload = { ok: true, adsets: res?.data || [] };
  } catch (err) {
    payload = { ok: false, reason: `adsets fetch failed: ${err.message}` };
  }
  if (ctx) ctx[_adsetsCacheKey] = payload;
  return payload;
}

async function loadAudiences(ctx, client) {
  if (ctx && ctx[_audiencesCacheKey] !== undefined) return ctx[_audiencesCacheKey];
  let payload = null;
  try {
    const res = await client.graph(
      `${client.adAccountId}/customaudiences?fields=id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status,time_updated&limit=200`
    );
    payload = { ok: true, audiences: res?.data || [] };
  } catch (err) {
    payload = { ok: false, reason: `customaudiences fetch failed: ${err.message}` };
  }
  if (ctx) ctx[_audiencesCacheKey] = payload;
  return payload;
}

// ---------------------------------------------------------------------------
// meta.audience.size — approximate_count above minimum-serving threshold
// ---------------------------------------------------------------------------
const MIN_AUDIENCE_THRESHOLD = 1000; // Meta's documented serving minimum

registerCheck('meta.audience.size', {
  umbrella: 'meta',
  tier: 'weekly_deep',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    const aud = await loadAudiences(ctx, client);
    if (!aud.ok) return { status: 'skipped', payload: { reason: aud.reason } };

    const tooSmall = [];
    for (const a of aud.audiences) {
      const lower = parseInt(a.approximate_count_lower_bound, 10);
      if (Number.isFinite(lower) && lower > 0 && lower < MIN_AUDIENCE_THRESHOLD) {
        tooSmall.push({ id: a.id, name: a.name, lower_bound: lower });
      }
    }

    return {
      status: tooSmall.length === 0 ? 'pass' : 'fail',
      severity: tooSmall.length === 0 ? null : 'warning',
      payload: {
        audience_count: aud.audiences.length,
        threshold: MIN_AUDIENCE_THRESHOLD,
        below_threshold: tooSmall
      },
      cost_cents: COST_CENTS
    };
  }
});

// ---------------------------------------------------------------------------
// meta.audience.overlap — overlap > 30% warn
// ---------------------------------------------------------------------------
const AUDIENCE_OVERLAP_WARN = 0.30;

registerCheck('meta.audience.overlap', {
  umbrella: 'meta',
  tier: 'weekly_deep',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    const aud = await loadAudiences(ctx, client);
    if (!aud.ok) return { status: 'skipped', payload: { reason: aud.reason } };

    const audiences = aud.audiences;
    if (audiences.length < 2) {
      return {
        status: 'pass',
        payload: { reason: 'fewer than 2 audiences; overlap not applicable', count: audiences.length },
        cost_cents: COST_CENTS
      };
    }

    // Pairwise overlap_estimate is expensive; restrict to top 10 by size.
    const ranked = [...audiences]
      .sort(
        (a, b) =>
          (parseInt(b.approximate_count_lower_bound, 10) || 0) -
          (parseInt(a.approximate_count_lower_bound, 10) || 0)
      )
      .slice(0, 10);

    const violations = [];
    const checked = [];
    for (let i = 0; i < ranked.length; i++) {
      for (let j = i + 1; j < ranked.length; j++) {
        const a = ranked[i];
        const b = ranked[j];
        try {
          const r = await client.graph(
            `${a.id}/overlap?comparison_audiences=[${b.id}]&fields=overlap_estimate`
          );
          const row = r?.data?.[0];
          const ratio = parseFloat(row?.overlap_estimate);
          checked.push({ a: a.id, b: b.id, ratio });
          if (Number.isFinite(ratio) && ratio > AUDIENCE_OVERLAP_WARN) {
            violations.push({ a_id: a.id, a_name: a.name, b_id: b.id, b_name: b.name, ratio });
          }
        } catch (err) {
          checked.push({ a: a.id, b: b.id, error: err.message });
        }
      }
    }

    return {
      status: violations.length === 0 ? 'pass' : 'fail',
      severity: violations.length === 0 ? null : 'warning',
      payload: {
        threshold: AUDIENCE_OVERLAP_WARN,
        violations,
        pairs_checked: checked.length
      },
      cost_cents: COST_CENTS
    };
  }
});

// ---------------------------------------------------------------------------
// meta.adset.delivery_issues — surface delivery_estimate + issues_info
// ---------------------------------------------------------------------------
registerCheck('meta.adset.delivery_issues', {
  umbrella: 'meta',
  tier: 'daily_essential',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    const set = await loadAdSets(ctx, client);
    if (!set.ok) return { status: 'skipped', payload: { reason: set.reason } };

    const flagged = [];
    for (const a of set.adsets) {
      const issues = Array.isArray(a.issues_info) ? a.issues_info : [];
      if (issues.length > 0) {
        flagged.push({ id: a.id, name: a.name, issues });
      }
    }

    return {
      status: flagged.length === 0 ? 'pass' : 'fail',
      severity: flagged.length === 0 ? null : 'warning',
      payload: {
        adset_count: set.adsets.length,
        flagged
      },
      cost_cents: COST_CENTS
    };
  }
});

// ---------------------------------------------------------------------------
// meta.adset.learning_phase — count stuck >7 days
// ---------------------------------------------------------------------------
const LEARNING_STUCK_DAYS = 7;

registerCheck('meta.adset.learning_phase', {
  umbrella: 'meta',
  tier: 'weekly_deep',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    const set = await loadAdSets(ctx, client);
    if (!set.ok) return { status: 'skipped', payload: { reason: set.reason } };

    const now = Date.now();
    const stuck = [];
    for (const a of set.adsets) {
      const phase = a.learning_stage_info?.status;
      if (phase !== 'LEARNING') continue;
      const startedAt = Date.parse(a.start_time || a.created_time || '');
      if (!Number.isFinite(startedAt)) continue;
      const days = (now - startedAt) / ONE_DAY_MS;
      if (days > LEARNING_STUCK_DAYS) {
        stuck.push({ id: a.id, name: a.name, days_in_learning: Math.round(days) });
      }
    }

    return {
      status: stuck.length === 0 ? 'pass' : 'fail',
      severity: stuck.length === 0 ? null : 'warning',
      payload: {
        threshold_days: LEARNING_STUCK_DAYS,
        stuck_in_learning: stuck
      },
      cost_cents: COST_CENTS
    };
  }
});

// ---------------------------------------------------------------------------
// meta.adset.frequency — avg frequency > 4 in 7d
// ---------------------------------------------------------------------------
const FREQUENCY_THRESHOLD = 4.0;

registerCheck('meta.adset.frequency', {
  umbrella: 'meta',
  tier: 'weekly_deep',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    let insights;
    try {
      insights = await client.graph(
        `${client.adAccountId}/insights?fields=adset_id,adset_name,frequency,reach,impressions&date_preset=last_7d&level=adset&limit=500`
      );
    } catch (err) {
      return { status: 'skipped', payload: { reason: `adset insights failed: ${err.message}` } };
    }

    const violations = [];
    const rows = insights?.data || [];
    for (const r of rows) {
      const f = parseFloat(r.frequency);
      if (Number.isFinite(f) && f > FREQUENCY_THRESHOLD) {
        violations.push({
          adset_id: r.adset_id,
          adset_name: r.adset_name,
          frequency: f,
          reach: parseInt(r.reach, 10) || 0
        });
      }
    }

    return {
      status: violations.length === 0 ? 'pass' : 'fail',
      severity: violations.length === 0 ? null : 'warning',
      payload: {
        threshold: FREQUENCY_THRESHOLD,
        adsets_checked: rows.length,
        violations
      },
      cost_cents: COST_CENTS
    };
  }
});

// ---------------------------------------------------------------------------
// meta.creative.fatigue — 7d CTR < 50% of lifetime CTR
// ---------------------------------------------------------------------------
const FATIGUE_RATIO = 0.5;

registerCheck('meta.creative.fatigue', {
  umbrella: 'meta',
  tier: 'weekly_deep',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    let recent;
    let lifetime;
    try {
      [recent, lifetime] = await Promise.all([
        client.graph(
          `${client.adAccountId}/insights?fields=ad_id,ad_name,ctr,impressions&date_preset=last_7d&level=ad&limit=500`
        ),
        client.graph(
          `${client.adAccountId}/insights?fields=ad_id,ad_name,ctr,impressions&date_preset=maximum&level=ad&limit=500`
        )
      ]);
    } catch (err) {
      return { status: 'skipped', payload: { reason: `creative insights failed: ${err.message}` } };
    }

    const lifetimeMap = new Map();
    for (const r of lifetime?.data || []) {
      lifetimeMap.set(r.ad_id, parseFloat(r.ctr) || 0);
    }

    const fatigued = [];
    for (const r of recent?.data || []) {
      const recentCtr = parseFloat(r.ctr) || 0;
      const lifetimeCtr = lifetimeMap.get(r.ad_id);
      if (!Number.isFinite(lifetimeCtr) || lifetimeCtr <= 0) continue;
      // Skip ads that haven't shown enough recently — noisy denominator.
      const impressions = parseInt(r.impressions, 10) || 0;
      if (impressions < 1000) continue;
      const ratio = recentCtr / lifetimeCtr;
      if (ratio < FATIGUE_RATIO) {
        fatigued.push({
          ad_id: r.ad_id,
          ad_name: r.ad_name,
          recent_ctr: recentCtr,
          lifetime_ctr: lifetimeCtr,
          ratio
        });
      }
    }

    return {
      status: fatigued.length === 0 ? 'pass' : 'fail',
      severity: fatigued.length === 0 ? null : 'warning',
      payload: {
        threshold_ratio: FATIGUE_RATIO,
        ads_checked: (recent?.data || []).length,
        fatigued
      },
      cost_cents: COST_CENTS
    };
  }
});
