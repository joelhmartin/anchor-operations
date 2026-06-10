// server/services/demoMode.js
//
// Single source of truth for "is this process the demo deployment?".
// Driven by the DEMO_MODE env var, set ONLY on the anchor-hub-demo Cloud Run
// service (never in .env, never on prod). Used as a defense-in-depth kill-switch
// at outbound dispatch boundaries — the PRIMARY guard is that the demo service
// ships with no third-party credentials, so this is belt-and-suspenders.
export function isDemoMode() {
  return process.env.DEMO_MODE === 'true';
}
