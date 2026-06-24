import './loadEnv.js';

import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'path';

import cron from 'node-cron';
import authRouter from './auth.js';
import opsRouter from './routes/ops.js';
import operationsRouter from './routes/operations.js';
import socialRouter from './routes/social.js';
import { attachOperationsWebSocket } from './ws/operationsTerminal.js';
import { runOpsMigrations } from './migrations.js';
import { isDemoMode } from './services/demoMode.js';
import { runDuePosts } from './services/socialPublisher.js';
import { runDueBlogPosts } from './services/ops/blog/blogPublisher.js';
import { healthCheckPage } from './services/metaPagePosting.js';
import { query } from './db.js';

const app = express();
// Cloud Run sets PORT=8080; prefer it over API_SERVER_PORT.
const PORT = process.env.PORT || process.env.API_SERVER_PORT || 4000;
const NODE_ENV = process.env.NODE_ENV || 'development';
// Silence verbose logging in production to cut Cloud Logging costs.
// console.error / console.warn survive for operational visibility.
if (NODE_ENV === 'production') console.log = () => {};
const RUN_MIGRATIONS = process.env.RUN_MIGRATIONS_ON_START ?? (NODE_ENV === 'production' ? 'true' : 'false');
const CLIENT_BUILD_DIR = path.resolve(process.cwd(), 'dist');

// Crash visibility: surface async crashes so Cloud Run doesn't just 503.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// CSP. Secure by default; allow jsdelivr for the Monaco editor (skills / site
// assistant) bundle + workers, and fbcdn/facebook hosts for Meta ad creative
// previews surfaced in findings.
// ---------------------------------------------------------------------------
const CSP_FRAME_SRC = (process.env.CSP_FRAME_SRC || '').split(',').map((s) => s.trim()).filter(Boolean);
const CSP_IMG_SRC = (process.env.CSP_IMG_SRC || '').split(',').map((s) => s.trim()).filter(Boolean);

const baseCspDirectives = {
  'default-src': ["'self'"],
  'script-src': ["'self'", 'https://cdn.jsdelivr.net'],
  'script-src-elem': ["'self'", 'https://cdn.jsdelivr.net'],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
  'style-src-elem': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
  'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
  'img-src': ["'self'", 'data:', 'blob:', 'https://*.fbcdn.net', 'https://*.facebook.com', ...CSP_IMG_SRC],
  'media-src': ["'self'", 'blob:', 'data:', 'https://*.fbcdn.net', 'https://*.facebook.com'],
  'connect-src': ["'self'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
  'worker-src': ["'self'", 'blob:', 'https://cdn.jsdelivr.net'],
  'child-src': ["'self'", 'blob:'],
  'frame-src': ["'self'", ...CSP_FRAME_SRC]
};

// ---------------------------------------------------------------------------
// CORS allowlist.
// ---------------------------------------------------------------------------
function normalizeOrigin(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.replace(/\/$/, '');
}

const allowedOrigins = (() => {
  const selfOrigin = `http://localhost:${PORT}`;
  const defaults = ['http://localhost:3000', 'http://localhost:4173', selfOrigin];
  const fromEnv = (process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  const appBase = [process.env.APP_BASE_URL, process.env.CLIENT_APP_URL].filter(Boolean);
  return new Set([...defaults, ...fromEnv, ...appBase].map(normalizeOrigin).filter(Boolean));
})();

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // non-browser / same-origin
    if (allowedOrigins.has(normalizeOrigin(origin))) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
};

// Core middleware before routers so bodies/cookies are available.
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(
  helmet({
    contentSecurityPolicy: { useDefaults: false, directives: baseCspDirectives }
  })
);

// Liveness probe — must respond before migrations run (Cloud Run health check).
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'anchor-ops', env: NODE_ENV }));

// API routes. SSO: every ops route validates the shared JWT + admin role.
app.use('/api/auth', authRouter);
app.use('/api/ops', opsRouter); // Operations command center (rebuild)
app.use('/api/operations', operationsRouter); // Legacy Kinsta site/SSH/bulk endpoints
app.use('/api/social', socialRouter); // Content suite — FB/IG publishing (ported from main app)

// Avatars live in the shared users table as `/api/hub/users/:id/avatar` paths and
// are served by the dashboard's public avatar route. Redirect those requests there.
app.get('/api/hub/users/:id/avatar', (req, res) => {
  const main = (process.env.MAIN_APP_URL || '').replace(/\/$/, '');
  if (!main) return res.status(404).end();
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  return res.redirect(302, `${main}/api/hub/users/${encodeURIComponent(req.params.id)}/avatar${qs}`);
});

