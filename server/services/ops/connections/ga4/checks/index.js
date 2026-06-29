import { query } from '../../../../../db.js';
import { getCredential } from '../../../credentialStore.js';
import { buildGa4Client } from '../client.js';
import { parseRows, aggregateFirstRow } from '../_reportParser.js';
import {
  checkDrop,
  checkKeyEventMissing,
  checkFormEventNotFiring,
  checkAdsClicksVsSessionsGap,
  checkSourceMediumAnomaly
} from './_logic.js';

async function getGa4Context(ctx) {
  if (ctx.ga4Client && ctx.ga4PropertyId) {
    return { kind: 'ok', client: ctx.ga4Client, propertyId: String(ctx.ga4PropertyId) };
  }
  const cred = await getCredential(ctx.clientUserId, 'ga4').catch(() => null);
  if (!cred) return { kind: 'skipped', reason: 'no GA4 credential configured for this client (platform: ga4)' };
  const propertyId = cred.account_id;
  if (!propertyId) return { kind: 'skipped', reason: 'GA4 credential row has no account_id (expected the numeric GA4 property ID)' };
  const env = ctx.env || process.env;
  const client = buildGa4Client({ env, ga4Client: null });
  return { kind: 'ok', client, propertyId };
}

async function getBaseline(ctx, metricKey) {
  if (ctx.ga4Baseline != null && ctx.ga4Baseline[metricKey] !== undefined) {
    return ctx.ga4Baseline[metricKey];
  }
  if (!ctx.clientUserId) return null;
  try {
    const { rows } = await query(
      `SELECT baseline_value FROM ops_metric_baselines
        WHERE client_user_id = $1 AND service = 'ga4' AND metric = $2
        ORDER BY computed_at DESC LIMIT 1`,
      [ctx.clientUserId, metricKey]
    );
    return rows[0]?.baseline_value ?? null;
  } catch {
    return null;
  }
}

function wrap(result, extra = {}) {
  return {
    status: result.status,
    severity: result.severity || null,
    payload: { ...result, ...extra }
  };
}

const DATE_RANGE = { startDate: '7daysAgo', endDate: 'yesterday' };
const DATE_RANGE_30 = { startDate: '30daysAgo', endDate: 'yesterday' };

async function handleConnectionHealth(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  try {
    await c.client.runReport({
      property: `properties/${c.propertyId}`,
      dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
      metrics: [{ name: 'sessions' }],
      limit: 1
    });
    return { status: 'pass', severity: null, payload: { property_id: c.propertyId, detail: 'GA4 Data API reachable' } };
  } catch (err) {
    return { status: 'fail', severity: 'error', payload: { property_id: c.propertyId, error: err?.message || String(err) } };
  }
}

async function handleTrafficDrop(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagementRate' }, { name: 'keyEvents' }, { name: 'sessionKeyEventRate' }]
  });
  const agg = aggregateFirstRow(resp, ['sessions', 'totalUsers', 'engagementRate', 'keyEvents', 'sessionKeyEventRate']);
  const baseline = await getBaseline(ctx, 'sessions');
  return wrap(checkDrop({ current: agg.sessions, baseline, metricName: 'sessions' }), { property_id: c.propertyId });
}

async function handleChannelSessionsDrop(ctx, channelGroup, baselineKey) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE],
    dimensions: [{ name: 'sessionDefaultChannelGrouping' }],
    metrics: [{ name: 'sessions' }, { name: 'keyEvents' }]
  });
  const rows = parseRows(resp, ['sessions', 'keyEvents']);
  const row = rows.find((r) => r.dimensions.sessionDefaultChannelGrouping === channelGroup);
  const current = row?.metrics.sessions ?? 0;
  const baseline = await getBaseline(ctx, baselineKey);
  return wrap(checkDrop({ current, baseline, metricName: baselineKey }), { property_id: c.propertyId, channel: channelGroup });
}

async function handleKeyEventDrop(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagementRate' }, { name: 'keyEvents' }, { name: 'sessionKeyEventRate' }]
  });
  const agg = aggregateFirstRow(resp, ['sessions', 'totalUsers', 'engagementRate', 'keyEvents', 'sessionKeyEventRate']);
  const baseline = await getBaseline(ctx, 'key_events');
  return wrap(checkDrop({ current: agg.keyEvents, baseline, metricName: 'key_events' }), { property_id: c.propertyId });
}

