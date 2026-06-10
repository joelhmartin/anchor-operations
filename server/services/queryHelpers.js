// Tiny SQL fragment helpers for predicates that show up everywhere.
//
// These exist so that schema renames or semantic shifts (e.g. archived_at →
// deleted_at) become a single-file change instead of a 100-site grep.

function prefix(table) {
  return table ? `${table}.` : '';
}

/** `${table}.archived_at IS NULL` — soft-delete filter. */
export function activeOnly(table = '') {
  return `${prefix(table)}archived_at IS NULL`;
}

/** `${table}.revoked_at IS NULL` — credential / token / invite revocation filter. */
export function notRevoked(table = '') {
  return `${prefix(table)}revoked_at IS NULL`;
}

/** `${table}.deleted_at IS NULL` — used by tables that prefer deleted over archived. */
export function notDeleted(table = '') {
  return `${prefix(table)}deleted_at IS NULL`;
}

/**
 * Parse `limit` / `offset` query params for paginated list endpoints.
 *
 * Returns sanitized integers clamped to safe ranges so handlers never have to
 * reinvent the same Math.min/Math.max dance. Default limit is 100; hard cap is
 * 500 (overridable per-endpoint via `maxLimit`). Negative or non-numeric input
 * falls back to defaults rather than throwing — pagination is a hint, not a
 * contract worth 400ing on.
 *
 * Endpoints should pair this with `meta: { limit, offset, total }` in the
 * response so callers can render "showing N of M" without a separate count
 * round-trip.
 */
export function parsePagination(reqQuery = {}, { defaultLimit = 100, maxLimit = 500 } = {}) {
  const rawLimit = Number(reqQuery.limit);
  const rawOffset = Number(reqQuery.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), maxLimit)
    : defaultLimit;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0
    ? Math.floor(rawOffset)
    : 0;
  return { limit, offset };
}
