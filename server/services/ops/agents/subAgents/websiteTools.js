/**
 * Website sub-agent tools (Phase 7).
 *
 * Read-only tools port from `server/services/ops/operations-website/agentTools.js` and
 * are extended with PSI-on-demand, GSC query, and a SEMrush keyword lookup.
 * Mutating tools (`plugin_update`, `wp_user_password_reset`) require approval
 * via the supervisor's `propose_action` path — sub-agents never execute
 * mutators directly during a delegate_to call.
 *
 * Each tool exports the same shape as the legacy registry:
 *   { declaration, mutating, handler(args, ctx) }
 *
 * To pick `env_id` we resolve the live env of the picked client's primary
 * Kinsta site. Multi-site clients can pass `env_id` explicitly.
 */

import https from 'node:https';
import http from 'node:http';
import { wpcli, withSftp } from '../../operations-website/sshClient.js';
import { query } from '../../../../db.js';
import { assertPublicHttpUrl, SsrfBlockedError } from '../../../security/ssrfGuard.js';
import { safeHttpFetch } from '../../checks/website/_lib/httpFetch.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveEnvIdForClient(clientUserId) {
  if (!clientUserId) return null;
  const { rows } = await query(
    `SELECT e.id
       FROM kinsta_environments e
       JOIN kinsta_site_clients ksc ON ksc.site_id = e.site_id
      WHERE ksc.client_user_id = $1 AND e.is_live = TRUE
      ORDER BY e.created_at ASC
      LIMIT 1`,
    [clientUserId]
  );
  return rows[0]?.id || null;
}

async function envIdFromArgs(args, ctx) {
  if (args.env_id && UUID_RE.test(args.env_id)) return args.env_id;
  const resolved = await resolveEnvIdForClient(ctx.clientUserId);
  if (!resolved) throw new Error('No live environment found for this client');
  return resolved;
}

function fetchUrl(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 250_000) {
          req.destroy();
          reject(new Error('Response too large'));
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Fetch timeout'));
    });
  });
}

// ---------------- read tools ----------------

const plugin_list = {
  declaration: {
    name: 'plugin_list',
    description: 'List active and inactive plugins on the live env of the picked client.',
    parameters: { type: 'object', properties: { env_id: { type: 'string' } } }
  },
  mutating: false,
  async handler(args, ctx) {
    const envId = await envIdFromArgs(args, ctx);
    const res = await wpcli(envId, 'plugin list --format=json', {
      userId: ctx.userId,
      triggeredBy: `agent:website`
    });
    if (res.exitCode !== 0) return { error: res.stderr || 'wp-cli failed', exit_code: res.exitCode };
    try {
      return { plugins: JSON.parse(res.stdout) };
    } catch {
      return { error: 'Could not parse plugin list', stdout_preview: res.stdout.slice(0, 500) };
    }
  }
};

const list_recent_posts = {
  declaration: {
    name: 'list_recent_posts',
    description: 'List the N most recent posts/pages on the site.',
    parameters: {
      type: 'object',
      properties: {
        env_id: { type: 'string' },
        limit: { type: 'integer' },
        post_type: { type: 'string' }
      }
    }
  },
  mutating: false,
  async handler(args, ctx) {
    const envId = await envIdFromArgs(args, ctx);
    const limit = Math.max(1, Math.min(50, args.limit || 10));
    const type = args.post_type || 'any';
    const res = await wpcli(
      envId,
      `post list --post_type=${type} --post_status=any --orderby=date --order=DESC --posts_per_page=${limit} --format=json --fields=ID,post_title,post_status,post_type,post_date`,
      { userId: ctx.userId, triggeredBy: 'agent:website' }
    );
    if (res.exitCode !== 0) return { error: res.stderr || 'wp-cli failed' };
    try {
      return { posts: JSON.parse(res.stdout) };
    } catch {
      return { error: 'Could not parse posts', stdout_preview: res.stdout.slice(0, 500) };
    }
  }
};

