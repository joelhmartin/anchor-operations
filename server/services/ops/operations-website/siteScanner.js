/**
 * Site discovery scan: runs WP-CLI commands on the live env and builds a
 * scan_json snapshot. Ported from wp-client-hub/src/lib/discovery/.
 */

import { wpcli } from './sshClient.js';
import { query } from '../../../db.js';
import { renderClaudeMd } from './claudeMdTemplate.js';
import { mergeClaudeMd } from './claudeMdMerge.js';

const BUILTIN_POST_TYPES = new Set([
  'post', 'page', 'attachment', 'revision', 'nav_menu_item',
  'custom_css', 'customize_changeset', 'oembed_cache',
  'user_request', 'wp_block', 'wp_template', 'wp_template_part',
  'wp_global_styles', 'wp_navigation', 'wp_font_family', 'wp_font_face',
  'wp_pattern'
]);

function parseBoolStdout(result) {
  if (!result || result.exitCode !== 0) return false;
  const v = (result.stdout || '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

function safeJson(result, fallback) {
  if (!result || result.exitCode !== 0) return fallback;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return fallback;
  }
}

function trimStdout(result, fallback = '') {
  if (!result || result.exitCode !== 0) return fallback;
  return (result.stdout || '').trim();
}

async function safeWpcli(envId, args, opts = {}) {
  try {
    return await wpcli(envId, args, opts);
  } catch (err) {
    return { stdout: '', stderr: err.message || '', exitCode: -1 };
  }
}

function buildThemeInfo(themesJson, template, stylesheet) {
  const themes = Array.isArray(themesJson) ? themesJson : [];
  const isChild = template && stylesheet && template !== stylesheet;
  const isDivi =
    template === 'Divi' ||
    template === 'divi' ||
    themes.some((t) => (t.name || '').toLowerCase() === 'divi');
  const diviTheme = themes.find((t) => (t.name || '').toLowerCase() === 'divi');
  return {
    active_theme: stylesheet || '',
    parent_theme: isChild ? template : null,
    child_theme: isChild ? stylesheet : null,
    is_divi: isDivi,
    divi_version: isDivi && diviTheme ? diviTheme.version : null,
    child_theme_path: isChild ? `/wp-content/themes/${stylesheet}/` : null,
    themes_listed: themes.length
  };
}

function buildPluginInfo(pluginsJson) {
  const plugins = Array.isArray(pluginsJson) ? pluginsJson : [];
  return plugins.map((p) => ({
    name: p.name,
    status: p.status,
    version: p.version,
    update_available: p.update === 'available'
  }));
}

function buildPostTypes(typesJson) {
  const types = Array.isArray(typesJson) ? typesJson : [];
  return types
    .filter((t) => !BUILTIN_POST_TYPES.has(t.name))
    .map((t) => ({
      name: t.name,
      label: t.label,
      is_public: t.public === true || t.public === '1' || t.public === 'true',
      has_archive: t.has_archive === true || t.has_archive === '1' || t.has_archive === 'true'
    }));
}

function extractPhpVersion(infoStdout) {
  if (!infoStdout) return 'unknown';
  const m1 = infoStdout.match(/PHP binary:\s+.*?(\d+\.\d+\.\d+)/);
  if (m1) return m1[1];
  const m2 = infoStdout.match(/PHP version:\s+(\d+\.\d+\.\d+)/);
  return m2 ? m2[1] : 'unknown';
}

export async function scanEnvironment(environmentId, { userId } = {}) {
  const startedAt = Date.now();
  const opts = { userId, triggeredBy: 'scanner' };

  const [
    siteUrl,
    siteTitle,
    wpVersion,
    wpInfo,
    multisite,
    themes,
    template,
    stylesheet,
    plugins,
    postTypes,
    debugFlag,
    debugLog,
    debugDisplay
  ] = await Promise.all([
    safeWpcli(environmentId, 'option get siteurl', opts),
    safeWpcli(environmentId, 'option get blogname', opts),
    safeWpcli(environmentId, 'core version', opts),
    safeWpcli(environmentId, '--info', opts),
    safeWpcli(environmentId, "config get MULTISITE 2>/dev/null || echo 'false'", opts),
    safeWpcli(environmentId, 'theme list --format=json', opts),
    safeWpcli(environmentId, 'option get template', opts),
    safeWpcli(environmentId, 'option get stylesheet', opts),
    safeWpcli(environmentId, 'plugin list --format=json', opts),
    safeWpcli(environmentId, 'post-type list --format=json', opts),
    safeWpcli(environmentId, "config get WP_DEBUG 2>/dev/null || echo 'false'", opts),
    safeWpcli(environmentId, "config get WP_DEBUG_LOG 2>/dev/null || echo 'false'", opts),
    safeWpcli(environmentId, "config get WP_DEBUG_DISPLAY 2>/dev/null || echo 'false'", opts)
  ]);

  const themeInfo = buildThemeInfo(safeJson(themes, []), trimStdout(template), trimStdout(stylesheet));
  const pluginInfo = buildPluginInfo(safeJson(plugins, []));
  const postTypeInfo = buildPostTypes(safeJson(postTypes, []));

  return {
    site_url: trimStdout(siteUrl),
    site_title: trimStdout(siteTitle),
    wp_version: trimStdout(wpVersion, 'unknown'),
    php_version: extractPhpVersion(wpInfo.stdout),
    multisite: parseBoolStdout(multisite),
    theme: themeInfo,
    plugins: pluginInfo,
    custom_post_types: postTypeInfo,
    debug_flags: {
      wp_debug: parseBoolStdout(debugFlag),
      wp_debug_log: parseBoolStdout(debugLog),
      wp_debug_display: parseBoolStdout(debugDisplay)
    },
    scanned_at: new Date().toISOString(),
    scan_duration_ms: Date.now() - startedAt,
    metadata: { is_divi: themeInfo.is_divi }
  };
}

/**
 * Scan a site (uses its live environment) and persist scan_json + merged
 * claude_md into kinsta_site_workspaces. Returns the saved workspace row.
 */
export async function scanSite(siteId, { userId } = {}) {
  const liveEnv = await query(
    `SELECT id FROM kinsta_environments
       WHERE site_id = $1 AND is_live = TRUE
       ORDER BY created_at ASC LIMIT 1`,
    [siteId]
  );
  if (!liveEnv.rows[0]) {
    throw new Error('Site has no live environment to scan');
  }
  const envId = liveEnv.rows[0].id;

  // Mark workspace as pending so the UI can reflect in-progress state.
  await query(
    `INSERT INTO kinsta_site_workspaces (site_id, last_scan_status, updated_at)
     VALUES ($1, 'pending', NOW())
     ON CONFLICT (site_id) DO UPDATE
       SET last_scan_status = 'pending', last_scan_error = NULL, updated_at = NOW()`,
    [siteId]
  );

  let scan;
  try {
    scan = await scanEnvironment(envId, { userId });
  } catch (err) {
    await query(
      `UPDATE kinsta_site_workspaces
         SET last_scan_status = 'failed',
             last_scan_error = $2,
             last_scan_at = NOW(),
             updated_at = NOW()
       WHERE site_id = $1`,
      [siteId, (err.message || 'scan failed').slice(0, 500)]
    );
    throw err;
  }

  // Render new CLAUDE.md and merge with any existing user-edited content.
  const existing = await query(
    'SELECT claude_md FROM kinsta_site_workspaces WHERE site_id = $1 LIMIT 1',
    [siteId]
  );
  const generated = renderClaudeMd(scan);
  const merged = mergeClaudeMd(existing.rows[0]?.claude_md || '', generated);

  const { rows } = await query(
    `INSERT INTO kinsta_site_workspaces (site_id, claude_md, scan_json, last_scan_at, last_scan_status, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW(), 'success', NOW())
     ON CONFLICT (site_id) DO UPDATE
       SET claude_md = EXCLUDED.claude_md,
           scan_json = EXCLUDED.scan_json,
           last_scan_at = NOW(),
           last_scan_status = 'success',
           last_scan_error = NULL,
           updated_at = NOW()
     RETURNING *`,
    [siteId, merged, JSON.stringify(scan)]
  );

  return rows[0];
}
