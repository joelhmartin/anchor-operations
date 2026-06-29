/**
 * Pure abstract-action factory. Maps a finding category to a provider-neutral
 * abstract action (e.g. website.clear_cache). Destructive actions are NOT mapped
 * in this phase (spec §8) — unmapped categories stay advisory (null action).
 */
export const CATEGORY_ACTION_MAP = {
  'correlation.gtm_missing_with_kinsta_drift': {
    abstractActionType: 'website.clear_cache',
    mutating: true,
    destructive: false,
    budgetDeltaCents: 0,
    buildArgs: () => ({ scope: 'full' })
  },
  'correlation.tracking_loss_with_conversion_drop': {
    abstractActionType: 'website.clear_cache',
    mutating: true,
    destructive: false,
    budgetDeltaCents: 0,
    buildArgs: () => ({ scope: 'full' })
  }
};

export function buildAbstractAction(group = {}) {
  const def = CATEGORY_ACTION_MAP[group.category];
  if (!def) {
    return { abstractActionType: null, actionArgs: {}, mutating: false, destructive: false, budgetDeltaCents: 0 };
  }
  return {
    abstractActionType: def.abstractActionType,
    actionArgs: typeof def.buildArgs === 'function' ? def.buildArgs(group) : {},
    mutating: Boolean(def.mutating),
    destructive: Boolean(def.destructive),
    budgetDeltaCents: Number.isFinite(def.budgetDeltaCents) ? def.budgetDeltaCents : 0
  };
}

export default { buildAbstractAction, CATEGORY_ACTION_MAP };
