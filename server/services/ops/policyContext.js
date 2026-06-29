/** Loads the per-client policy context used by the recommendation + action engine. */
import { query } from '../../db.js';

export async function loadClientPolicyContext(clientUserId, queryFn = query) {
  if (!clientUserId) return { clientType: null, mutationsEnabled: false, monthlyCapCents: null };
  let row = null;
  try {
    const { rows } = await queryFn(
      `SELECT client_type, ops_monthly_cap_cents FROM client_profiles WHERE user_id = $1 LIMIT 1`,
      [clientUserId]
    );
    row = rows[0] || null;
  } catch {
    row = null;
  }
  return {
    clientType: row?.client_type || null,
    // Mutations are disabled by default (north-star §7.8); no opt-in column exists yet.
    mutationsEnabled: false,
    monthlyCapCents: row?.ops_monthly_cap_cents ?? null
  };
}

export default { loadClientPolicyContext };
