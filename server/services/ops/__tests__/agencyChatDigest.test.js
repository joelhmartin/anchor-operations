import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Robust on a clean checkout: the module transitively imports db.js which throws
// at load if DATABASE_URL is unset. Set a default, then dynamic-import.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/anchor';
const { renderAgencyDigestText, sendAgencyChatDigest } = await import('../notifications/agencyChatDigest.js');

test('resolveClientNames query references only real prod columns (no users.name)', () => {
  // `users.name` does not exist in prod (real columns: first_name/last_name/email).
  // Referencing it threw at query time and the digest silently fell back to
  // 'Client <id8>' for every client. Guard against regressing that.
  const src = readFileSync(
    fileURLToPath(new URL('../notifications/agencyChatDigest.js', import.meta.url)),
    'utf8'
  );
  // Strip line comments so the explanatory note mentioning `u.name` doesn't trip this.
  const code = src.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\bu\.name\b/.test(code), 'must not reference u.name (phantom column)');
  assert.ok(/client_identifier_value/.test(code), 'resolves the canonical client identifier');
});

test('renderAgencyDigestText surfaces KPIs and per-client criticals', () => {
  const cc = {
    kpis: { clients_at_risk: 2, approvals_waiting: 5, changes_24h: 9 },
    discoveries: [
      { severity: 'critical', client_user_id: 'c1', summary: 'site down' },
      { severity: 'critical', client_user_id: 'c1', summary: 'x' },
      { severity: 'critical', client_user_id: 'c2', summary: 'conv zero' }
    ]
  };
  const t = renderAgencyDigestText(cc, { c1: 'Classic Dental', c2: 'AZ Smile' });
  assert.match(t, /Anchor Ops — Daily/);
  assert.match(t, /2 clients at risk/);
  assert.match(t, /5 approvals waiting/);
  assert.match(t, /Classic Dental: 2 critical — site down/);
});

test('renderAgencyDigestText: no criticals → clean message', () => {
  const t = renderAgencyDigestText({ kpis: { clients_at_risk: 0, approvals_waiting: 0, changes_24h: 0 }, discoveries: [] });
  assert.match(t, /No open critical issues/);
});

test('sendAgencyChatDigest: no webhook → not sent', async () => {
  const r = await sendAgencyChatDigest({ commandCenter: { kpis: {}, discoveries: [] }, webhookUrl: '' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_webhook_configured');
});

test('sendAgencyChatDigest: posts via injected send', async () => {
  let sent = null;
  const r = await sendAgencyChatDigest({
    commandCenter: { kpis: { clients_at_risk: 1 }, discoveries: [{ severity: 'critical', client_user_id: 'c1', summary: 's' }] },
    webhookUrl: 'https://hook',
    resolveNames: async () => ({ c1: 'Client One' }),
    send: async (p) => { sent = p; return { sent: true }; }
  });
  assert.equal(r.ok, true);
  assert.match(sent.text, /Client One: 1 critical/);
  assert.equal(sent.eventType, 'agency_daily_digest');
});

test('sendAgencyChatDigest: Chat down (send returns sent:false) → ok:false', async () => {
  const r = await sendAgencyChatDigest({
    commandCenter: { kpis: {}, discoveries: [] },
    webhookUrl: 'https://hook',
    resolveNames: async () => ({}),
    send: async () => ({ sent: false, reason: 'http_503' })
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'http_503');
});
