// server/services/ops/blog/wpClient.js
// NOTE: Security modules are at server/services/security/ (2 levels up from blog/),
// so the correct relative paths are ../../security/*, not ../../../security/*.
import { decrypt, isEncrypted } from '../../security/encryption.js';
import { assertPublicHttpUrl, SsrfBlockedError } from '../../security/ssrfGuard.js';
import { query } from '../../../db.js';

export function basicAuthHeader(auth) {
  return `Basic ${auth}`;
}

// Resolve the decrypted Basic credential + site URL for a WordPress oauth_connection.
export async function resolveWpConnection(oauthConnectionId) {
  const { rows } = await query(
    `SELECT access_token, metadata FROM oauth_connections WHERE id = $1 AND provider = 'wordpress'`,
    [oauthConnectionId]
  );
  if (!rows.length) throw new Error('WordPress connection not found');
  const stored = rows[0].access_token;
  const auth = isEncrypted(stored) ? decrypt(stored) : stored;
  if (!auth) throw new Error('WordPress credential could not be decrypted');
  const siteUrl = (rows[0].metadata && rows[0].metadata.site_url) || null;
  if (!siteUrl) throw new Error('WordPress site_url missing on connection');
  return { auth, siteUrl: String(siteUrl).replace(/\/+$/, '') };
}

// SSRF-guarded fetch: blocks private hosts and refuses redirects.
export async function safeWpFetch(url, { auth, method = 'GET', body = null, headers = {} } = {}) {
  await assertPublicHttpUrl(url); // throws SsrfBlockedError
  const opts = {
    method,
    redirect: 'manual',
    headers: { Authorization: basicAuthHeader(auth), ...headers }
  };
  if (body != null) opts.body = body;
  const res = await fetch(url, opts);
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new SsrfBlockedError(`Refused redirect from ${url}`);
  }
  return res;
}

export async function wpUploadMedia(siteUrl, auth, { bytes, filename, contentType }) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), filename || 'image');
  const res = await safeWpFetch(`${siteUrl}/wp-json/wp/v2/media`, { auth, method: 'POST', body: fd });
  if (!res.ok) throw new Error(`WP media upload failed (${res.status})`);
  const json = await res.json();
  return { id: json.id };
}

export async function wpCreatePost(siteUrl, auth, { title, html, featuredMediaId = null }) {
  const payload = { title, content: html, status: 'publish' };
  if (featuredMediaId) payload.featured_media = featuredMediaId;
  const res = await safeWpFetch(`${siteUrl}/wp-json/wp/v2/posts`, {
    auth,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WP post create failed (${res.status})`);
  }
  const json = await res.json();
  return { id: String(json.id), url: json.link || null };
}
