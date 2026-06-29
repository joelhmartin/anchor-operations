/** Pure finding grouper. Collapses findings by (client_user_id, category). */
const SEV_RANK = { critical: 3, warning: 2, info: 1 };

function maxSeverity(a, b) {
  return (SEV_RANK[a] || 0) >= (SEV_RANK[b] || 0) ? a : b;
}

export function groupFindings(findings, { maxGroups = 20 } = {}) {
  if (!Array.isArray(findings) || findings.length === 0) return [];
  const byKey = new Map();
  for (const row of findings) {
    const clientUserId = row.client_user_id;
    const category = row.category || 'uncategorized';
    const key = `${clientUserId}::${category}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, clientUserId, category, affectedPlatforms: new Set(), severity: 'info', findingIds: [], findings: [] };
      byKey.set(key, g);
    }
    g.findingIds.push(row.id);
    g.findings.push(row);
    g.severity = maxSeverity(g.severity, row.severity || 'info');
    for (const p of row.affected_platforms || []) g.affectedPlatforms.add(p);
  }
  const groups = Array.from(byKey.values()).map((g) => ({
    ...g,
    affectedPlatforms: Array.from(g.affectedPlatforms).sort()
  }));
  groups.sort((a, b) => (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0));
  return groups.slice(0, maxGroups);
}

export default { groupFindings };
