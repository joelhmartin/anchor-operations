// Canonical client display name helper.
//
// Per CLAUDE.md, the display name for any client comes from this fallback chain:
//   1. client_profiles.client_identifier_value  (the informal business name —
//      "Pearson Roofing", "Gunnerson Dental" — consistently populated for real clients)
//   2. brand_assets.business_name               (mostly NULL in prod; useful for seeded rows)
//   3. users.first_name + ' ' + users.last_name
//   4. users.email
//   5. 'Client ' || first 8 chars of users.id  (last-resort placeholder so the
//      column is never NULL — never reached for real client rows)
//
// Backend endpoints should select `client_label` using this helper and join through
// client_profiles + brand_assets so the frontend never has to recompose it.
//
// PHI note: steps 3–4 can surface contact info. Do NOT use this helper for outputs
// that get forwarded to external AI / analytics / third-party systems — write an
// explicit business-only COALESCE for those (see server/services/reports/dataPackage.js
// for the canonical example).

function normalizeOpts(input, defaultAlias) {
  if (input == null) return { alias: defaultAlias, u: 'u', cp: 'cp', ba: 'ba' };
  if (typeof input === 'string') return { alias: input, u: 'u', cp: 'cp', ba: 'ba' };
  return {
    alias: input.alias || defaultAlias,
    u: input.u || 'u',
    cp: input.cp || 'cp',
    ba: input.ba || 'ba'
  };
}

/**
 * Raw SQL expression for the canonical client label, without an `AS` clause.
 * Use this when you need the expression inline (e.g. inside ORDER BY, or
 * when composing your own alias). Most callers want clientLabelSelect() instead.
 *
 * @param {object} [options] — { u, cp, ba } alias overrides (default `u`/`cp`/`ba`)
 * @returns {string}
 */
export function clientLabelExpression(options) {
  const { u, cp, ba } = normalizeOpts(options, 'client_label');
  // Final 'Unknown client' literal guards against the case where the caller
  // LEFT-joins users and ${u}.id is NULL — without it, 'Client ' || LEFT(NULL,8)
  // would resolve to NULL and the column wouldn't satisfy the "never NULL" promise.
  return `COALESCE(
    NULLIF(TRIM(${cp}.client_identifier_value), ''),
    NULLIF(TRIM(${ba}.business_name), ''),
    NULLIF(TRIM(${u}.first_name || ' ' || ${u}.last_name), ''),
    NULLIF(${u}.email, ''),
    'Client ' || LEFT(${u}.id::text, 8),
    'Unknown client'
  )`;
}

/**
 * SQL expression that yields the canonical client display name with an alias.
 * Assumes the query has the aliases produced by clientLabelJoins() (default: `u`, `cp`, `ba`).
 *
 * @param {string|object} [options] — output alias string, or { alias, u, cp, ba } overrides
 * @returns {string} SQL fragment, e.g. "COALESCE(...) AS client_label"
 */
export function clientLabelSelect(options) {
  const { alias } = normalizeOpts(options, 'client_label');
  return `${clientLabelExpression(options)} AS ${alias}`;
}

/**
 * LEFT JOIN clauses that bring in client_profiles and brand_assets for a given
 * user_id expression. The `users` table must already be in the FROM clause.
 *
 * client_profiles is joined directly because user_id is the primary key, so the
 * relationship is guaranteed 1:1. brand_assets is joined via LATERAL — the unique
 * index on brand_assets.user_id is created only when no duplicates already exist
 * (see init.sql), so legacy rows can fan out without the LIMIT 1.
 *
 * @param {string|object} [options] — user_id expression string, or { userIdExpr, cp, ba } overrides
 * @returns {string} SQL fragment with the joins
 */
export function clientLabelJoins(options) {
  let userIdExpr = 'u.id';
  let cp = 'cp';
  let ba = 'ba';
  if (typeof options === 'string') userIdExpr = options;
  else if (options && typeof options === 'object') {
    userIdExpr = options.userIdExpr || userIdExpr;
    cp = options.cp || cp;
    ba = options.ba || ba;
  }
  return `
    LEFT JOIN client_profiles ${cp} ON ${cp}.user_id = ${userIdExpr}
    LEFT JOIN LATERAL (
      SELECT *
      FROM brand_assets
      WHERE user_id = ${userIdExpr}
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT 1
    ) ${ba} ON true
  `;
}