// Reused tokenized allowlist from legacy agentTools.js. Kept inline so the new
// sub-agent is decoupled from the legacy module (which Phase 10 will delete).
const WPCLI_READ_ONLY_VERBS = new Set([
  'cli', 'help', 'core check-update', 'core is-installed', 'core verify-checksums', 'core version',
  'plugin list', 'plugin get', 'plugin is-installed', 'plugin path', 'plugin status', 'plugin verify-checksums',
  'theme list', 'theme get', 'theme is-installed', 'theme path', 'theme status',
  'option get', 'option list', 'option pluck',
  'post list', 'post get', 'post meta get', 'post meta list',
  'user list', 'user get', 'user meta get', 'user meta list',
  'site list', 'transient get', 'transient list',
  'cron event list', 'cron schedule list', 'rewrite list', 'role list', 'cap list',
  'menu list', 'comment list', 'comment get', 'term list', 'term get',
  'sidebar list', 'widget list',
  'language core list', 'language plugin list', 'language theme list', 'package list',
  'config get', 'config list', 'config has', 'config path',
  'maintenance-mode status', 'db size', 'db tables', 'db columns', 'db prefix', 'db check', 'media-image-size'
]);

const WPCLI_HARD_DENY_PAIRS = new Set([
  'site empty', 'eval', 'eval-file', 'shell',
  'db query', 'db drop', 'db reset', 'db import', 'db export'
]);

function classifyWpcliRead(cmd) {
  const tokens = String(cmd || '').trim().split(/\s+/).filter((t) => t && !t.startsWith('-'));
  if (!tokens.length) return { ok: false, reason: 'empty command' };
  const verb = tokens[0].toLowerCase();
  const sub = (tokens[1] || '').toLowerCase();
  const subSub = (tokens[2] || '').toLowerCase();
  const pairOne = verb;
  const pairTwo = sub ? `${verb} ${sub}` : verb;
  const pairThree = subSub ? `${verb} ${sub} ${subSub}` : pairTwo;
  for (const denied of [pairOne, pairTwo, pairThree]) {
    if (WPCLI_HARD_DENY_PAIRS.has(denied)) return { ok: false, reason: `Refused: \`wp ${denied}\` is destructive` };
  }
  for (const candidate of [pairThree, pairTwo, pairOne]) {
    if (WPCLI_READ_ONLY_VERBS.has(candidate)) return { ok: true };
  }
  return { ok: false, reason: `Refused: \`wp ${pairTwo}\` is not on the read-only allowlist.` };
}

const wpcli_read = {
  declaration: {
    name: 'wpcli_read',
    description: 'Run a READ-ONLY WP-CLI command. Tokenized allowlist; mutating verbs are refused.',
    parameters: {
      type: 'object',
      properties: { env_id: { type: 'string' }, args: { type: 'string' } },
      required: ['args']
    }
  },
  mutating: false,
  async handler(args, ctx) {
    const envId = await envIdFromArgs(args, ctx);
    const cmd = String(args.args || '').trim();
    if (!cmd) return { error: 'args required' };
    const verdict = classifyWpcliRead(cmd);
    if (!verdict.ok) return { error: verdict.reason };
    const res = await wpcli(envId, cmd, { userId: ctx.userId, triggeredBy: 'agent:website' });
    return {
      exit_code: res.exitCode,
      stdout: (res.stdout || '').slice(0, 16000),
      stderr: (res.stderr || '').slice(0, 4000)
    };
  }
};

