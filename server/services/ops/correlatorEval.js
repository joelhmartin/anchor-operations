/**
 * DB-free rule evaluator — extracted from correlator.js so the pure
 * `evaluateRules` function can be imported and unit-tested without a
 * DATABASE_URL.  `correlator.js` re-exports `evaluateRules` from here so
 * its public API is unchanged.
 */

import RULES from './correlatorRules.js';

export { RULES };

/**
 * Pure evaluator (no DB I/O). Given a checks array, returns an array of
 * finding bodies (NOT yet persisted).
 *
 * @param {{ checks: object[], rules?: object[] }} options
 * @returns {object[]}
 */
export function evaluateRules({ checks, rules = RULES }) {
  const findings = [];
  for (const rule of rules) {
    let matched = false;
    try {
      matched = Boolean(rule.when({ checks }));
    } catch (err) {
      console.warn(`[ops/correlator] rule ${rule.name} when() threw: ${err.message}`);
      matched = false;
    }
    if (!matched) continue;

    let summary = rule.name;
    let evidence = {};
    let linkedCheckResultIds = [];
    try {
      summary = rule.summary({ checks });
    } catch (err) {
      console.warn(`[ops/correlator] rule ${rule.name} summary() threw: ${err.message}`);
    }
    try {
      evidence = rule.evidence({ checks }) || {};
    } catch (err) {
      console.warn(`[ops/correlator] rule ${rule.name} evidence() threw: ${err.message}`);
    }
    try {
      linkedCheckResultIds = (rule.linkedCheckResultIds({ checks }) || []).filter(Boolean);
    } catch (err) {
      console.warn(`[ops/correlator] rule ${rule.name} linkedCheckResultIds() threw: ${err.message}`);
    }

    // `severity` may be a static string OR a function of the matched checks
    // (V5 snapshot anomaly mirrors the check's own warning/critical severity).
    let severity = rule.severity;
    if (typeof rule.severity === 'function') {
      try {
        severity = rule.severity({ checks });
      } catch (err) {
        console.warn(`[ops/correlator] rule ${rule.name} severity() threw: ${err.message}`);
        severity = 'warning';
      }
    }

    findings.push({
      name: rule.name,
      category: rule.category,
      severity,
      summary,
      evidence,
      linkedCheckResultIds
    });
  }
  return findings;
}
