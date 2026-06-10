import { query } from '../db.js';

let cachedHasSuperadmin = null;
let lastCheckedAt = 0;
const CACHE_TTL_MS = 60_000;

async function detectHasSuperadmin() {
  const now = Date.now();
  if (cachedHasSuperadmin !== null && now - lastCheckedAt < CACHE_TTL_MS) return cachedHasSuperadmin;
  const { rows } = await query("SELECT 1 FROM users WHERE role = 'superadmin' LIMIT 1");
  cachedHasSuperadmin = rows.length > 0;
  lastCheckedAt = now;
  return cachedHasSuperadmin;
}

/**
 * Backward compatible role mapping:
 * - legacy 'editor' -> 'admin'
 * - legacy 'admin' -> 'superadmin' (only while no real 'superadmin' exists yet)
 *
 * After running the DB migration (admin->superadmin, editor->admin):
 * - 'superadmin' remains 'superadmin'
 * - 'admin' remains 'admin'
 */
export async function getEffectiveRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (!value) return 'client';
  if (value === 'editor') return 'admin';
  if (value === 'admin') {
    const hasSuper = await detectHasSuperadmin();
    return hasSuper ? 'admin' : 'superadmin';
  }
  return value;
}


