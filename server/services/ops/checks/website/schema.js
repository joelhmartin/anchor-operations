/**
 * web.schema.* — JSON-LD schema validation on the homepage.
 *
 * Three checks:
 *   web.schema.has_organization
 *   web.schema.has_localbusiness   (only meaningful for medical/dental clients)
 *   web.schema.parse_errors
 */

import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';
import { resolveClientWebsiteUrl, safeHttpFetch } from './_lib/httpFetch.js';

const LOCALBUSINESS_TYPES = new Set([
  'LocalBusiness',
  'MedicalBusiness',
  'MedicalOrganization',
  'MedicalClinic',
  'Dentist',
  'Physician',
  'HealthAndBeautyBusiness',
  'DentalClinic'
]);

const ORG_TYPES = new Set([
  'Organization',
  'Corporation',
  'EducationalOrganization',
  'GovernmentOrganization',
  'MedicalOrganization',
  ...LOCALBUSINESS_TYPES
]);

function extractJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    blocks.push(m[1]);
  }
  return blocks;
}

function extractTypes(parsed, into) {
  if (!parsed) return;
  if (Array.isArray(parsed)) {
    for (const item of parsed) extractTypes(item, into);
    return;
  }
  if (typeof parsed === 'object') {
    if (parsed['@graph']) extractTypes(parsed['@graph'], into);
    const t = parsed['@type'];
    if (Array.isArray(t)) for (const tt of t) into.add(String(tt));
    else if (typeof t === 'string') into.add(t);
  }
}

async function getSchemaSnapshot(ctx) {
  if (!ctx._schemaCachePromise) {
    ctx._schemaCachePromise = (async () => {
      const websiteUrl = await resolveClientWebsiteUrl(query, ctx.clientUserId);
      if (!websiteUrl) {
        return { kind: 'skipped', reason: 'no website URL configured for client' };
      }
      let res;
      try {
        res = await safeHttpFetch(websiteUrl, { timeoutMs: 12_000, maxBytes: 750_000, signal: ctx.signal });
      } catch (err) {
        return { kind: 'error', error: err.message, websiteUrl };
      }
      const blocks = extractJsonLdBlocks(res.body || '');
      const types = new Set();
      const parseErrors = [];
      for (const raw of blocks) {
        try {
          const parsed = JSON.parse(raw);
          extractTypes(parsed, types);
        } catch (err) {
          parseErrors.push(err.message);
        }
      }
      // Look up client_type to know if LocalBusiness is required.
      const ct = await query(
        'SELECT client_type FROM client_profiles WHERE user_id = $1',
        [ctx.clientUserId]
      ).catch(() => ({ rows: [] }));
      const clientType = ct.rows[0]?.client_type || null;
      return {
        kind: 'ok',
        websiteUrl,
        block_count: blocks.length,
        types: Array.from(types),
        parse_errors: parseErrors,
        client_type: clientType
      };
    })();
  }
  return ctx._schemaCachePromise;
}

registerCheck('web.schema.has_organization', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: async (ctx) => {
    const snap = await getSchemaSnapshot(ctx);
    if (snap.kind === 'skipped') return { status: 'skipped', payload: { reason: snap.reason } };
    if (snap.kind === 'error') {
      return { status: 'error', severity: 'warning', payload: snap };
    }
    const found = snap.types.some((t) => ORG_TYPES.has(t));
    return {
      status: found ? 'pass' : 'fail',
      severity: found ? null : 'warning',
      payload: { website_url: snap.websiteUrl, types: snap.types, found }
    };
  }
});

registerCheck('web.schema.has_localbusiness', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: async (ctx) => {
    const snap = await getSchemaSnapshot(ctx);
    if (snap.kind === 'skipped') return { status: 'skipped', payload: { reason: snap.reason } };
    if (snap.kind === 'error') {
      return { status: 'error', severity: 'warning', payload: snap };
    }
    // Only meaningful for medical/dental clients per plan §5.4.
    const isMedical = snap.client_type === 'medical' || snap.client_type === 'dental';
    if (!isMedical) {
      return {
        status: 'skipped',
        payload: { reason: 'client_type is not medical/dental', client_type: snap.client_type }
      };
    }
    const found = snap.types.some((t) => LOCALBUSINESS_TYPES.has(t));
    return {
      status: found ? 'pass' : 'fail',
      severity: found ? null : 'warning',
      payload: { website_url: snap.websiteUrl, types: snap.types, found }
    };
  }
});

registerCheck('web.schema.parse_errors', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: async (ctx) => {
    const snap = await getSchemaSnapshot(ctx);
    if (snap.kind === 'skipped') return { status: 'skipped', payload: { reason: snap.reason } };
    if (snap.kind === 'error') {
      return { status: 'error', severity: 'warning', payload: snap };
    }
    const errs = snap.parse_errors || [];
    return {
      status: errs.length ? 'fail' : 'pass',
      severity: errs.length ? 'warning' : null,
      payload: {
        website_url: snap.websiteUrl,
        parse_errors: errs,
        block_count: snap.block_count
      }
    };
  }
});
