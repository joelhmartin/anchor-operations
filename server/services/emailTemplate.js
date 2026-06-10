import fs from 'fs';
import path from 'path';

function normalizeBase(value) {
  if (!value) return null;
  let base = String(value).trim();
  if (!/^https?:\/\//i.test(base)) {
    base = `https://${base}`;
  }
  return base.replace(/\/$/, '');
}

function getPublicBaseUrl() {
  return (
    normalizeBase(process.env.APP_BASE_URL) ||
    normalizeBase(process.env.CLIENT_APP_URL) ||
    normalizeBase(process.env.PUBLIC_BASE_URL) ||
    null
  );
}

function findLogoPath() {
  const candidates = [
    path.resolve(process.cwd(), 'server', 'assets', 'email', 'ANCHOR__CORPS.png'),
    path.resolve(process.cwd(), 'src', 'assets', 'images', 'ANCHOR__CORPS.png')
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

let cachedLogoDataUri = null;
function getLogoDataUri() {
  if (cachedLogoDataUri !== null) return cachedLogoDataUri;
  const p = findLogoPath();
  if (!p) {
    cachedLogoDataUri = '';
    return cachedLogoDataUri;
  }
  try {
    const buf = fs.readFileSync(p);
    cachedLogoDataUri = `data:image/png;base64,${buf.toString('base64')}`;
    return cachedLogoDataUri;
  } catch {
    cachedLogoDataUri = '';
    return cachedLogoDataUri;
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function textToHtml(text) {
  const safe = escapeHtml(text || '');
  return safe
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px 0;">${p.replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

export function wrapEmailHtml({ subject, preheader, bodyHtml, footerHtml } = {}) {
  const baseUrl = getPublicBaseUrl();
  const logoSrc = baseUrl ? `${baseUrl}/email-assets/ANCHOR__CORPS.png` : getLogoDataUri();
  const safePreheader = String(preheader || '').trim();
  const resolvedBody = String(bodyHtml || '').trim() || '<p style="margin:0;">&nbsp;</p>';
  const resolvedFooter =
    typeof footerHtml === 'string' && footerHtml.trim()
      ? footerHtml
      : `<p style="margin:0;">© ${new Date().getFullYear()} Anchor Corps</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no" />
  <title>${escapeHtml(subject || 'Anchor')}</title>
  <style>
    /* Client resets */
    html, body { margin: 0 !important; padding: 0 !important; height: 100% !important; width: 100% !important; }
    * { -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt !important; mso-table-rspace: 0pt !important; }
    img { -ms-interpolation-mode: bicubic; }
    a { text-decoration: none; }
    /* Responsive */
    @media screen and (max-width: 600px) {
      .container { width: 100% !important; }
      .px { padding-left: 18px !important; padding-right: 18px !important; }
      .py { padding-top: 18px !important; padding-bottom: 18px !important; }
      .h1 { font-size: 22px !important; line-height: 28px !important; }
    }
  </style>
</head>
<body style="background:#f5f7fb; margin:0; padding:0;">
  ${safePreheader ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(safePreheader)}</div>` : ''}

  <center role="article" aria-roledescription="email" lang="en" style="width:100%; background:#f5f7fb;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f7fb;">
      <tr>
        <td align="center" style="padding: 28px 12px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="container" style="width:600px; max-width:600px;">
            <tr>
              <td class="px py" style="background:#ffffff; border-radius: 14px; overflow:hidden; padding: 22px 26px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr>
                    <td align="center" style="padding: 6px 0 16px 0;">
                      ${
                        logoSrc
                          ? `<img src="${logoSrc}" width="190" alt="Anchor Corps" style="display:block; margin:0 auto; border:0; outline:none; text-decoration:none; max-width: 190px; height:auto;" />`
                          : `<div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-weight:700; font-size:16px; color:#0b1f33; text-align:center;">Anchor Corps</div>`
                      }
                    </td>
                  </tr>
                  <tr>
                    <td style="height:1px; background:#eef2f7; line-height:1px; font-size:1px;">&nbsp;</td>
                  </tr>
                  <tr>
                    <td style="height:16px; line-height:16px; font-size:16px;">&nbsp;</td>
                  </tr>
                  <tr>
                    <td style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; color:#0b1f33; font-size:15px; line-height:22px;">
                      ${resolvedBody}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding: 14px 10px; font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size: 12px; line-height: 18px; color:#6b7280;">
                ${resolvedFooter}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>`;
}

/**
 * Brand-neutral wrapper for emails sent on behalf of a client (no Anchor Corps
 * branding). Renders an optional logo at the top; if no logo is provided,
 * the header is omitted entirely.
 */
export function wrapClientEmailHtml({ subject, preheader, bodyHtml, logoUrl, footerHtml } = {}) {
  const baseUrl = getPublicBaseUrl();
  let resolvedLogo = '';
  if (logoUrl && typeof logoUrl === 'string') {
    const trimmed = logoUrl.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      resolvedLogo = trimmed;
    } else if (baseUrl) {
      resolvedLogo = `${baseUrl}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
    }
  }

  const safePreheader = String(preheader || '').trim();
  const resolvedBody = String(bodyHtml || '').trim() || '<p style="margin:0;">&nbsp;</p>';
  const resolvedFooter = typeof footerHtml === 'string' ? footerHtml : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no" />
  <title>${escapeHtml(subject || '')}</title>
  <style>
    html, body { margin: 0 !important; padding: 0 !important; height: 100% !important; width: 100% !important; }
    * { -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt !important; mso-table-rspace: 0pt !important; }
    img { -ms-interpolation-mode: bicubic; }
    a { text-decoration: none; }
    @media screen and (max-width: 600px) {
      .container { width: 100% !important; }
      .px { padding-left: 18px !important; padding-right: 18px !important; }
      .py { padding-top: 18px !important; padding-bottom: 18px !important; }
    }
  </style>
</head>
<body style="background:#f5f7fb; margin:0; padding:0;">
  ${safePreheader ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(safePreheader)}</div>` : ''}
  <center role="article" aria-roledescription="email" lang="en" style="width:100%; background:#f5f7fb;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f7fb;">
      <tr>
        <td align="center" style="padding: 28px 12px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="container" style="width:600px; max-width:600px;">
            <tr>
              <td class="px py" style="background:#ffffff; border-radius: 14px; overflow:hidden; padding: 28px 30px;">
                ${
                  resolvedLogo
                    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center" style="padding: 0 0 18px 0;"><img src="${resolvedLogo}" alt="" style="display:block; margin:0 auto; border:0; outline:none; text-decoration:none; max-width: 220px; max-height: 80px; height:auto; width:auto;" /></td></tr><tr><td style="height:1px; background:#eef2f7; line-height:1px; font-size:1px;">&nbsp;</td></tr><tr><td style="height:18px; line-height:18px; font-size:18px;">&nbsp;</td></tr></table>`
                    : ''
                }
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr>
                    <td style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; color:#0b1f33; font-size:15px; line-height:22px;">
                      ${resolvedBody}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            ${
              resolvedFooter
                ? `<tr><td align="center" style="padding: 14px 10px; font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size: 12px; line-height: 18px; color:#6b7280;">${resolvedFooter}</td></tr>`
                : ''
            }
          </table>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>`;
}

/**
 * Format raw plain-text body into safe HTML: HTML-escape, split blank-line
 * paragraphs into <p> tags, convert single newlines to <br/>.
 * Token placeholders ({{name}}) survive escaping unchanged.
 */
export function plainTextToParagraphs(text) {
  const safe = escapeHtml(text || '').trim();
  if (!safe) return '';
  return safe
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 12px 0;">${para.replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

export function ensureEmailHtml({ subject, text, html, preheader } = {}) {
  const hasHtml = typeof html === 'string' && html.trim();
  const bodyHtml = hasHtml ? html : textToHtml(text || '');
  return wrapEmailHtml({ subject, preheader, bodyHtml });
}


