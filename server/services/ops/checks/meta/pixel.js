/**
 * Meta umbrella — Pixel & CAPI health checks.
 *
 * All checks here MUST call assertNonMedical() first. Meta does not sign BAAs
 * (CLAUDE.md), so medical clients are explicitly skipped with reason
 * 'hipaa_no_meta'.
 *
 * Per-run memoization on ctx avoids hitting /adspixels and /pixel stats more
 * than once when several pixel-tier checks run in the same run.
 */

import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';
import { assertNonMedical } from './_hipaaGate.js';
import { getAdAccountClient, adapterSkipOutcome } from './_client.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const _pixelCacheKey = '_metaPixelStatsCache';
const _trackingCacheKey = '_metaTrackingConfigCache';

const COST_CENTS = 1;

async function loadPixelStats(ctx, client) {
  if (ctx && ctx[_pixelCacheKey] !== undefined) return ctx[_pixelCacheKey];
  // List pixels on the ad account, then fetch detailed stats for the first
  // active pixel. The Graph API `last_fired_time`, `last_received_time` and
  // `match_keys_quality_score` fields live on /<pixel_id>?fields=...
  let payload = null;
  try {
    const list = await client.graph(`${client.adAccountId}/adspixels?fields=id,name,last_fired_time`);
    const pixels = Array.isArray(list?.data) ? list.data : [];
    if (pixels.length === 0) {
      payload = { ok: false, reason: 'no Meta pixel attached to ad account', pixels: [] };
    } else {
      const primary = pixels[0];
      // Detailed pixel record: server-event metrics + match-quality.
      // `event_stats` and `match_keys_quality_score` are gated; if Meta
      // returns a permission error we fall back to the lightweight `last_fired_time`.
      let detail = null;
      try {
        detail = await client.graph(
          `${primary.id}?fields=id,name,last_fired_time,creation_time,is_unavailable,automatic_matching_fields,first_party_cookie_status`
        );
      } catch (err) {
        detail = { id: primary.id, name: primary.name, last_fired_time: primary.last_fired_time, _detailError: err.message };
      }
      payload = { ok: true, primary: detail, pixels };
    }
  } catch (err) {
    payload = { ok: false, reason: `Meta pixel fetch failed: ${err.message}` };
  }
  if (ctx) ctx[_pixelCacheKey] = payload;
  return payload;
}

async function loadTrackingConfig(ctx) {
  if (ctx && ctx[_trackingCacheKey] !== undefined) return ctx[_trackingCacheKey];
  let row = null;
  try {
    const { rows } = await query(
      `SELECT meta_pixel_id, meta_capi_token, allowed_events, relay_enabled, client_type
         FROM tracking_configs WHERE user_id = $1 LIMIT 1`,
      [ctx?.clientUserId]
    );
    row = rows[0] || null;
  } catch (err) {
    console.warn(`[ops/meta] tracking_configs read failed: ${err.message}`);
  }
  if (ctx) ctx[_trackingCacheKey] = row;
  return row;
}

function ageInHours(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / (1000 * 60 * 60);
}

// ---------------------------------------------------------------------------
// meta.pixel.health — last_fired_time within 24h
// ---------------------------------------------------------------------------
registerCheck('meta.pixel.health', {
  umbrella: 'meta',
  tier: 'daily_essential',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    const stats = await loadPixelStats(ctx, client);
    if (!stats.ok) return { status: 'skipped', payload: { reason: stats.reason } };

    const lastFired = stats.primary?.last_fired_time || null;
    const hours = ageInHours(lastFired);
    const within24h = hours != null && hours <= 24;

    return {
      status: within24h ? 'pass' : 'fail',
      severity: within24h ? null : 'critical',
      payload: {
        pixel_id: stats.primary?.id || null,
        pixel_name: stats.primary?.name || null,
        last_fired_time: lastFired,
        hours_since_last_fire: hours,
        threshold_hours: 24,
        is_unavailable: !!stats.primary?.is_unavailable
      },
      cost_cents: COST_CENTS
    };
  }
});

// ---------------------------------------------------------------------------
// meta.capi.health — last_received_time within 24h
// ---------------------------------------------------------------------------
registerCheck('meta.capi.health', {
  umbrella: 'meta',
  tier: 'daily_essential',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    const stats = await loadPixelStats(ctx, client);
    if (!stats.ok) return { status: 'skipped', payload: { reason: stats.reason } };

    // Server events surface in `stats?fields=last_received_time` on the pixel.
    let serverStats = null;
    try {
      serverStats = await client.graph(
        `${stats.primary.id}/stats?aggregation=event&start_time=${Math.floor((Date.now() - 7 * ONE_DAY_MS) / 1000)}`
      );
    } catch (err) {
      return { status: 'skipped', payload: { reason: `Meta server-events stats fetch failed: ${err.message}` } };
    }

    const events = Array.isArray(serverStats?.data) ? serverStats.data : [];
    // last_received_time may be at the pixel level OR per-event row depending on
    // API version. We surface both.
    const lastServerEvent = events
      .map((e) => e.last_received_time || e.start_time || null)
      .filter(Boolean)
      .sort()
      .reverse()[0] || null;

    const hours = ageInHours(lastServerEvent);
    const within24h = hours != null && hours <= 24;

    return {
      status: within24h ? 'pass' : events.length === 0 ? 'fail' : 'fail',
      severity: within24h ? null : 'critical',
      payload: {
        pixel_id: stats.primary?.id || null,
        last_received_time: lastServerEvent,
        hours_since_last_event: hours,
        threshold_hours: 24,
        event_count_7d: events.length
      },
      cost_cents: COST_CENTS
    };
  }
});

