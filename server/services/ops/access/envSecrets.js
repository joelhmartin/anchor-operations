/**
 * Pure credential-presence audit. Reports variable NAMES + booleans only —
 * never values (north-star §0.2: do not expose secrets).
 */
import { REQUIRED_CREDENTIALS } from './requiredCredentials.js';

export { REQUIRED_CREDENTIALS };

const isSet = (env, name) => typeof env[name] === 'string' && env[name].trim() !== '';

export function checkCredentialPresence(env = {}, spec = {}) {
  const present = [];
  const missing = [];
  const optionalMissing = [];

  for (const name of spec.required || []) {
    (isSet(env, name) ? present : missing).push(name);
  }
  if (spec.anyOf && spec.anyOf.length) {
    const hit = spec.anyOf.find((n) => isSet(env, n));
    if (hit) present.push(hit);
    else missing.push(spec.anyOf.join('|'));
  }
  for (const name of spec.optional || []) {
    (isSet(env, name) ? present : optionalMissing).push(name);
  }

  let status;
  if (missing.length) status = 'missing';
  else if (optionalMissing.length) status = 'degraded';
  else status = 'verified';

  return { status, present, missing, optionalMissing };
}

export function auditCredentials(env = {}, map = REQUIRED_CREDENTIALS) {
  const services = {};
  const missing = [];
  for (const [service, spec] of Object.entries(map)) {
    const r = checkCredentialPresence(env, spec);
    services[service] = r;
    for (const m of r.missing) missing.push(`${service}: ${m}`);
  }
  return { services, missing };
}
