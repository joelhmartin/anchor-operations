function roundPct(fraction) {
  return Math.round(fraction * 10000) / 100;
}

export function checkDrop({ current, baseline, thresholdPct = 0.2, metricName = 'metric' }) {
  if (baseline == null) {
    return { status: 'skipped', reason: `no baseline for ${metricName}` };
  }
  if (baseline === 0) {
    return { status: 'skipped', reason: `baseline is zero for ${metricName}` };
  }
  const dropFraction = (baseline - current) / baseline;
  const drop_pct = roundPct(dropFraction);
  if (dropFraction >= thresholdPct) {
    return { status: 'fail', severity: 'warning', metric: metricName, current, baseline, drop_pct };
  }
  return { status: 'pass', metric: metricName, current, baseline, drop_pct };
}

export function checkKeyEventMissing({ keyEventCounts, expectedKeyEventNames }) {
  const missing = expectedKeyEventNames.filter((e) => (keyEventCounts[e] ?? 0) === 0);
  if (missing.length) {
    return { status: 'fail', severity: 'error', missing_key_events: missing };
  }
  return { status: 'pass', checked_key_events: expectedKeyEventNames };
}

export function checkFormEventNotFiring({
  eventCounts,
  formEventNames = ['generate_lead', 'form_submit']
}) {
  const firing     = formEventNames.filter((e) => (eventCounts[e] ?? 0) > 0);
  const not_firing = formEventNames.filter((e) => (eventCounts[e] ?? 0) === 0);
  if (firing.length === 0) {
    return { status: 'fail', severity: 'warning', expected: formEventNames, not_firing };
  }
  return { status: 'pass', firing, not_firing };
}

export function checkAdsClicksVsSessionsGap({ adsClicks, ga4PaidSessions, thresholdPct = 0.3 }) {
  if (adsClicks == null) {
    return {
      status: 'skipped',
      reason: 'adsClicks not provided — populate ctx.adsClicks from the Google Ads connector or correlator'
    };
  }
  if (adsClicks === 0) {
    return { status: 'skipped', reason: 'zero ad clicks in period' };
  }
  const gapFraction = (adsClicks - ga4PaidSessions) / adsClicks;
  const gap_pct = roundPct(gapFraction);
  if (gapFraction >= thresholdPct) {
    return { status: 'fail', severity: 'warning', ads_clicks: adsClicks, ga4_paid_sessions: ga4PaidSessions, gap_pct };
  }
  return { status: 'pass', ads_clicks: adsClicks, ga4_paid_sessions: ga4PaidSessions, gap_pct };
}

export function checkSourceMediumAnomaly({
  currentBySourceMedium,
  baselineBySourceMedium,
  thresholdPct = 0.3
}) {
  if (!baselineBySourceMedium || Object.keys(baselineBySourceMedium).length === 0) {
    return { status: 'skipped', reason: 'no source/medium baseline' };
  }
  const anomalies = [];
  for (const [sm, baselineVal] of Object.entries(baselineBySourceMedium)) {
    if (baselineVal === 0) continue;
    const current = currentBySourceMedium[sm] ?? 0;
    const changeFraction = (current - baselineVal) / baselineVal;
    if (Math.abs(changeFraction) >= thresholdPct) {
      anomalies.push({
        source_medium: sm,
        change_pct: roundPct(changeFraction),
        current,
        baseline: baselineVal
      });
    }
  }
  if (anomalies.length) {
    return { status: 'fail', severity: 'warning', anomalies };
  }
  return { status: 'pass', sources_checked: Object.keys(baselineBySourceMedium).length };
}