// ---------------------------------------------------------------------------
// meta.capi.match_quality — match_keys_quality_score < 7.0 → warn
// ---------------------------------------------------------------------------
registerCheck('meta.capi.match_quality', {
  umbrella: 'meta',
  tier: 'weekly_deep',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    const stats = await loadPixelStats(ctx, client);
    if (!stats.ok) return { status: 'skipped', payload: { reason: stats.reason } };

    let scoreRecord = null;
    try {
      scoreRecord = await client.graph(
        `${stats.primary.id}/event_match_quality?fields=event_match_quality_score,event_name`
      );
    } catch (err) {
      return { status: 'skipped', payload: { reason: `event_match_quality unavailable: ${err.message}` } };
    }

    const rows = Array.isArray(scoreRecord?.data) ? scoreRecord.data : [];
    const numericScores = rows
      .map((r) => parseFloat(r.event_match_quality_score))
      .filter((n) => Number.isFinite(n));
    const avg = numericScores.length > 0
      ? numericScores.reduce((s, n) => s + n, 0) / numericScores.length
      : null;

    const THRESHOLD = 7.0;
    let status = 'pass';
    let severity = null;
    if (avg == null) {
      status = 'skipped';
    } else if (avg < THRESHOLD) {
      status = 'fail';
      severity = 'warning';
    }

    return {
      status,
      severity,
      payload: {
        pixel_id: stats.primary?.id || null,
        avg_match_quality_score: avg,
        threshold: THRESHOLD,
        per_event: rows.map((r) => ({
          event_name: r.event_name,
          score: parseFloat(r.event_match_quality_score) || null
        }))
      },
      cost_cents: COST_CENTS
    };
  }
});

// ---------------------------------------------------------------------------
// meta.pixel.event_coverage — cross-ref with tracking_configs.allowed_events
// Expectations: Lead, Contact, Schedule (per Plan §7.2)
// ---------------------------------------------------------------------------
const EXPECTED_EVENTS = ['Lead', 'Contact', 'Schedule'];

registerCheck('meta.pixel.event_coverage', {
  umbrella: 'meta',
  tier: 'weekly_deep',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    const stats = await loadPixelStats(ctx, client);
    if (!stats.ok) return { status: 'skipped', payload: { reason: stats.reason } };

    // Fetch event names actually fired against the pixel in the last 7 days.
    let firedEventNames = [];
    try {
      const aggregation = await client.graph(
        `${stats.primary.id}/stats?aggregation=event&start_time=${Math.floor((Date.now() - 7 * ONE_DAY_MS) / 1000)}`
      );
      firedEventNames = (aggregation?.data || [])
        .map((row) => row.event || row.event_name || null)
        .filter(Boolean);
    } catch (err) {
      return { status: 'skipped', payload: { reason: `pixel stats unavailable: ${err.message}` } };
    }

    const trackingConfig = await loadTrackingConfig(ctx);
    const expected = EXPECTED_EVENTS;
    const fired = new Set(firedEventNames);
    const missing = expected.filter((e) => !fired.has(e));

    return {
      status: missing.length === 0 ? 'pass' : 'fail',
      severity: missing.length === 0 ? null : 'warning',
      payload: {
        pixel_id: stats.primary?.id || null,
        expected_events: expected,
        fired_events: Array.from(fired),
        missing_events: missing,
        tracking_config_present: !!trackingConfig,
        tracking_allowed_events: trackingConfig?.allowed_events || null
      },
      cost_cents: COST_CENTS
    };
  }
});

// ---------------------------------------------------------------------------
// meta.pixel.deduplication — server+browser event_id dedup rate
// ---------------------------------------------------------------------------
registerCheck('meta.pixel.deduplication', {
  umbrella: 'meta',
  tier: 'weekly_deep',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    const stats = await loadPixelStats(ctx, client);
    if (!stats.ok) return { status: 'skipped', payload: { reason: stats.reason } };

    // The Meta dedup metric lives on /<pixel_id>/stats?aggregation=browser_vs_server
    // when available; otherwise we surface skipped with a reason rather than
    // guessing.
    let dedupPayload = null;
    try {
      dedupPayload = await client.graph(
        `${stats.primary.id}/stats?aggregation=browser_vs_server&start_time=${Math.floor((Date.now() - 7 * ONE_DAY_MS) / 1000)}`
      );
    } catch (err) {
      return { status: 'skipped', payload: { reason: `dedup stats unavailable: ${err.message}` } };
    }

    const rows = Array.isArray(dedupPayload?.data) ? dedupPayload.data : [];
    let browser = 0;
    let server = 0;
    let deduplicated = 0;
    for (const r of rows) {
      browser += parseInt(r.browser_count, 10) || 0;
      server += parseInt(r.server_count, 10) || 0;
      deduplicated += parseInt(r.deduplicated_count, 10) || 0;
    }

    const totalPaired = Math.min(browser, server);
    const dedupRate = totalPaired > 0 ? deduplicated / totalPaired : null;

    // Healthy dedup rate ≥ 0.7 (Meta best practice). Below 0.5 is a critical
    // signal that browser & server events aren't matching event_id.
    let status = 'pass';
    let severity = null;
    if (dedupRate == null) {
      status = 'skipped';
    } else if (dedupRate < 0.5) {
      status = 'fail';
      severity = 'critical';
    } else if (dedupRate < 0.7) {
      status = 'fail';
      severity = 'warning';
    }

    return {
      status,
      severity,
      payload: {
        pixel_id: stats.primary?.id || null,
        browser_event_count_7d: browser,
        server_event_count_7d: server,
        deduplicated_count_7d: deduplicated,
        dedup_rate: dedupRate,
        threshold_warning: 0.7,
        threshold_critical: 0.5
      },
      cost_cents: COST_CENTS
    };
  }
});
