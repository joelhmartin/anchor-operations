/**
 * Pure command parser for Google Chat messages.
 * Returns { command, args } for known commands or { command: 'unknown', raw } otherwise.
 */

const KNOWN = new Set([
  'help', 'daily', 'clients', 'client', 'run', 'issues',
  'approvals', 'approve', 'reject', 'connect', 'audit'
]);

// Commands where the remaining text is a single multi-word arg
const MULTI_WORD_ARG = new Set(['client', 'run', 'issues']);

export function parseCommand(raw) {
  const text = (raw || '').trim();
  if (!text) return { command: 'unknown', raw: text };

  // Strip /anchorops or @AnchorOps prefix (case-insensitive)
  const stripped = text
    .replace(/^\/anchorops\s*/i, '')
    .replace(/^@anchorops\s*/i, '')
    .trim();

  const parts = stripped.split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();

  if (!KNOWN.has(cmd)) return { command: 'unknown', raw: text };

  if (MULTI_WORD_ARG.has(cmd)) {
    const rest = stripped.slice(cmd.length).trim();
    return { command: cmd, args: rest ? [rest] : [] };
  }

  const args = parts.slice(1);
  return { command: cmd, args };
}
