/**
 * web.semrush.* — SEMrush API checks (organic traffic, keyword positions,
 * toxic backlinks).
 *
 * Three registered checks:
 *   web.semrush.organic_traffic_drop  — > 20% WoW drop is a warning
 *   web.semrush.top_keywords_lost     — > 5 position drop on top-10 keywords
 *   web.semrush.toxic_backlinks       — count of toxic backlinks
 *
 * Auth: agency-level API key in `SEMRUSH_API_KEY`. If unset → skipped.
 *
 * Implementation note: SEMrush's reporting endpoints are CSV-based. We hit
 * `domain_organic` and `backlinks_overview` — for v1 we only return the
 * top-line numbers; richer keyword-level diff is deferred to Phase 6.
 */

import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';
import { resolveClientWebsiteUrl, safeHttpFetch } from './_lib/httpFetch.js';

const SEMRUSH_BASE = 'https://api.semrush.com/';

function parseSemrushCsv(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(';');
  return lines.slice(1).map((line) => {
    const cells = line.split(';');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cells[i];
    });
    return row;
  });
}

function domainFromUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function getSemrushContext(ctx) {
  if (!ctx._semrushCtx) {
    ctx._semrushCtx = (async () => {
      const apiKey = process.env.SEMRUSH_API_KEY;
      if (!apiKey) return { kind: 'skipped', reason: 'SEMRUSH_API_KEY not configured' };
      const websiteUrl = await resolveClientWebsiteUrl(query, ctx.clientUserId);
      if (!websiteUrl) return { kind: 'skipped', reason: 'no website URL configured for client' };
      const domain = domainFromUrl(websiteUrl);
      if (!domain) return { kind: 'skipped', reason: `invalid website URL: ${websiteUrl}` };
      return { kind: 'ok', apiKey, domain, websiteUrl };
    })();
  }
  return ctx._semrushCtx;
}

async function callSemrush(params, apiKey) {
  const url = new URL(SEMRUSH_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', apiKey);
  const res = await safeHttpFetch(url.toString(), { timeoutMs: 30_000, maxBytes: 1_500_000 });
  if (res.status >= 400) {
    return { error: `SEMrush ${res.status}`, raw: (res.body || '').slice(0, 500) };
  }
  return { rows: parseSemrushCsv(res.body) };
}

registerCheck('web.semrush.organic_traffic_drop', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: async (ctx) => {
    const c = await getSemrushContext(ctx);
    if (c.kind !== 'ok') return { status: 'skipped', payload: { reason: c.reason } };
    const result = await callSemrush(
      {
        type: 'domain_organic',
        domain: c.domain,
        database: 'us',
        display_limit: '1',
        export_columns: 'Dn,Or,Ot,Oc'
      },
      c.apiKey
    ).catch((err) => ({ error: err.message }));
    if (result.error) {
      return {
        status: 'error',
        severity: 'warning',
        payload: { error: result.error, domain: c.domain }
      };
    }
    const top = result.rows?.[0] || {};
    const traffic = Number(top.Ot || 0);
    // True WoW comparison requires history snapshots — deferred. v1 just
    // surfaces the current values so the correlator can persist + diff later.
    return {
      status: 'pass',
      severity: null,
      payload: {
        domain: c.domain,
        organic_traffic: traffic,
        organic_keywords: Number(top.Or || 0),
        organic_cost: Number(top.Oc || 0),
        note: 'WoW drop comparison requires history baseline; current snapshot recorded'
      }
    };
  }
});

registerCheck('web.semrush.top_keywords_lost', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: async (ctx) => {
    const c = await getSemrushContext(ctx);
    if (c.kind !== 'ok') return { status: 'skipped', payload: { reason: c.reason } };
    const result = await callSemrush(
      {
        type: 'domain_organic',
        domain: c.domain,
        database: 'us',
        display_limit: '50',
        export_columns: 'Ph,Po,Pp,Nq'
      },
      c.apiKey
    ).catch((err) => ({ error: err.message }));
    if (result.error) {
      return {
        status: 'error',
        severity: 'warning',
        payload: { error: result.error, domain: c.domain }
      };
    }
    const losses = (result.rows || [])
      .filter((r) => Number(r.Po || 0) > 0 && Number(r.Pp || 0) > 0)
      .filter((r) => Number(r.Po) - Number(r.Pp) > 5 && Number(r.Pp) <= 10)
      .map((r) => ({
        keyword: r.Ph,
        previous_position: Number(r.Pp),
        current_position: Number(r.Po),
        delta: Number(r.Po) - Number(r.Pp)
      }));
    return {
      status: losses.length ? 'fail' : 'pass',
      severity: losses.length ? 'warning' : null,
      payload: { domain: c.domain, lost_count: losses.length, top_losses: losses.slice(0, 10) }
    };
  }
});

registerCheck('web.semrush.toxic_backlinks', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: async (ctx) => {
    const c = await getSemrushContext(ctx);
    if (c.kind !== 'ok') return { status: 'skipped', payload: { reason: c.reason } };
    const result = await callSemrush(
      {
        type: 'backlinks_overview',
        target: c.domain,
        target_type: 'root_domain',
        export_columns: 'total,domains_num,toxic_score'
      },
      c.apiKey
    ).catch((err) => ({ error: err.message }));
    if (result.error) {
      return {
        status: 'error',
        severity: 'warning',
        payload: { error: result.error, domain: c.domain }
      };
    }
    const top = result.rows?.[0] || {};
    const toxic = Number(top.toxic_score || 0);
    const fail = toxic > 50;
    return {
      status: fail ? 'fail' : 'pass',
      severity: fail ? 'warning' : null,
      payload: {
        domain: c.domain,
        backlinks_total: Number(top.total || 0),
        ref_domains: Number(top.domains_num || 0),
        toxic_score: toxic
      }
    };
  }
});
