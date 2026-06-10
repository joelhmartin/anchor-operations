/**
 * web.psi — PageSpeed Insights / Core Web Vitals check.
 *
 * Implementation choice (documented in phase-3-completion.md): registered as
 * a single composite check `web.psi` whose payload contains both mobile and
 * desktop strategies plus all per-metric details (LCP, CLS, INP, accessibility,
 * best practices, SEO). Reasoning:
 *   - The Phase 1 executor returns one `ops_check_result` per handler call.
 *     Splitting into 12+ separate registry entries would either need executor
 *     changes (out of scope for Phase 3) or duplicate PSI quota burn (one PSI
 *     call per metric).
 *   - The correlator (Phase 6) reads `payload_json.metrics` directly and can
 *     synthesize per-metric findings from the composite result.
 *
 * Two PSI calls per check_run (mobile + desktop). Quota-tracked via
 * services/ops/feeds/psiQuota.js. If `PSI_API_KEY` is unset → status='skipped'.
 */

import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';
import { resolveClientWebsiteUrl, safeHttpFetch } from './_lib/httpFetch.js';
import { reservePsiSlot, snapshotPsiQuota } from '../../feeds/psiQuota.js';

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

// Metric thresholds (Core Web Vitals "good" cutoffs).
const THRESHOLDS = {
  lcp_ms: { good: 2500, poor: 4000 },
  cls: { good: 0.1, poor: 0.25 },
  inp_ms: { good: 200, poor: 500 }
};

function severityForLcp(ms) {
  if (ms == null) return null;
  if (ms > THRESHOLDS.lcp_ms.poor) return 'critical';
  if (ms > THRESHOLDS.lcp_ms.good) return 'warning';
  return null;
}

function severityForCls(v) {
  if (v == null) return null;
  if (v > THRESHOLDS.cls.poor) return 'critical';
  if (v > THRESHOLDS.cls.good) return 'warning';
  return null;
}

function severityForInp(ms) {
  if (ms == null) return null;
  if (ms > THRESHOLDS.inp_ms.poor) return 'critical';
  if (ms > THRESHOLDS.inp_ms.good) return 'warning';
  return null;
}

function severityForScore(score) {
  if (score == null) return null;
  if (score < 0.5) return 'critical';
  if (score < 0.9) return 'warning';
  return null;
}

function extractMetrics(psiResponse) {
  const lh = psiResponse?.lighthouseResult || {};
  const audits = lh.audits || {};
  const categories = lh.categories || {};
  const lcpAudit = audits['largest-contentful-paint'];
  const clsAudit = audits['cumulative-layout-shift'];
  const inpAudit = audits['interaction-to-next-paint'] || audits['experimental-interaction-to-next-paint'];

  return {
    lcp_ms: lcpAudit?.numericValue ?? null,
    cls: clsAudit?.numericValue ?? null,
    inp_ms: inpAudit?.numericValue ?? null,
    accessibility_score: categories.accessibility?.score ?? null,
    best_practices_score: categories['best-practices']?.score ?? null,
    seo_score: categories.seo?.score ?? null,
    performance_score: categories.performance?.score ?? null
  };
}

async function runPsi(websiteUrl, strategy, apiKey) {
  const url = new URL(PSI_ENDPOINT);
  url.searchParams.set('url', websiteUrl);
  url.searchParams.set('strategy', strategy);
  url.searchParams.set('category', 'PERFORMANCE');
  url.searchParams.append('category', 'ACCESSIBILITY');
  url.searchParams.append('category', 'BEST_PRACTICES');
  url.searchParams.append('category', 'SEO');
  if (apiKey) url.searchParams.set('key', apiKey);

  const slot = reservePsiSlot();
  if (!slot.ok) {
    return { skipped: true, reason: slot.reason, quota: slot };
  }

  const res = await safeHttpFetch(url.toString(), {
    timeoutMs: 60_000,
    maxBytes: 2_000_000
  });
  if (res.status >= 400) {
    return {
      error: `PSI ${strategy} returned ${res.status}`,
      raw: (res.body || '').slice(0, 500)
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (err) {
    return { error: `PSI ${strategy} JSON parse failed: ${err.message}` };
  }
  return { metrics: extractMetrics(parsed) };
}

function worstSeverity(...severities) {
  if (severities.includes('critical')) return 'critical';
  if (severities.includes('warning')) return 'warning';
  return null;
}

registerCheck('web.psi', {
  umbrella: 'website',
  tier: 'weekly_deep',
  // Rough cost: PSI itself is free, but we account for token-equivalent budget
  // since the check makes 2 outbound calls and a non-trivial CPU spend.
  costEstimate: 1,
  requires: [],
  handler: async (ctx, costTracker) => {
    const apiKey = process.env.PSI_API_KEY;
    if (!apiKey) {
      return { status: 'skipped', payload: { reason: 'PSI_API_KEY not configured' } };
    }
    const websiteUrl = await resolveClientWebsiteUrl(query, ctx.clientUserId);
    if (!websiteUrl) {
      return { status: 'skipped', payload: { reason: 'no website URL configured for client' } };
    }

    const [mobile, desktop] = await Promise.all([
      runPsi(websiteUrl, 'mobile', apiKey).catch((err) => ({ error: err.message })),
      runPsi(websiteUrl, 'desktop', apiKey).catch((err) => ({ error: err.message }))
    ]);

    if (costTracker?.add) {
      costTracker.add({ dollars: 0, source: 'psi.api' });
    }

    const strategies = { mobile, desktop };
    const issues = [];
    const sev = [];
    for (const [strategy, result] of Object.entries(strategies)) {
      if (result.skipped) {
        issues.push({ strategy, kind: 'skipped', reason: result.reason });
        continue;
      }
      if (result.error) {
        issues.push({ strategy, kind: 'error', error: result.error });
        sev.push('warning');
        continue;
      }
      const m = result.metrics || {};
      const perStrategy = [
        { metric: 'lcp_ms', value: m.lcp_ms, severity: severityForLcp(m.lcp_ms) },
        { metric: 'cls', value: m.cls, severity: severityForCls(m.cls) },
        { metric: 'inp_ms', value: m.inp_ms, severity: severityForInp(m.inp_ms) },
        { metric: 'accessibility_score', value: m.accessibility_score, severity: severityForScore(m.accessibility_score) },
        { metric: 'best_practices_score', value: m.best_practices_score, severity: severityForScore(m.best_practices_score) },
        { metric: 'seo_score', value: m.seo_score, severity: severityForScore(m.seo_score) }
      ];
      for (const r of perStrategy) {
        if (r.severity) {
          issues.push({ strategy, ...r });
          sev.push(r.severity);
        }
      }
    }

    const overallSeverity = worstSeverity(...sev);
    const allSkipped = strategies.mobile.skipped && strategies.desktop.skipped;

    return {
      status: allSkipped ? 'skipped' : overallSeverity ? 'fail' : 'pass',
      severity: overallSeverity,
      payload: {
        website_url: websiteUrl,
        strategies: {
          mobile: strategies.mobile.metrics || strategies.mobile,
          desktop: strategies.desktop.metrics || strategies.desktop
        },
        thresholds: THRESHOLDS,
        issues,
        quota: snapshotPsiQuota()
      }
    };
  }
});
