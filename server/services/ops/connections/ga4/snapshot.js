import { buildGa4Client } from './client.js';
import { parseRows, aggregateFirstRow } from './_reportParser.js';

export async function collectSnapshot(ctx = {}) {
  const {
    env = process.env,
    propertyId,
    ga4Client: injectedClient = null,
    dateRange = { startDate: '7daysAgo', endDate: 'yesterday' }
  } = ctx;

  if (!propertyId) throw new Error('GA4 collectSnapshot: propertyId is required');

  const client = buildGa4Client({ env, ga4Client: injectedClient });
  const property = `properties/${propertyId}`;
  const periodKey = `${dateRange.startDate}:${dateRange.endDate}`;
  const rows = [];

  // Report 1: overall metrics (no dimensions)
  const [overallResp] = await client.runReport({
    property,
    dateRanges: [dateRange],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'engagementRate' },
      { name: 'keyEvents' },
      { name: 'sessionKeyEventRate' }
    ]
  });

  const overall = aggregateFirstRow(overallResp, ['sessions', 'totalUsers', 'engagementRate', 'keyEvents', 'sessionKeyEventRate']);
  const NORMALIZED = [
    ['sessions',        'sessions'],
    ['users',           'totalUsers'],
    ['engagement_rate', 'engagementRate'],
    ['key_events',      'keyEvents'],
    ['conversion_rate', 'sessionKeyEventRate']
  ];
  for (const [metricName, rawKey] of NORMALIZED) {
    rows.push({ metric_name: metricName, metric_value: overall[rawKey] ?? 0, dimensions: {}, metadata: { period: periodKey } });
  }

  // Report 2: sessions + key_events by channel
  const [channelResp] = await client.runReport({
    property,
    dateRanges: [dateRange],
    dimensions: [{ name: 'sessionDefaultChannelGrouping' }],
    metrics: [{ name: 'sessions' }, { name: 'keyEvents' }]
  });
  for (const r of parseRows(channelResp, ['sessions', 'keyEvents'])) {
    const channel = r.dimensions.sessionDefaultChannelGrouping;
    rows.push({ metric_name: 'sessions',   metric_value: r.metrics.sessions,  dimensions: { channel }, metadata: { period: periodKey } });
    rows.push({ metric_name: 'key_events', metric_value: r.metrics.keyEvents, dimensions: { channel }, metadata: { period: periodKey } });
  }

  // Report 3: sessions by source/medium (top 50)
  const [smResp] = await client.runReport({
    property,
    dateRanges: [dateRange],
    dimensions: [{ name: 'sessionSourceMedium' }],
    metrics: [{ name: 'sessions' }],
    limit: 50
  });
  for (const r of parseRows(smResp, ['sessions'])) {
    rows.push({
      metric_name: 'sessions',
      metric_value: r.metrics.sessions,
      dimensions: { source_medium: r.dimensions.sessionSourceMedium },
      metadata: { period: periodKey }
    });
  }

  // Report 4: sessions + conversion_rate by landing page (top 20)
  const [lpResp] = await client.runReport({
    property,
    dateRanges: [dateRange],
    dimensions: [{ name: 'landingPage' }],
    metrics: [{ name: 'sessions' }, { name: 'sessionKeyEventRate' }],
    limit: 20
  });
  for (const r of parseRows(lpResp, ['sessions', 'sessionKeyEventRate'])) {
    const landing_page = r.dimensions.landingPage;
    rows.push({ metric_name: 'sessions',        metric_value: r.metrics.sessions,            dimensions: { landing_page }, metadata: { period: periodKey } });
    rows.push({ metric_name: 'conversion_rate', metric_value: r.metrics.sessionKeyEventRate, dimensions: { landing_page }, metadata: { period: periodKey } });
  }

  // Report 5: event_count by event name (form submits, phone clicks, CTAs)
  const [eventResp] = await client.runReport({
    property,
    dateRanges: [dateRange],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        inListFilter: { values: ['generate_lead', 'form_submit', 'click', 'phone_call_click', 'contact'] }
      }
    }
  });
  for (const r of parseRows(eventResp, ['eventCount'])) {
    rows.push({
      metric_name: 'event_count',
      metric_value: r.metrics.eventCount,
      dimensions: { event_name: r.dimensions.eventName },
      metadata: { period: periodKey }
    });
  }

  return rows;
}
