/**
 * Tool registry for the legacy Operations AI agent.
 *
 * @deprecated Phase 7 split agent tooling into per-domain modules under
 * `server/services/ops/agents/subAgents/*Tools.js`. This file is retained
 * because `bulkRunner.js` and `driftScanner.js` still call `getTool()` for the
 * `verify_tracking_install` and `wpcli_read` tool handlers. Do NOT add new
 * tools here — register them in the appropriate sub-agent module instead.
 *
 * Phase 10 follow-up: refactor bulkRunner / driftScanner to call the new
 * sub-agent tool handlers directly, then delete this file.
 *
 * Each tool has:
 *   - declaration: Vertex function-call schema
 *   - handler:     async (args, ctx) => result   (executes the tool)
 *   - mutating:    bool — when true, the tool returns a proposal first;
 *                  it only runs after the admin approves in the UI.
 */

import { wpcli, withSftp } from './sshClient.js';
import { query } from '../../../db.js';
import https from 'node:https';
import http from 'node:http';
import { assertPublicHttpUrl, SsrfBlockedError } from '../../security/ssrfGuard.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveLiveEnv(siteId) {
  const { rows } = await query(
    `SELECT id FROM kinsta_environments
       WHERE site_id = $1 AND is_live = TRUE
       ORDER BY created_at ASC LIMIT 1`,
    [siteId]
  );
  if (!rows[0]) throw new Error('Site has no live environment');
  return rows[0].id;
}

async function envIdFromArgs(args, ctx) {
  const candidate = args.env_id || ctx.envId;
  if (candidate && UUID_RE.test(candidate)) return candidate;
  if (ctx.siteId) return resolveLiveEnv(ctx.siteId);
  throw new Error('env_id required (or set siteId on context)');
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
    description: 'List active and inactive plugins on the site.',
    parameters: {
      type: 'object',
      properties: {
        env_id: { type: 'string', description: 'Optional environment UUID; defaults to live env of current site.' }
      }
    }
  },
  mutating: false,
  async handler(args, ctx) {
    const envId = await envIdFromArgs(args, ctx);
    const res = await wpcli(envId, 'plugin list --format=json', { userId: ctx.userId, triggeredBy: `agent:${ctx.agentType}` });
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
        limit: { type: 'integer', description: 'Default 10, max 50' },
        post_type: { type: 'string', description: 'Default any' }
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
      { userId: ctx.userId, triggeredBy: `agent:${ctx.agentType}` }
    );
    if (res.exitCode !== 0) return { error: res.stderr || 'wp-cli failed' };
    try {
      return { posts: JSON.parse(res.stdout) };
    } catch {
      return { error: 'Could not parse posts', stdout_preview: res.stdout.slice(0, 500) };
    }
  }
};

// Whitelist of WP-CLI <command> <subcommand?> pairs that are read-only.
// Fail-closed: anything not on this list is refused. If a command takes no
// subcommand (e.g. `wp cli version`), only the verb is required.
//
// Each entry is either a verb string ("cli", matches any subcommand on that
// verb) or a "verb subcommand" pair ("plugin list").
const WPCLI_READ_ONLY_VERBS = new Set([
  // top-level read-only verbs (any subcommand allowed but typically informational)
  'cli',
  'help',
  // verbs locked to specific safe subcommands
  'core check-update',
  'core is-installed',
  'core verify-checksums',
  'core version',
  'plugin list',
  'plugin get',
  'plugin is-installed',
  'plugin path',
  'plugin status',
  'plugin verify-checksums',
  'theme list',
  'theme get',
  'theme is-installed',
  'theme path',
  'theme status',
  'option get',
  'option list',
  'option pluck',
  'post list',
  'post get',
  'post meta get',
  'post meta list',
  'user list',
  'user get',
  'user meta get',
  'user meta list',
  'site list',
  'transient get',
  'transient list',
  'cron event list',
  'cron schedule list',
  'rewrite list',
  'role list',
  'cap list',
  'menu list',
  'comment list',
  'comment get',
  'term list',
  'term get',
  'sidebar list',
  'widget list',
  'language core list',
  'language plugin list',
  'language theme list',
  'package list',
  'config get',
  'config list',
  'config has',
  'config path',
  'maintenance-mode status',
  'db size',
  'db tables',
  'db columns',
  'db prefix',
  'db check',
  'media-image-size'
]);

// Hard deny-list — even if a token chain looks safe, refuse outright.
// These are subcommands that shadow read-only verbs but mutate state.
const WPCLI_HARD_DENY_PAIRS = new Set([
  'site empty',
  'eval',
  'eval-file',
  'shell',
  'db query',
  'db drop',
  'db reset',
  'db import',
  'db export'
]);

