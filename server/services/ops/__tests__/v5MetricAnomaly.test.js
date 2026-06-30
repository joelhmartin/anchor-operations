import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAnomaliesForClient } from '../checks/snapshots/metricAnomaly.js';
import { evaluateRules } from '../correlator.js';

const CLIENT = '22222222-2222-2222-2222-222222222222';

// A stddev-backed baseline: mean 100, stddev 10. An observed value far from the
// mean should score critical (|z| >= 3).
function baselineRows({ baseline_value = 100, stddev = 10, sample_count = 28 } = {}) {
  return [
    { period: '30_day', baseline_value, stddev, sample_count }
  ];
}

test('evaluateAnomaliesForClient flags a critical deviation (z >= 3)', async () => {
  const result = await evaluateAnomaliesForClient({
    clientUserId: CLIENT,
    asOf: '2026-06-30',
    listLatestScopeSnapshots: async () => [{
      service: 'search_console', scope_type: 'site', scope_id: 's1',
      snapshot_date: '2026-06-30',
      metrics_json: { clicks: 40 } // 6 stddevs below mean 100
    }],
    getBaselines: async () => baselineRows()
  });
  assert.equal(result.evaluated, 1);
  assert.ok(result.worst, 'has a worst anomaly');
  assert.equal(result.worst.severity, 'critical');
  assert.equal(result.worst.metric, 'clicks');
  assert.equal(result.worst.direction, 'down');
  assert.ok(Math.abs(result.worst.z_score) >= 3);
});

test('evaluateAnomaliesForClient returns no anomaly when observed is near baseline', async () => {
  const result = await evaluateAnomaliesForClient({
    clientUserId: CLIENT,
    asOf: '2026-06-30',
    listLatestScopeSnapshots: async () => [{
      service: 'search_console', scope_type: 'site', scope_id: 's1',
      snapshot_date: '2026-06-30',
      metrics_json: { clicks: 102 } // 0.2 stddev — within normal
    }],
    getBaselines: async () => baselineRows()
  });
  assert.equal(result.worst, null);
});

test('evaluateAnomaliesForClient skips metrics with no baseline', async () => {
  const result = await evaluateAnomaliesForClient({
    clientUserId: CLIENT,
    asOf: '2026-06-30',
    listLatestScopeSnapshots: async () => [{
      service: 'search_console', scope_type: 'site', scope_id: 's1',
      snapshot_date: '2026-06-30',
      metrics_json: { clicks: 5, impressions: 9 }
    }],
    getBaselines: async ({ metric }) => (metric === 'clicks' ? baselineRows() : [])
  });
  assert.equal(result.evaluated, 1); // only clicks had a baseline
  assert.equal(result.worst.metric, 'clicks');
});

test('correlator turns a failed snapshot.metric_anomaly check into a finding with mirrored severity', () => {
  const checks = [{
    id: 'cr-1',
    check_id: 'snapshot.metric_anomaly',
    status: 'fail',
    severity: 'critical',
    payload_json: {
      worst: {
        service: 'search_console', metric: 'clicks', period: '30_day',
        direction: 'down', observed: 40, baseline_value: 100,
        z_score: -6, pct_change: -0.6
      }
    }
  }];
  const findings = evaluateRules({ checks });
  const f = findings.find((x) => x.name === 'snapshot_metric_anomaly');
  assert.ok(f, 'snapshot anomaly finding produced');
  assert.equal(f.severity, 'critical');
  assert.equal(f.category, 'correlation.snapshot_metric_anomaly');
  assert.match(f.summary, /clicks/);
  assert.deepEqual(f.linkedCheckResultIds, ['cr-1']);
});

test('correlator mirrors warning severity for a warning-level anomaly check', () => {
  const checks = [{
    id: 'cr-2',
    check_id: 'snapshot.metric_anomaly',
    status: 'fail',
    severity: 'warning',
    payload_json: { worst: { service: 'ga4', metric: 'sessions', period: '7_day', direction: 'down', observed: 70, baseline_value: 100, z_score: -2.1, pct_change: -0.3 } }
  }];
  const findings = evaluateRules({ checks });
  const f = findings.find((x) => x.name === 'snapshot_metric_anomaly');
  assert.equal(f.severity, 'warning');
});

test('correlator does not fire the anomaly rule when the check passed', () => {
  const checks = [{ id: 'cr-3', check_id: 'snapshot.metric_anomaly', status: 'pass', severity: null, payload_json: {} }];
  const findings = evaluateRules({ checks });
  assert.equal(findings.find((x) => x.name === 'snapshot_metric_anomaly'), undefined);
});
