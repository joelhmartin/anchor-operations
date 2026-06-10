/**
 * Google Ads sub-agent — Phase 7 (read-only per P5).
 *
 * Tools:
 *   - gads_query              — sandboxed GAQL execution; SELECT-only
 *   - gads_keyword_history    — reads ops_keyword_history (Phase 4 snapshots)
 *   - gads_disapproved_reason — fetch the policy reason for one ad id
 *
 * Mutating tools (pause_ad, change_budget) are intentionally NOT registered.
 * P5 holds Google Ads to read-only in v1; mutations are deferred to a future
 * phase that re-evaluates the safety story (volume of conversions touched per
 * mutation, blast-radius of misfire, etc.).
 */

import { runSubAgentLoop } from './_runner.js';
import { withCustomer, hasAgencyCredentials, resolveCustomerIdForClient, getCustomerClient } from '../../checks/google_ads/_client.js';
import { query } from '../../../../db.js';

const SYSTEM_PROMPT = `You are the **Google Ads** sub-agent. You answer questions about a single client's Google Ads account using the agency MCC refresh token. Read-only in v1.

## Hard rules
1. Read-only. You cannot pause ads, change budgets, or mutate the account. If the user asks for a mutation, explain that mutations are deferred and describe what they would need to do manually.
2. Cite specific entities (campaign id, ad group id, keyword) in your answers.
3. GAQL only accepts SELECT. WHERE / ORDER BY / LIMIT are fine. Mutations would error anyway, but the gads_query tool will refuse non-SELECT.
4. When investigating "why did conversions drop", correlate: disapproved ads → conversion-action validity → keyword position changes → budget pacing.
5. Concise output. Show numbers, not adjectives.`;

const SELECT_ONLY = /^\s*select\b/i;

function buildSafeCustomer(ctx) {
  // Sub-agent has the picked clientUserId already on ctx.
  return withCustomer(ctx.clientUserId);
}

const gads_query = {
  declaration: {
    name: 'gads_query',
    description:
      'Run a GAQL SELECT query against the picked client\'s Google Ads account. Non-SELECT statements are refused. Returns up to 200 rows.',
    parameters: {
      type: 'object',
      properties: { gaql: { type: 'string' } },
      required: ['gaql']
    }
  },
  mutating: false,
  async handler(args, ctx) {
    const gaql = String(args.gaql || '').trim();
    if (!gaql) return { error: 'gaql required' };
    if (!SELECT_ONLY.test(gaql)) return { error: 'Only SELECT queries are allowed' };
    if (gaql.length > 4000) return { error: 'GAQL too long' };

    const cust = await buildSafeCustomer(ctx);
    if (cust.skipped) return { skipped: true, reason: cust.reason };

    let cappedGaql = gaql;
    if (!/\blimit\b/i.test(gaql)) cappedGaql = `${gaql} LIMIT 200`;
    try {
      const rows = await cust.customer.query(cappedGaql);
      return { customer_id: cust.customerId, row_count: rows.length, rows };
    } catch (err) {
      return { error: err.message || 'GAQL query failed' };
    }
  }
};

const gads_keyword_history = {
  declaration: {
    name: 'gads_keyword_history',
    description:
      'Read keyword position-share history snapshots from ops_keyword_history (Phase 4). Returns time series for one keyword on this client.',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        days: { type: 'integer', description: 'Lookback days, default 30' }
      },
      required: ['keyword']
    }
  },
  mutating: false,
  async handler(args, ctx) {
    if (!ctx.clientUserId) return { error: 'No client picked' };
    const keyword = String(args.keyword || '').trim();
    if (!keyword) return { error: 'keyword required' };
    const days = Math.max(1, Math.min(180, args.days || 30));
    const { rows } = await query(
      `SELECT keyword_text, match_type, ad_group_id, avg_position, captured_at
         FROM ops_keyword_history
        WHERE client_user_id = $1
          AND lower(keyword_text) = lower($2)
          AND captured_at >= NOW() - ($3 || ' days')::interval
        ORDER BY captured_at ASC`,
      [ctx.clientUserId, keyword, days]
    ).catch((err) => ({ rows: [], error: err.message }));
    return { keyword, days, snapshots: rows };
  }
};

const gads_disapproved_reason = {
  declaration: {
    name: 'gads_disapproved_reason',
    description: 'Fetch the policy disapproval reason for one ad id on this client\'s Google Ads account.',
    parameters: {
      type: 'object',
      properties: { ad_id: { type: 'string' } },
      required: ['ad_id']
    }
  },
  mutating: false,
  async handler(args, ctx) {
    const adId = String(args.ad_id || '').trim();
    if (!/^\d+$/.test(adId)) return { error: 'ad_id must be numeric' };
    if (!hasAgencyCredentials()) return { skipped: true, reason: 'Google Ads agency credentials not configured' };
    const customerId = await resolveCustomerIdForClient(ctx.clientUserId);
    if (!customerId) return { skipped: true, reason: 'no Google Ads customer_id linked' };
    const customer = getCustomerClient(customerId);
    try {
      const rows = await customer.query(
        `SELECT ad_group_ad.ad.id, ad_group_ad.policy_summary.approval_status,
                ad_group_ad.policy_summary.review_status, ad_group_ad.policy_summary.policy_topic_entries
           FROM ad_group_ad WHERE ad_group_ad.ad.id = ${adId} LIMIT 1`
      );
      return { ad_id: adId, customer_id: customerId, results: rows };
    } catch (err) {
      return { error: err.message || 'GAQL query failed' };
    }
  }
};

const TOOLS = { gads_query, gads_keyword_history, gads_disapproved_reason };

const tools = {
  list() {
    return Object.values(TOOLS).map((t) => t.declaration);
  },
  get(name) {
    return TOOLS[name] || null;
  }
};

export default {
  name: 'googleAds',
  systemPrompt: SYSTEM_PROMPT,
  getTool(name) {
    return tools.get(name);
  },
  listTools() {
    return tools.list();
  },
  async run(params) {
    return runSubAgentLoop({
      name: 'googleAds',
      systemPrompt: SYSTEM_PROMPT,
      tools,
      ...params
    });
  }
};
