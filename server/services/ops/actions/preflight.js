/**
 * Preflight: fetch current provider state + blast radius before any mutation.
 * Read-only — delegates to the F1 connector contract actions.preflight. Never throws.
 */
export async function runPreflight({ providerActionType, actionArgs = {}, connector, ctx = {} }) {
  const pf = connector?.actions?.preflight;
  if (typeof pf !== 'function') {
    return { ok: false, currentState: null, blastRadius: 0, warnings: [], error: 'connector does not implement actions.preflight' };
  }
  try {
    const res = (await pf(providerActionType, actionArgs, ctx)) || {};
    const blastRadius = Number.isFinite(res.assetsAffected) ? res.assetsAffected : 1;
    return { ok: true, currentState: res.currentState ?? null, blastRadius, warnings: Array.isArray(res.warnings) ? res.warnings : [] };
  } catch (err) {
    return { ok: false, currentState: null, blastRadius: 0, warnings: [], error: err?.message || String(err) };
  }
}

export default { runPreflight };
