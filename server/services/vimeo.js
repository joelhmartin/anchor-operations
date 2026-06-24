/**
 * Vimeo service — resolves Vimeo video IDs to direct progressive mp4 URLs
 * for consumption by Meta Graph's video_url parameter.
 *
 * Progressive file delivery via the Vimeo API requires a Premium-tier
 * Vimeo account. Free/Plus tiers will receive VIMEO_NO_PROGRESSIVE.
 *
 * Uses native fetch (Node 20+) — no node-fetch dependency.
 */

const VIMEO_API_BASE = 'https://api.vimeo.com';

/**
 * Parse a Vimeo ID from a raw ID or various Vimeo URL formats.
 *
 * Accepts:
 *   - '123456'
 *   - 'vimeo.com/123456'
 *   - 'vimeo.com/video/123456'
 *   - 'player.vimeo.com/video/123456'
 *   - http(s) prefixes, trailing paths/query strings
 *
 * @param {string} input
 * @returns {string|null} the numeric ID as a string, or null if no match
 */
export function parseVimeoId(input) {
  if (!input || typeof input !== 'string') return null;
  const match = input.match(/(?:vimeo\.com\/(?:video\/)?|^)(\d{6,})/);
  return match ? match[1] : null;
}

/**
 * Fetch the highest-resolution progressive mp4 for a Vimeo video.
 *
 * @param {string} vimeoId
 * @returns {Promise<{url: string, name: string, duration: number}>}
 * @throws {Error} with `.code`:
 *   - 'VIMEO_NOT_CONFIGURED' — VIMEO_ACCESS_TOKEN env var missing
 *   - 'VIMEO_API_ERROR' — non-OK response (also has `.status`)
 *   - 'VIMEO_NO_PROGRESSIVE' — no progressive mp4 available (free/Plus tier)
 */
export async function getDirectFileUrl(vimeoId) {
  const token = process.env.VIMEO_ACCESS_TOKEN;
  if (!token) {
    const err = new Error('VIMEO_ACCESS_TOKEN not configured');
    err.code = 'VIMEO_NOT_CONFIGURED';
    throw err;
  }

  const url = `${VIMEO_API_BASE}/videos/${encodeURIComponent(vimeoId)}?fields=files,name,duration`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.vimeo.*+json;version=3.4'
    }
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`Vimeo API error ${resp.status}: ${body}`);
    err.code = 'VIMEO_API_ERROR';
    err.status = resp.status;
    err.body = body;
    throw err;
  }

  const data = await resp.json();
  const files = Array.isArray(data?.files) ? data.files : [];
  const progressive = files.filter((f) => f && f.type === 'video/mp4' && !!f.link).sort((a, b) => (b.height || 0) - (a.height || 0));

  if (progressive.length === 0) {
    const err = new Error('No progressive mp4 file available for this Vimeo video (Premium tier required)');
    err.code = 'VIMEO_NO_PROGRESSIVE';
    throw err;
  }

  return {
    url: progressive[0].link,
    name: data.name,
    duration: data.duration
  };
}