const sftp_read = {
  declaration: {
    name: 'sftp_read',
    description: 'Read a small file via SFTP. Refuses files > 256 KB or paths under wp-content/uploads/.',
    parameters: {
      type: 'object',
      properties: { env_id: { type: 'string' }, path: { type: 'string' } },
      required: ['path']
    }
  },
  mutating: false,
  async handler(args, ctx) {
    const envId = await envIdFromArgs(args, ctx);
    const path = String(args.path || '');
    if (!path.startsWith('/')) return { error: 'path must be absolute' };
    if (path.includes('/wp-content/uploads/')) return { error: 'Refused: uploads/ may contain PHI' };
    return withSftp(
      envId,
      async (sftp) => {
        const stat = await sftp.stat(path).catch(() => null);
        if (!stat) return { error: 'File not found' };
        if (stat.size > 256 * 1024) return { error: `File too large (${stat.size} bytes)` };
        const buf = await sftp.get(path);
        return { path, size: buf.length, content: buf.toString('utf8').slice(0, 100_000) };
      },
      { userId: ctx.userId, triggeredBy: 'agent:website' }
    );
  }
};

const verify_tracking_install = {
  declaration: {
    name: 'verify_tracking_install',
    description: 'Verify GTM/GA4/Pixel install by curling the homepage and cross-referencing tracking_configs.',
    parameters: { type: 'object', properties: { env_id: { type: 'string' } } }
  },
  mutating: false,
  async handler(args, ctx) {
    const envId = await envIdFromArgs(args, ctx);
    const opts = { userId: ctx.userId, triggeredBy: 'agent:website' };
    const [home, blogname] = await Promise.all([
      wpcli(envId, 'option get home', opts),
      wpcli(envId, 'option get blogname', opts)
    ]);
    if (home.exitCode !== 0) return { error: 'Could not read home option' };
    const homeUrl = home.stdout.trim();
    let html = '';
    try {
      await assertPublicHttpUrl(homeUrl);
      const r = await fetchUrl(homeUrl);
      html = r.body || '';
    } catch (err) {
      if (err instanceof SsrfBlockedError) return { error: `Refused to fetch ${homeUrl}: ${err.message}` };
      return { error: `Fetch ${homeUrl} failed: ${err.message}` };
    }
    const head = html.slice(0, 60_000);
    const gtmMatch = head.match(/GTM-[A-Z0-9]+/);
    const ga4Match = head.match(/G-[A-Z0-9]{6,}/);
    const fbqMatch = head.match(/fbq\(['"]init['"],\s*['"](\d+)['"]/);
    let expected = null;
    if (ctx.clientUserId) {
      const cfg = await query(
        `SELECT gtm_container_id, ga4_measurement_id, meta_pixel_id
           FROM tracking_configs WHERE user_id = $1 LIMIT 1`,
        [ctx.clientUserId]
      ).catch(() => ({ rows: [] }));
      expected = cfg.rows[0] || null;
    }
    return {
      home_url: homeUrl,
      blogname: blogname.stdout.trim(),
      gtm_present: Boolean(gtmMatch),
      gtm_id_found: gtmMatch?.[0] || null,
      ga4_present: Boolean(ga4Match),
      ga4_id_found: ga4Match?.[0] || null,
      fb_pixel_present: Boolean(fbqMatch),
      fb_pixel_id_found: fbqMatch?.[1] || null,
      expected,
      gtm_match: expected?.gtm_container_id ? gtmMatch?.[0] === expected.gtm_container_id : null,
      ga4_match: expected?.ga4_measurement_id ? ga4Match?.[0] === expected.ga4_measurement_id : null
    };
  }
};

// ---------------- new read-only tools ----------------

const psi_run_now = {
  declaration: {
    name: 'psi_run_now',
    description: 'Run a single PSI (PageSpeed Insights) check now for a URL. Returns mobile metrics (LCP/CLS/INP/scores).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL including scheme. Required.' },
        strategy: { type: 'string', description: 'mobile (default) or desktop' }
      },
      required: ['url']
    }
  },
  mutating: false,
  async handler(args) {
    const url = String(args.url || '').trim();
    const strategy = (args.strategy || 'mobile').toLowerCase();
    if (!/^https?:\/\//i.test(url)) return { error: 'url must include scheme' };
    try {
      await assertPublicHttpUrl(url);
    } catch (err) {
      return { error: `Refused: ${err.message}` };
    }
    const apiKey = process.env.PSI_API_KEY || null;
    const psiUrl = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    psiUrl.searchParams.set('url', url);
    psiUrl.searchParams.set('strategy', strategy);
    psiUrl.searchParams.append('category', 'PERFORMANCE');
    psiUrl.searchParams.append('category', 'SEO');
    if (apiKey) psiUrl.searchParams.set('key', apiKey);
    const res = await safeHttpFetch(psiUrl.toString(), { timeoutMs: 60000, maxBytes: 2_000_000 });
    if (res.status >= 400) return { error: `PSI returned ${res.status}` };
    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch (err) {
      return { error: `PSI parse failed: ${err.message}` };
    }
    const lh = parsed?.lighthouseResult || {};
    const audits = lh.audits || {};
    const cats = lh.categories || {};
    return {
      url,
      strategy,
      lcp_ms: audits['largest-contentful-paint']?.numericValue ?? null,
      cls: audits['cumulative-layout-shift']?.numericValue ?? null,
      inp_ms:
        audits['interaction-to-next-paint']?.numericValue ??
        audits['experimental-interaction-to-next-paint']?.numericValue ??
        null,
      performance_score: cats.performance?.score ?? null,
      seo_score: cats.seo?.score ?? null
    };
  }
};

const gsc_query = {
  declaration: {
    name: 'gsc_query',
    description:
      'Query Search Console performance data for the picked client. Requires the client to have a Search Console OAuth connection (Phase 3 scaffold).',
    parameters: {
      type: 'object',
      properties: {
        site_url: { type: 'string', description: 'sc-domain:example.com or https://example.com/' },
        dimensions: { type: 'array', items: { type: 'string' }, description: 'e.g. ["query","page"]' },
        days: { type: 'integer', description: 'Lookback days, default 28' },
        row_limit: { type: 'integer', description: 'Max 100, default 25' }
      }
    }
  },
  mutating: false,
  async handler(args, ctx) {
    if (!ctx.clientUserId) return { error: 'No client picked' };
    let gscModule;
    try {
      gscModule = await import('../../checks/website/gsc.js');
    } catch (err) {
      return { error: `GSC module unavailable: ${err.message}` };
    }
    if (typeof gscModule.runGscQuery !== 'function') {
      return {
        error:
          'gsc_query is scaffolded but the underlying GSC module does not expose runGscQuery yet. The Search Console OAuth flow lands in Phase 8.'
      };
    }
    const days = Math.max(1, Math.min(90, args.days || 28));
    const rowLimit = Math.max(1, Math.min(100, args.row_limit || 25));
    const dimensions = Array.isArray(args.dimensions) && args.dimensions.length ? args.dimensions : ['query'];
    try {
      return await gscModule.runGscQuery({
        clientUserId: ctx.clientUserId,
        siteUrl: args.site_url || null,
        dimensions,
        days,
        rowLimit
      });
    } catch (err) {
      return { error: err.message || 'GSC query failed' };
    }
  }
};

const semrush_keyword_lookup = {
  declaration: {
    name: 'semrush_keyword_lookup',
    description: 'Look up SEMrush data for one keyword on a domain (volume + position if ranking).',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        keyword: { type: 'string' },
        database: { type: 'string', description: "Default 'us'" }
      },
      required: ['domain', 'keyword']
    }
  },
  mutating: false,
  async handler(args) {
    const apiKey = process.env.SEMRUSH_API_KEY;
    if (!apiKey) return { error: 'SEMRUSH_API_KEY not configured' };
    const domain = String(args.domain || '').trim();
    const keyword = String(args.keyword || '').trim();
    if (!domain || !keyword) return { error: 'domain and keyword required' };
    const database = String(args.database || 'us').trim();
    const url = new URL('https://api.semrush.com/');
    url.searchParams.set('type', 'phrase_this');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('phrase', keyword);
    url.searchParams.set('database', database);
    url.searchParams.set('export_columns', 'Ph,Nq,Cp,Co,Nr,Td');
    try {
      const res = await safeHttpFetch(url.toString(), { timeoutMs: 15000, maxBytes: 200_000 });
      if (res.status >= 400) return { error: `SEMrush returned ${res.status}` };
      const lines = String(res.body || '').trim().split('\n');
      if (lines.length < 2) return { keyword, found: false, raw: lines[0] || '' };
      const header = lines[0].split(';');
      const data = lines[1].split(';');
      const out = {};
      header.forEach((h, i) => {
        out[h] = data[i];
      });
      return { keyword, domain, database, ...out };
    } catch (err) {
      return { error: err.message || 'SEMrush fetch failed' };
    }
  }
};

