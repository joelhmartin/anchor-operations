/**
 * Merge a freshly-rendered CLAUDE.md with the existing one, preserving
 * manually-edited sections (Issue Log, Agent Notes, anything without the
 * <!-- AUTO-SCAN --> marker). Auto-scan sections get replaced wholesale.
 */

const AUTO_SCAN_MARKER = '<!-- AUTO-SCAN -->';
const MANUAL_SECTION_NAMES = new Set(['issue log', 'agent notes']);

function normalizeHeading(heading) {
  return heading.replace(AUTO_SCAN_MARKER, '').trim().toLowerCase();
}

function parseSections(content) {
  const lines = (content || '').split('\n');
  const sections = [];
  let heading = '';
  let buf = [];

  for (const line of lines) {
    if (/^#{1,2}\s+/.test(line)) {
      if (heading) {
        const body = buf.join('\n');
        sections.push({
          heading,
          content: body,
          isAutoScan: body.includes(AUTO_SCAN_MARKER) || heading.includes(AUTO_SCAN_MARKER)
        });
      }
      heading = line;
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (heading) {
    const body = buf.join('\n');
    sections.push({
      heading,
      content: body,
      isAutoScan: body.includes(AUTO_SCAN_MARKER) || heading.includes(AUTO_SCAN_MARKER)
    });
  }
  return sections;
}

function isTitle(section) {
  return section.heading.startsWith('# ') && !section.heading.startsWith('## ');
}

export function mergeClaudeMd(existing, generated) {
  if (!existing || !existing.trim()) return generated;

  const existingSections = parseSections(existing);
  const newSections = parseSections(generated);

  const newByKey = new Map();
  for (const s of newSections) newByKey.set(normalizeHeading(s.heading), s);

  const placed = new Set();
  const result = [];

  const newTitle = newSections.find(isTitle);
  const existingTitle = existingSections.find(isTitle);
  if (newTitle) {
    result.push(newTitle);
    placed.add(normalizeHeading(newTitle.heading));
  } else if (existingTitle) {
    result.push(existingTitle);
  }

  for (const section of existingSections) {
    if (isTitle(section)) continue;
    const key = normalizeHeading(section.heading);
    if (section.isAutoScan) {
      const replacement = newByKey.get(key);
      if (replacement) {
        result.push(replacement);
        placed.add(key);
      }
      // Drop stale auto-scan sections that aren't in the new render.
    } else {
      result.push(section);
      placed.add(key);
    }
  }

  // Insert new auto-scan sections that weren't in the existing file.
  const unplaced = newSections.filter(
    (s) => !isTitle(s) && !placed.has(normalizeHeading(s.heading))
  );
  if (unplaced.length) {
    const manualIdx = result.findIndex((s) =>
      MANUAL_SECTION_NAMES.has(normalizeHeading(s.heading).replace('## ', ''))
    );
    if (manualIdx >= 0) {
      result.splice(manualIdx, 0, ...unplaced);
    } else {
      result.push(...unplaced);
    }
  }

  // Ensure manual section anchors exist.
  const has = (name) =>
    result.some((s) => normalizeHeading(s.heading).replace('## ', '') === name);
  if (!has('issue log')) result.push({ heading: '## Issue Log', content: '\n', isAutoScan: false });
  if (!has('agent notes')) result.push({ heading: '## Agent Notes', content: '\n', isAutoScan: false });

  return result.map((s) => `${s.heading}\n${s.content}`).join('\n');
}
