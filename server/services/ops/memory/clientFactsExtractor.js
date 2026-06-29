/**
 * Extract memory-worthy facts from agent activity (F3, §2.9). PURE — takes plain
 * arrays, returns fact candidates; the orchestrator loads the arrays and persists.
 *
 * A fact candidate: { scope, fact_type, fact_key, fact_value, confidence, source }.
 */

export const FALSE_POSITIVE_MIN_RECURRENCE = 3;
export const STABLE_CONFIG_MIN_DAYS = 30;

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

export function factsFromApprovals(approvals = []) {
  const byTool = new Map();
  for (const a of approvals) {
    if (!a.approved_at || !a.executed_at) continue;
    const scope = a.scope || 'client';
    const k = `${scope}|${a.tool_name}`;
    const cur = byTool.get(k) || { scope, tool: a.tool_name, count: 0 };
    cur.count += 1;
    byTool.set(k, cur);
  }
  return [...byTool.values()].map((v) => ({
    scope: v.scope,
    fact_type: 'approved_pattern',
    fact_key: `approved:${v.tool}`,
    fact_value: { tool: v.tool, count: v.count },
    confidence: clamp01(0.5 + 0.1 * v.count),
    occurrences: v.count,
    source: 'learned'
  }));
}

export function factsFromRejections(rejections = []) {
  const byTool = new Map();
  for (const r of rejections) {
    const scope = r.scope || 'client';
    const k = `${scope}|${r.tool_name}`;
    const cur = byTool.get(k) || { scope, tool: r.tool_name, count: 0 };
    cur.count += 1;
    byTool.set(k, cur);
  }
  return [...byTool.values()].map((v) => ({
    scope: v.scope,
    fact_type: 'rejected_pattern',
    fact_key: `rejected:${v.tool}`,
    fact_value: { tool: v.tool, count: v.count },
    confidence: clamp01(0.5 + 0.1 * v.count),
    occurrences: v.count,
    source: 'learned'
  }));
}

export function factsFromRepeatedFindings(findings = []) {
  const out = [];
  for (const f of findings) {
    const occurrences = Number(f.occurrences) || 0;
    const dismissed = Number(f.dismissed_count) || 0;
    if (occurrences >= FALSE_POSITIVE_MIN_RECURRENCE && dismissed === occurrences) {
      out.push({
        scope: f.scope || 'client',
        fact_type: 'false_positive',
        fact_key: `false_positive:${f.category}`,
        fact_value: { category: f.category, occurrences, dismissed },
        confidence: clamp01(0.5 + 0.1 * occurrences),
        source: 'learned'
      });
    }
  }
  return out;
}

export function factsFromStableConfigs(configs = []) {
  return configs
    .filter((c) => (Number(c.days_stable) || 0) >= STABLE_CONFIG_MIN_DAYS)
    .map((c) => ({
      scope: c.scope || 'client',
      fact_type: 'stable_config',
      fact_key: `stable:${c.key}`,
      fact_value: { key: c.key, value: c.value, days_stable: c.days_stable },
      confidence: 0.7,
      source: 'learned'
    }));
}

export function factsFromManualNotes(notes = []) {
  return notes.map((n) => ({
    scope: n.scope || 'client',
    fact_type: 'manual_note',
    fact_key: n.fact_key || (n.id != null ? `note:${n.id}` : 'note:unkeyed'),
    fact_value: { text: n.text },
    confidence: 1,
    source: 'manual'
  }));
}

export function extractFacts({ approvals = [], rejections = [], findings = [], configs = [], notes = [] } = {}) {
  const all = [
    ...factsFromApprovals(approvals),
    ...factsFromRejections(rejections),
    ...factsFromRepeatedFindings(findings),
    ...factsFromStableConfigs(configs),
    ...factsFromManualNotes(notes)
  ];
  const byKey = new Map();
  for (const f of all) {
    const k = `${f.scope}|${f.fact_type}|${f.fact_key}`;
    const existing = byKey.get(k);
    if (!existing || f.confidence > existing.confidence) byKey.set(k, f);
  }
  return [...byKey.values()];
}
