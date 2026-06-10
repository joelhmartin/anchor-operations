/**
 * HIPAA gate — Meta umbrella.
 *
 * Meta does NOT sign Business Associate Agreements (BAAs). Per CLAUDE.md and
 * the existing trackingRelay.js gate, Meta integrations MUST be skipped for
 * any client whose `client_profiles.client_type === 'medical'`.
 *
 * This module is the SINGLE source of truth for that gate. Every Meta check
 * must call `assertNonMedical(ctx)` BEFORE issuing any Meta API call. The
 * gate is explicit, not silent: medical clients receive a registered
 * `status='skipped'` result with `payload_json={reason: 'hipaa_no_meta', ...}`
 * so audits can confirm the policy fired.
 *
 * Usage:
 *
 *   import { assertNonMedical } from './_hipaaGate.js';
 *
 *   handler: async (ctx) => {
 *     const gate = await assertNonMedical(ctx);
 *     if (gate.skipped) return gate.outcome;
 *     // ... Meta API work
 *   }
 *
 * If the gate cannot be evaluated (no profile row, no client_type column)
 * the check is conservatively skipped with reason='client_type_unknown'.
 * Never silently allow Meta calls when the type is indeterminate.
 */

import { query } from '../../../../db.js';

const _profileCacheKey = '_metaHipaaGateProfileCache';

async function loadClientType(ctx) {
  // Per-run memoization: every Meta check on the same run hits this once.
  if (ctx && ctx[_profileCacheKey] !== undefined) {
    return ctx[_profileCacheKey];
  }
  const clientUserId = ctx?.clientUserId;
  if (!clientUserId) {
    if (ctx) ctx[_profileCacheKey] = null;
    return null;
  }
  try {
    const { rows } = await query(
      `SELECT client_type FROM client_profiles WHERE user_id = $1 LIMIT 1`,
      [clientUserId]
    );
    const value = rows[0]?.client_type ?? null;
    if (ctx) ctx[_profileCacheKey] = value;
    return value;
  } catch (err) {
    console.warn(`[ops/meta/hipaaGate] client_type lookup failed: ${err.message}`);
    if (ctx) ctx[_profileCacheKey] = null;
    return null;
  }
}

/**
 * Resolve the HIPAA gate for this run/client. Returns one of:
 *   { skipped: false }                      — caller may proceed with Meta work
 *   { skipped: true, outcome: { ... } }     — caller MUST return outcome
 */
export async function assertNonMedical(ctx) {
  const clientType = await loadClientType(ctx);

  if (clientType === 'medical') {
    return {
      skipped: true,
      outcome: {
        status: 'skipped',
        severity: null,
        payload: {
          reason: 'hipaa_no_meta',
          policy: 'Meta does not sign HIPAA Business Associate Agreements.',
          client_type: 'medical'
        }
      }
    };
  }

  if (clientType !== 'non_medical') {
    // Unknown / unset client_type — fail safe. We do NOT issue Meta calls
    // unless the type is explicitly recorded as non_medical.
    return {
      skipped: true,
      outcome: {
        status: 'skipped',
        severity: null,
        payload: {
          reason: 'client_type_unknown',
          detail: 'client_profiles.client_type must be "non_medical" before Meta checks run.',
          client_type: clientType
        }
      }
    };
  }

  return { skipped: false };
}
