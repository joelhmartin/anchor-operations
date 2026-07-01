/**
 * Correlator unit tests — Phase 6.
 *
 * Uses Node's built-in test runner (`node:test`). No DB I/O — exercises the
 * pure `evaluateRules` export from `correlator.js` against synthetic check
 * arrays. These tests are independent of Postgres and Mailgun.
 *
 * Run with:  yarn test:ops
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateRules, RULES } from '../correlatorEval.js';
import { sanitize } from '../payloadSanitizer.js';

function makeCheck({ id, check_id, status = 'pass', severity = null, payload_json = {}, umbrella = 'website' }) {
  return {
    id: id || `${check_id}-id`,
    run_id: 'run-1',
    check_id,
    status,
    severity,
    payload_json,
    umbrella,
    duration_ms: 10,
    cost_cents: 0,
    created_at: new Date().toISOString()
  };
}

test('tracking_loss_with_conversion_drop matches when both signals present', () => {
  const checks = [
    makeCheck({ id: 'c1', check_id: 'gads.conversion_tag.firing', status: 'fail', severity: 'critical', umbrella: 'google_ads' }),
    makeCheck({ id: 'c2', check_id: 'web.tracking_install', status: 'fail', payload_json: { gtm_present: false } })
  ];
  const findings = evaluateRules({ checks });
  const match = findings.find((f) => f.name === 'tracking_loss_with_conversion_drop');
  assert.ok(match, 'should match the tracking-loss correlation');
  assert.equal(match.severity, 'critical');
  assert.deepEqual(match.linkedCheckResultIds.sort(), ['c1', 'c2'].sort());
  assert.ok(match.summary.length > 10);
});

test('tracking_loss_with_conversion_drop does not match when GTM is present', () => {
  const checks = [
    makeCheck({ id: 'c1', check_id: 'gads.conversion_tag.firing', status: 'fail', severity: 'critical', umbrella: 'google_ads' }),
    makeCheck({ id: 'c2', check_id: 'web.tracking_install', status: 'pass', payload_json: { gtm_present: true } })
  ];
  const findings = evaluateRules({ checks });
  assert.equal(findings.find((f) => f.name === 'tracking_loss_with_conversion_drop'), undefined);
});

test('multiple rules concurrent: ssl + ranking-drop both fire from same checks', () => {
  const checks = [
    makeCheck({ id: 's1', check_id: 'web.ssl.expiry_within_30d', status: 'fail', severity: 'critical' }),
    makeCheck({ id: 's2', check_id: 'web.semrush.organic_traffic_drop', status: 'warn', severity: 'warning' }),
    makeCheck({ id: 'k1', check_id: 'gads.keywords.position_changes', status: 'warn', severity: 'warning', umbrella: 'google_ads' }),
    makeCheck({ id: 'g1', check_id: 'web.gsc.coverage_errors', status: 'warn', severity: 'warning' })
  ];
  const findings = evaluateRules({ checks });
  const names = findings.map((f) => f.name);
  assert.ok(names.includes('ssl_expiring_with_organic_decline'));
  assert.ok(names.includes('keyword_ranking_drop_with_indexation_errors'));
});

test('missing checks: rules return false safely (no throws, empty findings)', () => {
  const checks = []; // empty — every rule's findCheck() returns undefined
  const findings = evaluateRules({ checks });
  assert.deepEqual(findings, []);
});

test('partial signals: capi failure alone does not match meta_capi_down rule', () => {
  const checks = [
    makeCheck({ id: 'c1', check_id: 'meta.capi.health', status: 'fail', severity: 'critical', umbrella: 'meta' })
    // no web.tracking_install with meta_pixel_present
  ];
  const findings = evaluateRules({ checks });
  assert.equal(findings.find((f) => f.name === 'meta_capi_down_with_lead_form_active'), undefined);
});

test('domain_unverified_with_active_meta_spend matches when any meta check is non-skipped', () => {
  const checks = [
    makeCheck({ id: 'd1', check_id: 'meta.account.domain_verification', status: 'fail', severity: 'critical', umbrella: 'meta' }),
    makeCheck({ id: 'p1', check_id: 'meta.pixel.health', status: 'pass', umbrella: 'meta' })
  ];
  const findings = evaluateRules({ checks });
  const match = findings.find((f) => f.name === 'domain_unverified_with_active_meta_spend');
  assert.ok(match);
  assert.equal(match.linkedCheckResultIds[0], 'd1');
});

test('evidence shape: evidence is a serializable object with relevant payloads', () => {
  const checks = [
    makeCheck({ id: 'b1', check_id: 'gads.account.budget_pacing', status: 'warn', severity: 'warning', umbrella: 'google_ads', payload_json: { spend: 1234 } }),
    makeCheck({ id: 'd1', check_id: 'gads.account.disapproved_ads', status: 'warn', severity: 'warning', umbrella: 'google_ads', payload_json: { count: 3 } })
  ];
  const findings = evaluateRules({ checks });
  const match = findings.find((f) => f.name === 'budget_overrun_with_disapproved_ads');
  assert.ok(match);
  // JSON-serializable round-trip
  const round = JSON.parse(JSON.stringify(match.evidence));
  assert.deepEqual(round.budget_payload, { spend: 1234 });
  assert.deepEqual(round.disapproved_payload, { count: 3 });
});

test('rules array exports at least 10 rules and all have unique categories', () => {
  assert.ok(RULES.length >= 10, `expected >=10 rules, got ${RULES.length}`);
  const categories = RULES.map((r) => r.category);
  const unique = new Set(categories);
  assert.equal(categories.length, unique.size, 'rule categories must be unique');
  for (const r of RULES) {
    assert.ok(r.name && typeof r.name === 'string');
    assert.ok(r.category && r.category.startsWith('correlation.'));
    // severity may be a static string OR a function of the matched checks
    // (V5 snapshot anomaly mirrors the check's own severity).
    assert.ok(
      typeof r.severity === 'function' || ['critical', 'warning', 'info'].includes(r.severity),
      `rule ${r.name} severity must be a valid string or a function`
    );
    assert.equal(typeof r.when, 'function');
    assert.equal(typeof r.summary, 'function');
    assert.equal(typeof r.evidence, 'function');
    assert.equal(typeof r.linkedCheckResultIds, 'function');
  }
});

test('payload sanitizer redacts emails + SSNs unconditionally', () => {
  const out = sanitize({
    note: 'Contact patient@example.com or 123-45-6789 for follow-up',
    metric_count: 42
  });
  assert.ok(!out.note.includes('patient@example.com'));
  assert.ok(!out.note.includes('123-45-6789'));
  assert.equal(out.metric_count, 42);
});

test('payload sanitizer redacts phones only on user-ish keys', () => {
  const out = sanitize({
    caller_phone: '+1 (555) 123-4567',
    version_string: '11.20.300.4000', // looks phone-y but key is non-userish
    nested: { user_phone: '555-123-4567' }
  });
  assert.ok(!out.caller_phone.includes('555'));
  assert.equal(out.version_string, '11.20.300.4000');
  assert.ok(!out.nested.user_phone.includes('555'));
});

test('payload sanitizer redacts DOB only on date-of-birth keys', () => {
  const out = sanitize({
    dob: '1990-04-15',
    created_at: '2026-05-05'
  });
  assert.ok(!out.dob.includes('1990'));
  assert.equal(out.created_at, '2026-05-05');
});

// ── single-signal website finding rules ──────────────────────────────────────

test('site_unreachable fires when uptime check fails', () => {
  const checks = [
    makeCheck({ id: 'u1', check_id: 'web.uptime.reachable', status: 'fail', severity: 'critical', payload_json: { http_status: 503, reachable: false } })
  ];
  const findings = evaluateRules({ checks });
  const match = findings.find((f) => f.name === 'site_unreachable');
  assert.ok(match, 'should produce a site_unreachable finding');
  assert.equal(match.category, 'correlation.site_unreachable');
  assert.equal(match.severity, 'critical');
  assert.deepEqual(match.linkedCheckResultIds, ['u1']);
  assert.ok(match.summary.includes('503'), 'summary should include the HTTP status code');
  assert.ok(match.summary.includes('unreachable'), 'summary should mention unreachable');
});

test('site_unreachable does not fire when uptime check passes', () => {
  const checks = [
    makeCheck({ id: 'u1', check_id: 'web.uptime.reachable', status: 'pass' })
  ];
  const findings = evaluateRules({ checks });
  assert.equal(findings.find((f) => f.name === 'site_unreachable'), undefined);
});

test('ssl_expiring_critical fires when 7d check fails', () => {
  const checks = [
    makeCheck({ id: 's7', check_id: 'web.ssl.expiry_within_7d', status: 'fail', severity: 'critical', payload_json: { days_to_expiry: 3, threshold_days: 7 } })
  ];
  const findings = evaluateRules({ checks });
  const match = findings.find((f) => f.name === 'ssl_expiring_critical');
  assert.ok(match, 'should produce ssl_expiring_critical finding');
  assert.equal(match.category, 'correlation.ssl_expiring_critical');
  assert.equal(match.severity, 'critical');
  assert.deepEqual(match.linkedCheckResultIds, ['s7']);
  assert.ok(match.summary.includes('3'), 'summary should include the days count');
});

test('ssl_expiring_critical does not fire when 7d check passes', () => {
  const checks = [
    makeCheck({ id: 's7', check_id: 'web.ssl.expiry_within_7d', status: 'pass' })
  ];
  const findings = evaluateRules({ checks });
  assert.equal(findings.find((f) => f.name === 'ssl_expiring_critical'), undefined);
});

test('ssl_expiring_soon fires when 30d fails but 7d passes', () => {
  const checks = [
    makeCheck({ id: 's30', check_id: 'web.ssl.expiry_within_30d', status: 'fail', severity: 'warning', payload_json: { days_to_expiry: 20, threshold_days: 30 } }),
    makeCheck({ id: 's7', check_id: 'web.ssl.expiry_within_7d', status: 'pass' })
  ];
  const findings = evaluateRules({ checks });
  const match = findings.find((f) => f.name === 'ssl_expiring_soon');
  assert.ok(match, 'should produce ssl_expiring_soon finding');
  assert.equal(match.category, 'correlation.ssl_expiring_soon');
  assert.equal(match.severity, 'warning');
  assert.deepEqual(match.linkedCheckResultIds, ['s30']);
  assert.ok(match.summary.includes('20'), 'summary should include the days count');
});

test('ssl_expiring_soon does not fire when 30d passes', () => {
  const checks = [
    makeCheck({ id: 's30', check_id: 'web.ssl.expiry_within_30d', status: 'pass' }),
    makeCheck({ id: 's7', check_id: 'web.ssl.expiry_within_7d', status: 'pass' })
  ];
  const findings = evaluateRules({ checks });
  assert.equal(findings.find((f) => f.name === 'ssl_expiring_soon'), undefined);
});

test('ssl_expiring_soon does NOT fire when 7d check also fails (no double-report); ssl_expiring_critical does fire', () => {
  const checks = [
    makeCheck({ id: 's30', check_id: 'web.ssl.expiry_within_30d', status: 'fail', severity: 'critical', payload_json: { days_to_expiry: 3, threshold_days: 30 } }),
    makeCheck({ id: 's7', check_id: 'web.ssl.expiry_within_7d', status: 'fail', severity: 'critical', payload_json: { days_to_expiry: 3, threshold_days: 7 } })
  ];
  const findings = evaluateRules({ checks });
  assert.equal(findings.find((f) => f.name === 'ssl_expiring_soon'), undefined, 'ssl_expiring_soon must not fire when 7d also fails');
  const critMatch = findings.find((f) => f.name === 'ssl_expiring_critical');
  assert.ok(critMatch, 'ssl_expiring_critical must fire when 7d fails');
  assert.equal(critMatch.severity, 'critical');
});

test('tracking_install_missing fires when tracking check fails', () => {
  const checks = [
    makeCheck({ id: 't1', check_id: 'web.tracking_install', status: 'fail', payload_json: { gtm_present: false, ga4_present: false, meta_pixel_present: true, issues: ['GTM missing', 'GA4 missing'] } })
  ];
  const findings = evaluateRules({ checks });
  const match = findings.find((f) => f.name === 'tracking_install_missing');
  assert.ok(match, 'should produce tracking_install_missing finding');
  assert.equal(match.category, 'correlation.tracking_install_missing');
  assert.equal(match.severity, 'warning');
  assert.deepEqual(match.linkedCheckResultIds, ['t1']);
  assert.ok(match.summary.includes('GTM'), 'summary should list GTM as missing');
  assert.ok(match.summary.includes('GA4'), 'summary should list GA4 as missing');
  assert.ok(!match.summary.includes('Meta Pixel'), 'summary should not list Meta Pixel (it is present)');
});

test('tracking_install_missing does not fire when tracking check passes', () => {
  const checks = [
    makeCheck({ id: 't1', check_id: 'web.tracking_install', status: 'pass', payload_json: { gtm_present: true, ga4_present: true, meta_pixel_present: true } })
  ];
  const findings = evaluateRules({ checks });
  assert.equal(findings.find((f) => f.name === 'tracking_install_missing'), undefined);
});
