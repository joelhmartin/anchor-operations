/**
 * Shared CSV helpers for server-side exports (Contacts, portal activity/email logs, …).
 *
 * Keep these tiny and dependency-free so any export route can build RFC-4180-safe CSV with
 * spreadsheet-formula-injection defense. Extracted from the Contacts export in routes/hub.js.
 */

/**
 * Quote/escape a single CSV cell.
 *
 * Neutralizes spreadsheet formula injection: cells starting with = + - @ (after any leading
 * whitespace) can execute when opened in Excel/Sheets. User-controlled values (names, emails,
 * tags, details) get a single-quote prefix to defuse them. RFC-4180 quoting for ", , and \n.
 */
export const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[\t\r ]*[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Format a date value as YYYY-MM-DD for CSV output ('' when missing/invalid). */
export const formatCsvDate = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
