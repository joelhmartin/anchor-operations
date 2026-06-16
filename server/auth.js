/**
 * Auth routes (Task Manager — SSO consumer)
 *
 * Login/MFA/password/session lifecycle live in the MAIN app (anchor-hub). This
 * router only needs to:
 *   - GET  /me       → return the current user for the verified access token
 *   - POST /refresh  → slide a still-valid access token (stateless; no session store)
 *   - POST /logout   → clear the local cookie
 *   - POST /login    → DEV ONLY: mint a token for a seeded user so the app is usable
 *                      locally before the cross-app SSO handshake is wired up.
 *
 * In production, the main app is the source of access tokens (it signs them with the
 * shared JWT_SECRET); set DEV_LOGIN=false to disable the local /login shim.
 */

import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';

import { query } from './db.js';
import { requireAuth } from './middleware/auth.js';
import { signAccessToken, verifyAccessToken } from './services/security/index.js';
import { getEffectiveRole } from './utils/roles.js';

const router = Router();

const NODE_ENV = process.env.NODE_ENV || 'development';
// Local login shim is enabled outside production unless explicitly toggled.
const DEV_LOGIN = process.env.DEV_LOGIN
  ? process.env.DEV_LOGIN === 'true'
  : NODE_ENV !== 'production';

const USER_COLUMNS = 'id, first_name, last_name, email, role, avatar_url, created_at';

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 // 1h; access token itself expires sooner
  };
}

async function withEffectiveRole(user) {
  const effectiveRole = await getEffectiveRole(user.role);
  return { ...user, effective_role: effectiveRole };
}

/** Current authenticated user. */
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

/** Slide a still-valid token. Stateless: there is no server-side session to consult. */
router.post('/refresh', async (req, res) => {
  const headerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.substring(7)
    : null;
  const token = req.cookies?.session || headerToken;
  const payload = token ? verifyAccessToken(token) : null;
  if (!payload) {
    return res.status(401).json({ message: 'Re-authenticate via the main app.', code: 'SSO_REFRESH_REQUIRED' });
  }
  const sessionId = payload.sessionId || crypto.randomUUID();
  const accessToken = signAccessToken({
    userId: payload.userId,
    sessionId,
    role: payload.role,
    effectiveRole: payload.effectiveRole
  });
  res.cookie('session', accessToken, cookieOptions());

  // Return the user too — the frontend AuthContext bootstraps from /refresh.
  const { rows } = await query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 LIMIT 1`, [payload.userId]);
  const user = rows[0] ? await withEffectiveRole(rows[0]) : null;
  res.json({ accessToken, user });
});

/** Clear the local session cookie. */
router.post('/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

/**
 * DEV ONLY — mint an access token for a (seeded) user by email.
 * Disabled in production (set DEV_LOGIN=true to force-enable).
 */
router.post('/login', async (req, res) => {
  if (!DEV_LOGIN) {
    return res.status(404).json({ message: 'Login is handled by the main app (SSO).', code: 'SSO_LOGIN' });
  }
  const schema = z.object({ email: z.string().email() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ message: 'A valid email is required.', code: 'BAD_REQUEST' });
  }
  const { email } = parsed.data;

  // Users are shared (and read-only here) — dev login signs in an EXISTING user
  // by email; it never creates identities.
  const { rows } = await query(`SELECT ${USER_COLUMNS} FROM users WHERE email = $1 LIMIT 1`, [email]);
  if (!rows[0]) {
    return res.status(404).json({ message: 'No user with that email. Dev login only works for existing users.', code: 'USER_NOT_FOUND' });
  }
  const user = await withEffectiveRole(rows[0]);
  const sessionId = crypto.randomUUID();
  const accessToken = signAccessToken({
    userId: user.id,
    sessionId,
    role: user.role,
    effectiveRole: user.effective_role
  });
  res.cookie('session', accessToken, cookieOptions());
  res.json({ user, accessToken });
});

export default router;
