/**
 * Seed sync — on startup, for each *.md under skills/seeds/<umbrella>/, parse
 * its YAML front matter and ensure an ops_skills row exists. Existing rows are
 * NEVER overwritten (user edits win). Missing rows are created at version 1.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getSkillBySlug, createSkill } from './store.js';

// Ensure all check modules are registered so validateCollectors works correctly.
import '../checks/website/index.js';
import '../checks/google_ads/index.js';
import '../checks/meta/index.js';
import '../checks/ctm/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEEDS_DIR = path.join(__dirname, 'seeds');

function parseFrontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('seed file missing YAML front matter');
  const meta = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k === 'collectors') {
      // expects: [a, b, c]
      const inner = v.replace(/^\[|\]$/g, '').trim();
      meta.collectors = inner ? inner.split(',').map((s) => s.trim()) : [];
    } else if (k === 'cost_estimate_cents') {
      meta.cost_estimate_cents = Number(v) || 0;
    } else {
      meta[k] = v;
    }
  }
  return { meta, body: m[2].trim() };
}

export async function syncSeedSkills() {
  let umbrellas;
  try {
    umbrellas = await fs.readdir(SEEDS_DIR);
  } catch (e) {
    if (e.code === 'ENOENT') return { created: 0, existed: 0 };
    throw e;
  }
  let created = 0;
  let existed = 0;
  for (const umbrella of umbrellas) {
    const dir = path.join(SEEDS_DIR, umbrella);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      const filePath = path.join(dir, f);
      const text = await fs.readFile(filePath, 'utf8');
      const { meta, body } = parseFrontMatter(text);
      if (!meta.slug || !meta.umbrella || !meta.title) {
        console.warn(`[skills/seed] ${filePath} missing slug/umbrella/title — skipped`);
        continue;
      }
      const existing = await getSkillBySlug(meta.slug);
      if (existing) { existed += 1; continue; }
      await createSkill({
        slug: meta.slug,
        umbrella: meta.umbrella,
        title: meta.title,
        promptMd: body,
        collectors: meta.collectors || [],
        costEstimateCents: meta.cost_estimate_cents || 0,
        createdBy: null
      });
      created += 1;
    }
  }
  return { created, existed };
}