// Serve the built SPA (production) with a catch-all for client-side routing.
app.use(express.static(CLIENT_BUILD_DIR));
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(CLIENT_BUILD_DIR, 'index.html'), (err) => {
    if (err) next();
  });
});

// ---------------------------------------------------------------------------
// Bind the port FIRST so Cloud Run's health check succeeds, then run migrations
// and start background work (non-blocking).
// ---------------------------------------------------------------------------
const httpServer = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`anchor-ops API listening on http://localhost:${PORT} (${NODE_ENV})`);

  if (String(RUN_MIGRATIONS) === 'true') {
    runOpsMigrations().catch((err) => {
      console.error('[migrations] failed (server still running):', err?.message || err);
    });
  } else {
    console.warn('[migrations] skipped on start (RUN_MIGRATIONS_ON_START != true); run `yarn db:migrate`');
  }

  // Bulk-schedule fan-out tick. Scheduled run fan-out in production runs via
  // Cloud Scheduler -> Pub/Sub -> the ops-runner Job; this in-process tick covers
  // the ops_bulk_schedules table the way the source app did.
  if (!isDemoMode()) {
    setInterval(() => {
      tickBulkSchedules().catch(() => {});
    }, 60_000);
  }

  if (!isDemoMode()) {
    // Content suite — publish due social posts. runDuePosts() claims rows with
    // FOR UPDATE SKIP LOCKED, so this is the single publisher (cron lives only here).
    cron.schedule('*/2 * * * *', async () => {
      try {
        await runDuePosts();
      } catch (e) {
        console.error('[cron:social-publish]', e?.message);
      }
    }, { timezone: 'America/New_York' });

    // Content suite — publish due blog posts to clients' WordPress sites.
    cron.schedule('*/2 * * * *', async () => {
      try {
        await runDueBlogPosts();
      } catch (e) {
        console.error('[cron:blog-publish]', e?.message);
      }
    }, { timezone: 'America/New_York' });

    // Content suite — daily health-check of every active page link so token
    // problems surface in the UI before a scheduled post fails.
    cron.schedule('0 4 * * *', async () => {
      try {
        const { rows } = await query('SELECT id FROM meta_page_links WHERE archived_at IS NULL');
        for (const r of rows) {
          try { await healthCheckPage(r.id); } catch (_) { /* tracked in DB */ }
        }
      } catch (e) {
        console.error('[cron:social-health]', e?.message);
      }
    }, { timezone: 'America/New_York' });

    backfillSocialClientLinks();
  }
});

// Content suite — one-shot backfill: auto-link clients with exactly one FB page.
async function backfillSocialClientLinks() {
  try {
    const { rows } = await query(
      `SELECT DISTINCT client_id
         FROM oauth_resources
        WHERE provider = 'facebook'
          AND resource_type = 'facebook_page'
          AND is_enabled = TRUE`
    );
    if (!rows.length) return;
    const { syncClientFacebookLinks } = await import('./services/socialClientLinkSync.js');
    let touched = 0;
    for (const r of rows) {
      try {
        const result = await syncClientFacebookLinks(r.client_id, { actorId: null });
        if (result.autoLinked) touched++;
      } catch (e) {
        console.error('[backfill:social-links] client', r.client_id, e?.message);
      }
    }
    if (touched > 0) {
      console.warn(`[backfill:social-links] auto-linked ${touched} clients`);
    }
  } catch (e) {
    console.error('[backfill:social-links] failed:', e?.message);
  }
}

async function tickBulkSchedules() {
  try {
    const mod = await import('./services/ops/scheduleFanout.js');
    const { query } = await import('./db.js');
    const { rows } = await query(`
      SELECT id, cadence, day_of_week, day_of_month, hour_local, timezone
        FROM ops_bulk_schedules
       WHERE enabled = TRUE AND (next_run_at IS NULL OR next_run_at <= now())
    `);
    for (const r of rows) {
      try {
        await mod.fanOutBulkSchedule(r.id);
        const next = mod.computeNextRunAt(r);
        await query('UPDATE ops_bulk_schedules SET next_run_at = $2 WHERE id = $1', [r.id, next]);
      } catch (e) {
        console.error('[bulk-tick] schedule failed', r.id, e?.message || e);
      }
    }
  } catch (e) {
    console.error('[bulk-tick]', e?.message || e);
  }
}

// WebSocket terminal for the Kinsta SSH/WP-CLI console.
attachOperationsWebSocket(httpServer);
