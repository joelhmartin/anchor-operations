/**
 * PHI payload sanitizer — Phase 6 (defense in depth).
 *
 * Walks a check `payload_json` recursively and redacts strings that match
 * known PHI patterns. Numbers, booleans, nulls, and dates encoded as numeric
 * timestamps pass through untouched.
 *
 * The sanitizer is conservative: false-positive PHI matches are acceptable
 * (worse: a single value in evidence reads `[REDACTED]`); false negatives
 * are not. Apply unconditionally to all check payloads before persistence —
 * checks that don't surface user data won't trigger any pattern.
 */

const REDACTED = '[REDACTED]';

const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.\w+\b/g;
// Phone: at least 8 digits in a row with allowed separators. Keep low recall
// to avoid clobbering things like "11.2.0".
const PHONE_RE = /\b\+?\d[\d\s\-().]{7,}\d\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const DOB_RE = /\b\d{4}-\d{2}-\d{2}\b/g;

const DOB_FIELD_NAMES = new Set(['dob', 'date_of_birth', 'birthdate', 'birth_date']);
const USER_FIELD_HINTS = [
  'phone',
  'caller',
  'tel',
  'mobile',
  'patient',
  'user',
  'name',
  'email',
  'contact',
  'first_name',
  'last_name'
];

function isUserishKey(key) {
  if (!key) return false;
  const lower = String(key).toLowerCase();
  return USER_FIELD_HINTS.some((h) => lower.includes(h));
}

function sanitizeString(value, key) {
  if (typeof value !== 'string') return value;
  let out = value;

  // Always redact emails + SSNs — universally PHI-shaped.
  out = out.replace(EMAIL_RE, REDACTED);
  out = out.replace(SSN_RE, REDACTED);

  // DOB: only redact on string fields named like a DOB. Otherwise this would
  // clobber innocent ISO dates (e.g. timestamps).
  if (key && DOB_FIELD_NAMES.has(String(key).toLowerCase())) {
    out = out.replace(DOB_RE, REDACTED);
  }

  // Phone: only on user-ish field names — avoids clobbering numeric IDs
  // and version strings. The regex still requires a long digit run.
  if (isUserishKey(key)) {
    out = out.replace(PHONE_RE, REDACTED);
  }

  return out;
}

function sanitizeValue(value, key) {
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeString(value, key);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key));
  // Plain object — walk each property.
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = sanitizeValue(v, k);
  }
  return out;
}

/**
 * Sanitize a payload object. Returns a new object — does not mutate input.
 * Non-object inputs (string/number/null/undefined) are passed through the
 * same value sanitizer so the helper is safe to call regardless of shape.
 */
export function sanitize(payload) {
  if (payload == null) return payload;
  return sanitizeValue(payload, null);
}

export default { sanitize };