function classifyWpcliRead(cmd) {
  // Tokenize, stripping flags (any token starting with `-`).
  const tokens = String(cmd || '')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith('-'));
  if (!tokens.length) return { ok: false, reason: 'empty command' };

  const verb = tokens[0].toLowerCase();
  const sub = (tokens[1] || '').toLowerCase();
  const subSub = (tokens[2] || '').toLowerCase();

  const pairOne = verb;
  const pairTwo = sub ? `${verb} ${sub}` : verb;
  const pairThree = subSub ? `${verb} ${sub} ${subSub}` : pairTwo;

  // Hard deny list takes priority.
  for (const denied of [pairOne, pairTwo, pairThree]) {
    if (WPCLI_HARD_DENY_PAIRS.has(denied)) {
      return { ok: false, reason: `Refused: \`wp ${denied}\` is destructive` };
    }
  }

  // Allow if any parsed prefix is on the read-only list. Matching the
  // longest prefix first lets us allow things like `plugin list --format=json`
  // while keeping `plugin install …` blocked.
  for (const candidate of [pairThree, pairTwo, pairOne]) {
    if (WPCLI_READ_ONLY_VERBS.has(candidate)) return { ok: true };
  }

  return {
    ok: false,
    reason: `Refused: \`wp ${pairTwo}\` is not on the read-only allowlist. Use a mutating tool with approval.`
  };
}

const wpcli_read = {
  declaration: {
    name: 'wpcli_read',
    description:
      'Run a READ-ONLY WP-CLI command (list, get, search, status, --info). Tokenized allowlist: only known read-only verbs pass; everything else is refused.',
    parameters: {
      type: 'object',
      properties: {
        env_id: { type: 'string' },
        args: { type: 'string', description: 'WP-CLI args after `wp `, e.g. "option get blogname"' }
      },
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
    const res = await wpcli(envId, cmd, { userId: ctx.userId, triggeredBy: `agent:${ctx.agentType}` });
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
    description: 'Read a small file from the site via SFTP. Refuses reads of files larger than 256 KB or paths that look like uploads/PHI.',
    parameters: {
      type: 'object',
      properties: {
        env_id: { type: 'string' },
        path: { type: 'string', description: 'Absolute path on the server' }
      },
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
      { userId: ctx.userId, triggeredBy: `agent:${ctx.agentType}` }
    );
  }
};

const verify_tracking_install = {
  declaration: {
    name: 'verify_tracking_install',
    description:
      'Verify that GTM and GA4 tracking are installed by curling the homepage and reading the WP options. Cross-references against tracking_configs for this client when available.',
    parameters: {
      type: 'object',
      properties: { env_id: { type: 'string' } }
    }
  },
  mutating: false,
  async handler(args, ctx) {
    const envId = await envIdFromArgs(args, ctx);
    const opts = { userId: ctx.userId, triggeredBy: `agent:${ctx.agentType}` };
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
      if (err instanceof SsrfBlockedError) {
        return { error: `Refused to fetch ${homeUrl}: ${err.message}` };
      }
      return { error: `Fetch ${homeUrl} failed: ${err.message}` };
    }

    const head = html.slice(0, 60_000);
    const gtmMatch = head.match(/GTM-[A-Z0-9]+/);
    const ga4Match = head.match(/G-[A-Z0-9]{6,}/);
    const fbqMatch = head.match(/fbq\(['"]init['"],\s*['"](\d+)['"]/);

    // Cross-ref against tracking_configs (best-effort: site → linked client → config)
    let expected = null;
    if (ctx.siteId) {
      const cfg = await query(
        `SELECT tc.gtm_container_id, tc.ga4_measurement_id, tc.meta_pixel_id
           FROM tracking_configs tc
           JOIN kinsta_site_clients ksc ON ksc.client_user_id = tc.user_id
          WHERE ksc.site_id = $1
          LIMIT 1`,
        [ctx.siteId]
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

// ---------------- mutating tools (require approval) ----------------

const plugin_update = {
  declaration: {
    name: 'plugin_update',
    description: 'Update one or more plugins. Pass dry_run=true to preview without changing anything.',
    parameters: {
      type: 'object',
      properties: {
        env_id: { type: 'string' },
        slug: { type: 'string', description: 'Plugin slug, or "all" to update all available updates' },
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
      triggeredBy: `agent:${ctx.agentType}`
    });
    return {
      exit_code: res.exitCode,
      stdout: (res.stdout || '').slice(0, 4000),
      stderr: (res.stderr || '').slice(0, 2000)
    };
  }
};

// NOTE: `divi_safe_update` was removed during Phase 0 stabilization. It was a
// stub that always errored and polluted Vertex's tool planning. Will be
// reintroduced if/when the divi-safe mu-plugin actually ships.

// ---------------- registry ----------------

const TOOLS = {
  plugin_list,
  list_recent_posts,
  wpcli_read,
  sftp_read,
  verify_tracking_install,
  plugin_update
};

export function listToolDeclarations() {
  return Object.values(TOOLS).map((t) => t.declaration);
}

export function getTool(name) {
  return TOOLS[name] || null;
}

export function isToolMutating(name) {
  return Boolean(TOOLS[name]?.mutating);
}
