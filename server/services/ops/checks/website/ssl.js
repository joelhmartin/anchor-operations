/**
 * web.ssl.expiry_within_30d / web.ssl.expiry_within_7d
 *
 * Performs a TLS handshake against the client's primary website URL, reads
 * the peer certificate, and emits warning / critical results based on days to
 * expiry.
 *
 * One handler powers both check_ids — registry registers them as separate
 * entries and the executor runs each, but we share the underlying TLS probe.
 * The internal helper memoizes per-run via the cost tracker context.
 */

import tls from 'node:tls';
import { URL } from 'node:url';
import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';
import { resolveClientWebsiteUrl } from './_lib/httpFetch.js';

const HANDSHAKE_TIMEOUT_MS = 8_000;

async function probeCertificate(websiteUrl) {
  const parsed = new URL(websiteUrl);
  if (parsed.protocol !== 'https:') {
    return { error: 'site is not HTTPS', url: websiteUrl };
  }
  const port = parsed.port ? Number(parsed.port) : 443;
  const host = parsed.hostname;

  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        timeout: HANDSHAKE_TIMEOUT_MS,
        rejectUnauthorized: false
      },
      () => {
        const cert = socket.getPeerCertificate(false);
        socket.end();
        if (!cert || !cert.valid_to) {
          resolve({ error: 'no certificate returned', url: websiteUrl });
          return;
        }
        const validFrom = cert.valid_from ? new Date(cert.valid_from) : null;
        const validTo = new Date(cert.valid_to);
        const now = Date.now();
        const daysToExpiry = Math.floor((validTo.getTime() - now) / (24 * 60 * 60 * 1000));
        resolve({
          host,
          subject: cert.subject?.CN || null,
          issuer: cert.issuer?.CN || null,
          valid_from: validFrom?.toISOString() || null,
          valid_to: validTo.toISOString(),
          days_to_expiry: daysToExpiry,
          authorized: socket.authorized,
          authorization_error: socket.authorizationError ? String(socket.authorizationError) : null
        });
      }
    );
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ error: 'TLS handshake timeout', url: websiteUrl });
    });
    socket.on('error', (err) => {
      resolve({ error: `TLS error: ${err.message}`, url: websiteUrl });
    });
  });
}

async function getCertOutcome(ctx) {
  // Memoize within a single run so both 30d / 7d checks reuse one handshake.
  if (!ctx._sslCachePromise) {
    ctx._sslCachePromise = (async () => {
      const websiteUrl = await resolveClientWebsiteUrl(query, ctx.clientUserId);
      if (!websiteUrl) {
        return { kind: 'skipped', reason: 'no website URL configured for client' };
      }
      const cert = await probeCertificate(websiteUrl);
      return { kind: 'ok', websiteUrl, cert };
    })();
  }
  return ctx._sslCachePromise;
}

function buildResult(checkId, ctx, threshold, severity) {
  return getCertOutcome(ctx).then((res) => {
    if (res.kind === 'skipped') {
      return { status: 'skipped', payload: { reason: res.reason } };
    }
    const { cert, websiteUrl } = res;
    if (cert.error) {
      return {
        status: 'error',
        severity: 'warning',
        payload: { website_url: websiteUrl, error: cert.error }
      };
    }
    const days = cert.days_to_expiry;
    const warn = Number.isFinite(days) && days <= threshold;
    return {
      status: warn ? 'fail' : 'pass',
      severity: warn ? severity : null,
      payload: {
        check_id: checkId,
        website_url: websiteUrl,
        threshold_days: threshold,
        days_to_expiry: days,
        valid_to: cert.valid_to,
        issuer: cert.issuer,
        authorized: cert.authorized,
        authorization_error: cert.authorization_error
      }
    };
  });
}

registerCheck('web.ssl.expiry_within_30d', {
  umbrella: 'website',
  tier: 'daily_essential',
  costEstimate: 0,
  requires: [],
  handler: async (ctx) => buildResult('web.ssl.expiry_within_30d', ctx, 30, 'warning')
});

registerCheck('web.ssl.expiry_within_7d', {
  umbrella: 'website',
  tier: 'daily_essential',
  costEstimate: 0,
  requires: [],
  handler: async (ctx) => buildResult('web.ssl.expiry_within_7d', ctx, 7, 'critical')
});
