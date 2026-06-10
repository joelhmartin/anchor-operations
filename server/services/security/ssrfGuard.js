/**
 * SSRF guard helpers.
 *
 * Use `assertPublicHttpUrl(url)` before any outbound fetch whose target is
 * derived from user input or remote-controlled state (DB row, scan result,
 * external API response). Refuses non-http(s) schemes and any hostname that
 * resolves to a private / link-local / loopback address.
 *
 * Throws an `SsrfBlockedError` (extends Error) on rejection so callers can
 * surface a clean message without crashing.
 */

import dns from 'node:dns';
import net from 'node:net';

export class SsrfBlockedError extends Error {
  constructor(reason) {
    super(`SSRF guard blocked outbound fetch: ${reason}`);
    this.name = 'SsrfBlockedError';
    this.code = 'SSRF_BLOCKED';
  }
}

function isPrivateIPv4(ip) {
  // ip is dotted-quad. Convert to numeric octets.
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    // Not a parseable v4 — treat as suspicious.
    return true;
  }
  const [a, b] = parts;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 169.254.0.0/16 link-local
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 100.64.0.0/10 carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower === '::') return true;
  // fc00::/7 unique-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // fe80::/10 link-local
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true;
  }
  // ::ffff:a.b.c.d  (IPv4-mapped IPv6) — treat as v4 mapped
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1]);
  return false;
}

/**
 * Validate URL scheme + resolved hostname. Throws SsrfBlockedError on bad input.
 *
 * @param {string} rawUrl
 * @returns {Promise<URL>} parsed URL ready to fetch
 */
export async function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(`scheme not allowed (${parsed.protocol})`);
  }

  const host = parsed.hostname;
  if (!host) throw new SsrfBlockedError('no hostname');

  // If host is already a literal IP, classify directly.
  if (net.isIP(host)) {
    if (net.isIP(host) === 4 && isPrivateIPv4(host)) {
      throw new SsrfBlockedError(`private IPv4 (${host})`);
    }
    if (net.isIP(host) === 6 && isPrivateIPv6(host)) {
      throw new SsrfBlockedError(`private IPv6 (${host})`);
    }
    return parsed;
  }

  // Resolve via DNS. lookup honors /etc/hosts and the OS resolver, which
  // matches what the eventual fetch will see.
  let resolved;
  try {
    resolved = await dns.promises.lookup(host, { all: true });
  } catch (err) {
    throw new SsrfBlockedError(`dns lookup failed: ${err.code || err.message}`);
  }
  if (!resolved.length) throw new SsrfBlockedError('hostname did not resolve');

  for (const r of resolved) {
    if (r.family === 4 && isPrivateIPv4(r.address)) {
      throw new SsrfBlockedError(`hostname resolves to private IPv4 (${r.address})`);
    }
    if (r.family === 6 && isPrivateIPv6(r.address)) {
      throw new SsrfBlockedError(`hostname resolves to private IPv6 (${r.address})`);
    }
  }

  return parsed;
}
