/**
 * The ONLY LLM step in the pipeline (north-star §16, §17.1). The model summarizes,
 * prioritizes, and drafts prose — it never computes metrics and never calls tools.
 * All numbers are passed in pre-computed; nothing numeric is read back out.
 * `llm` is injected so tests run with zero network.
 */
import { sanitize } from '../payloadSanitizer.js';

function clampPriority(p) {
  const n = Math.round(Number(p));
  if (!Number.isFinite(n)) return 100;
  return Math.max(1, Math.min(1000, n));
}

function sanitizeText(s, fallback = '') {
  const raw = typeof s === 'string' && s.trim() ? s : fallback;
  // Use a user-ish key so both emails and phones are redacted (per payloadSanitizer logic).
  const out = sanitize({ contact: raw });
  return typeof out.contact === 'string' ? out.contact : String(raw);
}

export function buildSummarizePrompt(group = {}, computed = {}) {
  const summaries = (group.findings || []).map((f) => `- ${sanitizeText(f.summary)}`).join('\n');
  return [
    'You are drafting an operations recommendation for an internal admin console.',
    'You ONLY write prose and choose a priority. You MUST NOT invent, compute, or recalculate any number.',
    'Do not invent numbers, do not compute metrics, do not call any external system or tool.',
    '',
    `Category: ${group.category}`,
    `Highest severity: ${group.severity}`,
    `Affected platforms: ${(group.affectedPlatforms || []).join(', ')}`,
    '',
    'Pre-computed facts (authoritative — reuse verbatim, do not change):',
    `  risk_score=${computed.riskScore} risk_tier=${computed.riskTier} approval_level=${computed.approvalLevel} baseline_sigma=${computed.baselineDelta ?? 'n/a'}`,
    '',
    'Findings in this group:',
    summaries,
    '',
    'Respond with ONLY a JSON object:',
    '{ "title": string (<=80 chars), "summary": string (<=400 chars, no PHI),',
    '  "rationale": string (<=400 chars), "priority": integer (1=most urgent) }'
  ].join('\n');
}

function fallback(group, computed) {
  const plats = (group.affectedPlatforms || []).join(', ') || 'website';
  return {
    title: `Review ${group.category}`.slice(0, 80),
    summary: sanitizeText(group.findings?.[0]?.summary, `Action recommended for ${plats}.`).slice(0, 400),
    rationale: `Grouped from ${group.findings?.length || 0} finding(s); risk_tier=${computed.riskTier}.`.slice(0, 400),
    priority: computed.riskTier === 'critical' ? 1 : computed.riskTier === 'high' ? 10 : 100
  };
}

async function defaultLlm(prompt) {
  // Wired to the existing supervisor runtime; never used in tests (always injected).
  const { runClaudeToolLoop } = await import('../agents/anthropicRuntime.js');
  const r = await runClaudeToolLoop({
    system: 'Return only the requested JSON. No tools.',
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    budgetCents: 10
  });
  return r?.text || '';
}

export async function summarizeGroup(group = {}, computed = {}, { llm = defaultLlm } = {}) {
  const prompt = buildSummarizePrompt(group, computed);
  let parsed = null;
  try {
    const text = await llm(prompt);
    const match = String(text).match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') return fallback(group, computed);
  // Trust ONLY title/summary/rationale/priority. Drop any numeric fields the model invented.
  return {
    title: sanitizeText(parsed.title, fallback(group, computed).title).slice(0, 80),
    summary: sanitizeText(parsed.summary, fallback(group, computed).summary).slice(0, 400),
    rationale: sanitizeText(parsed.rationale, fallback(group, computed).rationale).slice(0, 400),
    priority: clampPriority(parsed.priority)
  };
}

export default { buildSummarizePrompt, summarizeGroup };
