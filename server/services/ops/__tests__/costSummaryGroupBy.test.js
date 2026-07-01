import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Regression guard for GET /cost-summary (server/routes/ops.js).
//
// The cost-summary SELECT emits the canonical client label via
// clientLabelSelect('client_name'). That expression's last-resort branch
// references `u.id` ('Client ' || LEFT(u.id::text, 8)). The query GROUPs BY
// r.client_user_id — a DIFFERENT table's column — so Postgres does NOT treat
// u.id as functionally dependent and rejects the query with:
//   "column \"u.id\" must appear in the GROUP BY clause or be used in an
//    aggregate function".
// This threw for EVERY call whenever any ops_run existed in the month, so the
// endpoint was 500-broken in prod. The fix adds `u.id` to the GROUP BY.
test('cost-summary GROUP BY includes u.id (clientLabel references u.id)', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../../routes/ops.js', import.meta.url)),
    'utf8'
  );

  // Isolate the cost-summary query block.
  const idx = src.indexOf("router.get('/cost-summary'");
  assert.ok(idx !== -1, 'cost-summary route present');
  const block = src.slice(idx, idx + 2000);

  const groupBy = /GROUP BY ([^\n]*)/.exec(block);
  assert.ok(groupBy, 'cost-summary query has a GROUP BY');
  assert.match(
    groupBy[1],
    /\bu\.id\b/,
    'cost-summary GROUP BY must include u.id (referenced by clientLabelSelect); otherwise Postgres rejects the query'
  );
});