// ---------------- mutating tools (proposal-only via supervisor.propose_action) ----------------

const plugin_update = {
  declaration: {
    name: 'plugin_update',
    description: 'Update one or more plugins. Pass dry_run=true to preview without changing anything.',
    parameters: {
      type: 'object',
      properties: {
        env_id: { type: 'string' },
        slug: { type: 'string' },
        dry_run: { type: 'boolean' }
      },
      required: ['slug']
    }
  },
  mutating: true,
  async handler(args, ctx) {
    const envId = await envIdFromArgs(args, ctx);
    const slug = String(args.slug || '').trim();
    if (!slug) return { error: 'slug required' };
    const flag = args.dry_run ? ' --dry-run' : '';
    const target = slug === 'all' ? '--all' : slug;
    const res = await wpcli(envId, `plugin update ${target}${flag}`, {
      userId: ctx.userId,
      triggeredBy: 'agent:website'
    });
    return {
      exit_code: res.exitCode,
      stdout: (res.stdout || '').slice(0, 4000),
      stderr: (res.stderr || '').slice(0, 2000)
    };
  }
};

const wp_user_password_reset = {
  declaration: {
    name: 'wp_user_password_reset',
    description:
      'Reset a WordPress user password to a new strong random value. The new password is returned in the result so the admin can hand it off securely.',
    parameters: {
      type: 'object',
      properties: {
        env_id: { type: 'string' },
        user_login_or_id: { type: 'string', description: 'wp user login or numeric ID' }
      },
      required: ['user_login_or_id']
    }
  },
  mutating: true,
  async handler(args, ctx) {
    const envId = await envIdFromArgs(args, ctx);
    const target = String(args.user_login_or_id || '').trim();
    if (!target) return { error: 'user_login_or_id required' };
    if (!/^[A-Za-z0-9_.@-]{1,60}$/.test(target)) return { error: 'invalid user identifier' };
    const newPassword = (await import('node:crypto'))
      .randomBytes(18)
      .toString('base64')
      .replace(/[/+=]/g, '')
      .slice(0, 20);
    const res = await wpcli(envId, `user update ${target} --user_pass=${newPassword}`, {
      userId: ctx.userId,
      triggeredBy: 'agent:website'
    });
    if (res.exitCode !== 0) {
      return { error: res.stderr || 'wp-cli failed', exit_code: res.exitCode };
    }
    return {
      ok: true,
      user_login_or_id: target,
      new_password: newPassword,
      note: 'Hand this password to the user via a secure channel; rotate again after they log in.'
    };
  }
};

// ---------------- registry ----------------

const TOOLS = {
  plugin_list,
  list_recent_posts,
  wpcli_read,
  sftp_read,
  verify_tracking_install,
  psi_run_now,
  gsc_query,
  semrush_keyword_lookup,
  plugin_update,
  wp_user_password_reset
};

export const websiteTools = {
  list() {
    return Object.values(TOOLS).map((t) => t.declaration);
  },
  get(name) {
    return TOOLS[name] || null;
  }
};
