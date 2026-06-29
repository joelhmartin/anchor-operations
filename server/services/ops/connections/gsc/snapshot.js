/**
 * GSC snapshot collection (spec §5 collectSnapshot).
 * Fetches Search Console search analytics data and returns rows conforming
 * to the F3 ops_daily_snapshots shape. Does NOT persist — F3 owns that.
 *
 * Four scope types returned:
 *   site    — aggregate totals for the property
 *   page    — per-page breakdown (top 25 000 rows)
 *   query   — per-query breakdown (top 25 000 rows)
 *   device  — by device type (MOBILE / DESKTOP / TABLET)
 */

const ANALYTICS_BASE = 'https://searchconsole.googleapis.com/webmasters/v3/sites';

/** Subtract `days` days from an ISO date string; returns ISO date string. */
function subtractDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * POST to the Search Console searchAnalytics/query endpoint.
 * Throws on HTTP errors.
 */
export async function querySearchAnalytics(token, siteUrl, body, { signal, _fetch = globalThis.fetch } = {}) {
  const url = `${ANALYTICS_BASE}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const res = await _fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {})
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`GSC searchAnalytics ${res.status}`), { status: res.status, body: text.slice(0, 400) });
  }
  return res.json();
}

/**
 * Collect a full GSC snapshot for one site property on `date`.
 * Returns ops_daily_snapshots-shaped rows (not yet persisted).
 *
 * @param {object} opts
 * @param {string} opts.clientUserId
 * @param {string} opts.siteUrl       - GSC property (e.g. 'sc-domain:example.com')
 * @param {string} opts.token         - Bearer token
 * @param {string} opts.date          - ISO date 'YYYY-MM-DD' (the snapshot date / endDate)
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts._queryAnalytics] - Injectable: async (token, siteUrl, body) => {rows}
 * @returns {Promise<Array>}
 */
export async function collectSnapshot({ clientUserId, siteUrl, token, date, signal, _queryAnalytics = null } = {}) {
  const queryFn = _queryAnalytics || ((tok, site, body) => querySearchAnalytics(tok, site, body, { signal }));

  const endDate = date;
  const startDate = subtractDays(date, 27); // 28-day window inclusive

  const BASE_BODY = { startDate, endDate, rowLimit: 25000 };

  const snapshots = [];

  try {
    // Helper: turn an API response row into an ops_daily_snapshots row
    const makeRow = (scopeType, scopeId, apiRow) => ({
      client_user_id: clientUserId,
      snapshot_date:  date,
      service:        'search_console',
      scope_type:     scopeType,
      scope_id:       scopeId,
      metrics_json: {
        clicks:      apiRow.clicks      ?? 0,
        impressions: apiRow.impressions ?? 0,
        ctr:         apiRow.ctr         ?? 0,
        position:    apiRow.position    ?? 0
      },
      source_run_id: null
    });

    // 1. Aggregate (no dimensions)
    const agg = await queryFn(token, siteUrl, { ...BASE_BODY });
    for (const r of agg.rows || []) {
      snapshots.push(makeRow('site', siteUrl, r));
    }
    // If the API returns no rows but HTTP 200, emit a zeroed aggregate row
    if (!(agg.rows || []).length) {
      snapshots.push(makeRow('site', siteUrl, { clicks: 0, impressions: 0, ctr: 0, position: 0 }));
    }

    // 2. By page
    const byPage = await queryFn(token, siteUrl, { ...BASE_BODY, dimensions: ['page'] });
    for (const r of byPage.rows || []) {
      snapshots.push(makeRow('page', r.keys[0], r));
    }

    // 3. By query
    const byQuery = await queryFn(token, siteUrl, { ...BASE_BODY, dimensions: ['query'] });
    for (const r of byQuery.rows || []) {
      snapshots.push(makeRow('query', r.keys[0], r));
    }

    // 4. By device
    const byDevice = await queryFn(token, siteUrl, { ...BASE_BODY, dimensions: ['device'] });
    for (const r of byDevice.rows || []) {
      snapshots.push(makeRow('device', r.keys[0], r));
    }
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) throw err;
    // Any failure returns whatever was collected so far (may be empty)
    return snapshots;
  }

  return snapshots;
}
