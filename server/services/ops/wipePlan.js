// Ops-owned ACTIVITY tables only. Config tables (run_definitions, skills, recipes,
// credentials, kinsta_* mappings, meta_page_links, subscriptions) are intentionally
// excluded — the wipe clears test activity, not configuration.
// FK-safe order: children before parents.
export const ALLOWED_ACTIVITY_TABLES = [
  'ops_chat_messages',
  'ops_chat_threads',
  'ops_tool_approvals',
  'ops_bulk_runs',
  'ops_blog_posts',
  'ops_reports',
  'ops_findings',
  'ops_check_results',
  'ops_runs',
  'kinsta_ssh_command_log',
  'kinsta_findings'
];

// Shared with the main app's social publisher. Only wiped when explicitly flagged.
// social_media_tokens FKs into social_posts → delete tokens first.
export const SOCIAL_TABLES = ['social_media_tokens', 'social_posts'];

export function planWipe({ includeSocial = false } = {}) {
  const plan = [...ALLOWED_ACTIVITY_TABLES];
  if (includeSocial) plan.push(...SOCIAL_TABLES);
  const allowed = new Set([...ALLOWED_ACTIVITY_TABLES, ...SOCIAL_TABLES]);
  for (const t of plan) {
    if (!allowed.has(t)) throw new Error(`Refusing to wipe non-allowlisted table: ${t}`);
  }
  return plan;
}
