import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDrop,
  checkKeyEventMissing,
  checkFormEventNotFiring,
  checkAdsClicksVsSessionsGap,
  checkSourceMediumAnomaly
} from '../connections/ga4/checks/_logic.js';

// --- checkDrop ---

test('checkDrop: skipped when baseline is null', () => {
  const r = checkDrop({ current: 800, baseline: null, metricName: 'sessions' });
  assert.equal(r.status, 'skipped');
  assert.ok(/baseline/.test(r.reason));
});

test('checkDrop: skipped when baseline is 0', () => {
  assert.equal(checkDrop({ current: 0, baseline: 0 }).status, 'skipped');
});

test('checkDrop: fail when drop >= 20%', () => {
  const r = checkDrop({ current: 750, baseline: 1000, thresholdPct: 0.2, metricName: 'sessions' });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.equal(r.drop_pct, 25);
  assert.equal(r.current, 750);
  assert.equal(r.baseline, 1000);
});

test('checkDrop: pass when drop < 20%', () => {
  const r = checkDrop({ current: 900, baseline: 1000, thresholdPct: 0.2 });
  assert.equal(r.status, 'pass');
  assert.equal(r.drop_pct, 10);
});

test('checkDrop: pass when traffic increased', () => {
  const r = checkDrop({ current: 1200, baseline: 1000, thresholdPct: 0.2 });
  assert.equal(r.status, 'pass');
  assert.ok(r.drop_pct < 0, 'negative drop means growth');
});

// --- checkKeyEventMissing ---

test('checkKeyEventMissing: pass when all expected events have counts', () => {
  const r = checkKeyEventMissing({
    keyEventCounts: { generate_lead: 5, purchase: 2 },
    expectedKeyEventNames: ['generate_lead', 'purchase']
  });
  assert.equal(r.status, 'pass');
});

test('checkKeyEventMissing: fail when a key event has 0 count', () => {
  const r = checkKeyEventMissing({
    keyEventCounts: { generate_lead: 0, purchase: 3 },
    expectedKeyEventNames: ['generate_lead', 'purchase']
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'error');
  assert.deepEqual(r.missing_key_events, ['generate_lead']);
});

test('checkKeyEventMissing: treats absent key as 0', () => {
  const r = checkKeyEventMissing({
    keyEventCounts: {},
    expectedKeyEventNames: ['generate_lead']
  });
  assert.equal(r.status, 'fail');
  assert.deepEqual(r.missing_key_events, ['generate_lead']);
});

// --- checkFormEventNotFiring ---

test('checkFormEventNotFiring: pass when at least one form event fires', () => {
  const r = checkFormEventNotFiring({ eventCounts: { generate_lead: 3, form_submit: 0 } });
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.firing, ['generate_lead']);
  assert.deepEqual(r.not_firing, ['form_submit']);
});

test('checkFormEventNotFiring: fail when all form events are zero', () => {
  const r = checkFormEventNotFiring({ eventCounts: { generate_lead: 0, form_submit: 0 } });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.deepEqual(r.not_firing, ['generate_lead', 'form_submit']);
});

test('checkFormEventNotFiring: custom formEventNames accepted', () => {
  const r = checkFormEventNotFiring({
    eventCounts: { contact_form: 5 },
    formEventNames: ['contact_form', 'newsletter_signup']
  });
  assert.equal(r.status, 'pass');
});

// --- checkAdsClicksVsSessionsGap ---

test('checkAdsClicksVsSessionsGap: skipped when adsClicks is null', () => {
  const r = checkAdsClicksVsSessionsGap({ adsClicks: null, ga4PaidSessions: 100 });
  assert.equal(r.status, 'skipped');
  assert.ok(/adsClicks/.test(r.reason));
});

test('checkAdsClicksVsSessionsGap: skipped when adsClicks is 0', () => {
  assert.equal(checkAdsClicksVsSessionsGap({ adsClicks: 0, ga4PaidSessions: 0 }).status, 'skipped');
});

test('checkAdsClicksVsSessionsGap: fail when gap >= 30%', () => {
  const r = checkAdsClicksVsSessionsGap({ adsClicks: 1000, ga4PaidSessions: 600, thresholdPct: 0.3 });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.equal(r.gap_pct, 40);
});

test('checkAdsClicksVsSessionsGap: pass when gap < 30%', () => {
  const r = checkAdsClicksVsSessionsGap({ adsClicks: 1000, ga4PaidSessions: 800 });
  assert.equal(r.status, 'pass');
  assert.equal(r.gap_pct, 20);
});

// --- checkSourceMediumAnomaly ---

test('checkSourceMediumAnomaly: skipped when baseline is empty', () => {
  const r = checkSourceMediumAnomaly({ currentBySourceMedium: {}, baselineBySourceMedium: {} });
  assert.equal(r.status, 'skipped');
});

test('checkSourceMediumAnomaly: pass when changes are within threshold', () => {
  const r = checkSourceMediumAnomaly({
    currentBySourceMedium: { 'google / organic': 900 },
    baselineBySourceMedium: { 'google / organic': 1000 },
    thresholdPct: 0.3
  });
  assert.equal(r.status, 'pass');
  assert.equal(r.sources_checked, 1);
});

test('checkSourceMediumAnomaly: fail when a source/medium changes > 30%', () => {
  const r = checkSourceMediumAnomaly({
    currentBySourceMedium: { 'google / cpc': 200, 'google / organic': 950 },
    baselineBySourceMedium: { 'google / cpc': 1000, 'google / organic': 1000 },
    thresholdPct: 0.3
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.equal(r.anomalies.length, 1);
  assert.equal(r.anomalies[0].source_medium, 'google / cpc');
  assert.equal(r.anomalies[0].change_pct, -80);
});

test('checkSourceMediumAnomaly: spike (increase) also flags as anomaly', () => {
  const r = checkSourceMediumAnomaly({
    currentBySourceMedium: { 'direct / none': 5000 },
    baselineBySourceMedium: { 'direct / none': 100 },
    thresholdPct: 0.3
  });
  assert.equal(r.status, 'fail');
  assert.ok(r.anomalies[0].change_pct > 0);
});