async function handleKeyEventMissing(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  const expectedKeyEventNames = ctx.ga4ExpectedKeyEvents || null;
  if (!expectedKeyEventNames || expectedKeyEventNames.length === 0) {
    return { status: 'skipped', severity: null, payload: { reason: 'no expected key events configured (set ctx.ga4ExpectedKeyEvents)' } };
  }
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE_30],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: { fieldName: 'eventName', inListFilter: { values: expectedKeyEventNames } }
    }
  });
  const rows = parseRows(resp, ['eventCount']);
  const keyEventCounts = Object.fromEntries(
    rows.map((r) => [r.dimensions.eventName, r.metrics.eventCount])
  );
  return wrap(checkKeyEventMissing({ keyEventCounts, expectedKeyEventNames }), { property_id: c.propertyId });
}

async function handleLandingPageConversionDrop(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE],
    dimensions: [{ name: 'landingPage' }],
    metrics: [{ name: 'sessions' }, { name: 'sessionKeyEventRate' }],
    limit: 1
  });
  const rows = parseRows(resp, ['sessions', 'sessionKeyEventRate']);
  if (!rows.length) return { status: 'skipped', severity: null, payload: { reason: 'no landing page data returned' } };
  const topPage = rows[0];
  const current = topPage.metrics.sessionKeyEventRate;
  const baseline = await getBaseline(ctx, 'landing_page_conversion_rate');
  return wrap(
    checkDrop({ current, baseline, thresholdPct: 0.25, metricName: 'landing_page_conversion_rate' }),
    { property_id: c.propertyId, landing_page: topPage.dimensions.landingPage }
  );
}

async function handleAdsClicksVsSessionsGap(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE],
    dimensions: [{ name: 'sessionDefaultChannelGrouping' }],
    metrics: [{ name: 'sessions' }, { name: 'keyEvents' }]
  });
  const rows = parseRows(resp, ['sessions', 'keyEvents']);
  const paidRow = rows.find((r) => r.dimensions.sessionDefaultChannelGrouping === 'Paid Search');
  const ga4PaidSessions = paidRow?.metrics.sessions ?? 0;
  const adsClicks = ctx.adsClicks ?? null;
  return wrap(checkAdsClicksVsSessionsGap({ adsClicks, ga4PaidSessions }), { property_id: c.propertyId });
}

async function handleFormEventNotFiring(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  const formEventNames = ctx.ga4FormEventNames || ['generate_lead', 'form_submit'];
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: { fieldName: 'eventName', inListFilter: { values: formEventNames } }
    }
  });
  const rows = parseRows(resp, ['eventCount']);
  const eventCounts = Object.fromEntries(
    rows.map((r) => [r.dimensions.eventName, r.metrics.eventCount])
  );
  return wrap(checkFormEventNotFiring({ eventCounts, formEventNames }), { property_id: c.propertyId });
}

async function handleSourceMediumAnomaly(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE],
    dimensions: [{ name: 'sessionSourceMedium' }],
    metrics: [{ name: 'sessions' }],
    limit: 50
  });
  const rows = parseRows(resp, ['sessions']);
  const currentBySourceMedium = Object.fromEntries(
    rows.map((r) => [r.dimensions.sessionSourceMedium, r.metrics.sessions])
  );
  const baselineBySourceMedium = {};
  for (const sm of Object.keys(currentBySourceMedium)) {
    const val = await getBaseline(ctx, `source_medium:${sm}`);
    if (val != null) baselineBySourceMedium[sm] = val;
  }
  const result = checkSourceMediumAnomaly({ currentBySourceMedium, baselineBySourceMedium });
  return wrap(result, { property_id: c.propertyId });
}

export const GA4_CHECKS = [
  {
    id: 'ga4.connection_health',
    tier: 'daily_essential',
    requiredCapabilities: ['read'],
    handler: handleConnectionHealth
  },
  {
    id: 'ga4.traffic_drop',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: handleTrafficDrop
  },
  {
    id: 'ga4.paid_search_sessions_drop',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: (ctx) => handleChannelSessionsDrop(ctx, 'Paid Search', 'paid_search_sessions')
  },
  {
    id: 'ga4.organic_sessions_drop',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: (ctx) => handleChannelSessionsDrop(ctx, 'Organic Search', 'organic_sessions')
  },
  {
    id: 'ga4.key_event_drop',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: handleKeyEventDrop
  },
  {
    id: 'ga4.key_event_missing',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: handleKeyEventMissing
  },
  {
    id: 'ga4.landing_page_conversion_drop',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: handleLandingPageConversionDrop
  },
  {
    id: 'ga4.ads_clicks_vs_sessions_gap',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: handleAdsClicksVsSessionsGap
  },
  {
    id: 'ga4.form_event_not_firing',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: handleFormEventNotFiring
  },
  {
    id: 'ga4.source_medium_anomaly',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: handleSourceMediumAnomaly
  }
];
