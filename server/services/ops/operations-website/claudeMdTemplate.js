/**
 * Renders a scan_json snapshot to a CLAUDE.md markdown document.
 * Auto-generated sections are tagged with <!-- AUTO-SCAN --> so
 * claudeMdMerge.js can replace them on re-scan while preserving manual sections.
 */

const AUTO_SCAN = '<!-- AUTO-SCAN -->';

function formatDate(iso) {
  try {
    return new Date(iso).toISOString().split('T')[0];
  } catch {
    return iso || 'unknown';
  }
}

function siteDetails(scan) {
  return [
    `## Site Details ${AUTO_SCAN}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| URL | ${scan.site_url || 'unknown'} |`,
    `| WordPress | ${scan.wp_version || 'unknown'} |`,
    `| PHP | ${scan.php_version || 'unknown'} |`,
    `| Multisite | ${scan.multisite ? 'Yes' : 'No'} |`,
    `| Last Scanned | ${formatDate(scan.scanned_at)} |`,
    ''
  ].join('\n');
}

function themeArchitecture(scan) {
  const t = scan.theme || {};
  const lines = [`## Theme & Architecture ${AUTO_SCAN}`, ''];
  if (t.parent_theme) {
    const diviSuffix = t.is_divi && t.divi_version ? ` (Divi v${t.divi_version})` : '';
    lines.push(`- **Parent Theme**: ${t.parent_theme}${diviSuffix}`);
    lines.push(`- **Child Theme**: ${t.child_theme}`);
    if (t.child_theme_path) {
      lines.push(`- **Child Theme Path**: \`${t.child_theme_path}\``);
    }
  } else {
    const diviSuffix = t.is_divi && t.divi_version ? ` (Divi v${t.divi_version})` : '';
    lines.push(`- **Active Theme**: ${t.active_theme || 'unknown'}${diviSuffix}`);
  }
  if (t.is_divi) {
    lines.push(`- **Divi**: Yes${t.divi_version ? ` (v${t.divi_version})` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

function plugins(scan) {
  const all = Array.isArray(scan.plugins) ? scan.plugins : [];
  const active = all.filter((p) => p.status === 'active').sort((a, b) => a.name.localeCompare(b.name));
  const mustUse = all.filter((p) => p.status === 'must-use');
  const inactive = all.filter((p) => p.status === 'inactive');
  const updates = all.filter((p) => p.update_available);

  const lines = [`## Key Plugins ${AUTO_SCAN}`, ''];

  if (active.length) {
    lines.push(`### Active (${active.length})`);
    lines.push('');
    lines.push('| Plugin | Version |');
    lines.push('|--------|---------|');
    for (const p of active) {
      const flag = p.update_available ? ' *' : '';
      lines.push(`| ${p.name} | ${p.version}${flag} |`);
    }
    lines.push('');
  }

  if (mustUse.length) {
    lines.push(`### Must-Use (${mustUse.length})`);
    lines.push('');
    for (const p of mustUse) lines.push(`- ${p.name} (${p.version})`);
    lines.push('');
  }

  if (inactive.length) {
    lines.push(`*${inactive.length} inactive plugin${inactive.length === 1 ? '' : 's'}*`);
    lines.push('');
  }

  if (updates.length) {
    lines.push(`*${updates.length} update${updates.length === 1 ? '' : 's'} available (marked with \\*)*`);
    lines.push('');
  }

  return lines.join('\n');
}

function postTypes(scan) {
  const cpts = Array.isArray(scan.custom_post_types) ? scan.custom_post_types : [];
  if (cpts.length === 0) return '';
  const lines = [
    `## Custom Post Types ${AUTO_SCAN}`,
    '',
    '| Name | Label | Public | Archive |',
    '|------|-------|--------|---------|'
  ];
  for (const c of cpts) {
    lines.push(`| ${c.name} | ${c.label} | ${c.is_public ? 'Yes' : 'No'} | ${c.has_archive ? 'Yes' : 'No'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function debugging(scan) {
  const d = scan.debug_flags || {};
  return [
    `## Debugging ${AUTO_SCAN}`,
    '',
    `- **WP_DEBUG**: ${d.wp_debug ? 'Enabled' : 'Disabled'}`,
    `- **WP_DEBUG_LOG**: ${d.wp_debug_log ? 'Enabled' : 'Disabled'}`,
    `- **WP_DEBUG_DISPLAY**: ${d.wp_debug_display ? 'Enabled' : 'Disabled'}`,
    ''
  ].join('\n');
}

export function renderClaudeMd(scan) {
  const sections = [];
  sections.push(`# ${scan.site_title || scan.site_url || 'Unknown Site'}`);
  sections.push(siteDetails(scan));
  sections.push(themeArchitecture(scan));
  sections.push(plugins(scan));
  const cpt = postTypes(scan);
  if (cpt) sections.push(cpt);
  sections.push(debugging(scan));
  sections.push('## Issue Log\n');
  sections.push('## Agent Notes\n');
  return sections.join('\n');
}
