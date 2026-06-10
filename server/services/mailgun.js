import Mailgun from 'mailgun.js';
import formData from 'form-data';
import { ensureEmailHtml } from './emailTemplate.js';
import { query } from '../db.js';
import { isDemoMode } from './demoMode.js';

// Prefer prod keys/domains; in non-production allow sandbox if prod not set.
const isProd = process.env.NODE_ENV === 'production';
const apiKey = process.env.MAILGUN_API_KEY || (!isProd ? process.env.MAILGUN_SANDBOX_API_KEY : undefined);
const rawDomain = process.env.MAILGUN_DOMAIN || (!isProd ? process.env.MAILGUN_SANDBOX_DOMAIN : undefined);
const resolvedDomain = rawDomain && rawDomain.includes('.') ? rawDomain : rawDomain ? `${rawDomain}.mailgun.org` : undefined;

const defaultFrom = process.env.MAILGUN_DEFAULT_FROM || (resolvedDomain ? `Anchor Dashboard <webforms@${resolvedDomain}>` : undefined);

let client = null;
if (apiKey && resolvedDomain) {
  const mailgun = new Mailgun(formData);
  client = mailgun.client({
    username: 'api',
    key: apiKey
  });
}

export function isMailgunConfigured() {
  return Boolean(client && resolvedDomain);
}

/**
 * Liveness probe for Mailgun auth. Lists domains (cheap, authenticated, sends
 * nothing). Returns { ok, configured }. Throws on auth/transport error.
 */
export async function pingMailgun() {
  if (!isMailgunConfigured()) return { ok: false, configured: false };
  await client.domains.list({ limit: 1 });
  return { ok: true, configured: true };
}

export function getMailgunFromAddress() {
  return resolvedDomain ? `webforms@${resolvedDomain}` : null;
}

/**
 * Log an email to the database
 * @param {Object} options
 * @param {string} options.emailType - Type of email (onboarding, password_reset, etc.)
 * @param {string|string[]} options.to - Recipient email(s)
 * @param {string} options.recipientName - Recipient name (optional)
 * @param {string[]} options.cc - CC emails
 * @param {string[]} options.bcc - BCC emails
 * @param {string} options.subject - Email subject
 * @param {string} options.text - Plain text body
 * @param {string} options.html - HTML body
 * @param {string} options.triggeredById - User ID who triggered the email
 * @param {string} options.clientId - Client user ID the email is about
 * @param {Object} options.metadata - Additional metadata
 * @returns {Promise<string>} Log ID
 */
async function createEmailLog({
  emailType,
  to,
  recipientName,
  cc,
  bcc,
  subject,
  text,
  html,
  triggeredById,
  clientId,
  metadata = {}
}) {
  const recipients = Array.isArray(to) ? to : [to];
  const recipientEmail = recipients[0];
  
  const result = await query(
    `INSERT INTO email_logs (
      email_type, recipient_email, recipient_name, cc_emails, bcc_emails,
      subject, text_body, html_body, status, triggered_by_id, client_id, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11)
    RETURNING id`,
    [
      emailType,
      recipientEmail,
      recipientName || null,
      cc && cc.length ? cc : null,
      bcc && bcc.length ? bcc : null,
      subject,
      text || null,
      html || null,
      triggeredById || null,
      clientId || null,
      JSON.stringify(metadata)
    ]
  );
  return result.rows[0].id;
}

/**
 * Update email log with send result
 */
async function updateEmailLogStatus(logId, { status, mailgunId, mailgunMessage, errorMessage }) {
  await query(
    `UPDATE email_logs SET
      status = $2,
      mailgun_id = $3,
      mailgun_message = $4,
      error_message = $5,
      sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END
    WHERE id = $1`,
    [logId, status, mailgunId || null, mailgunMessage || null, errorMessage || null]
  );
}

/**
 * Send email via Mailgun (internal - no logging)
 */
async function sendMailgunInternal({ to, cc, bcc, subject, text, html, from, attachments, replyTo }) {
  if (isDemoMode()) {
    console.warn('[demo] Mailgun send suppressed (DEMO_MODE).');
    // Mimic a successful send so callers/logging paths don't error.
    return { id: 'demo-suppressed', message: 'Queued. (demo mode — not sent)' };
  }
  if (!isMailgunConfigured()) {
    throw new Error('Mailgun is not configured');
  }
  if (!to || (Array.isArray(to) && !to.length)) {
    throw new Error('Recipient is required');
  }
  if (!subject) {
    throw new Error('Subject is required');
  }
  if (!text && !html) {
    throw new Error('Either text or html content is required');
  }

  const recipients = Array.isArray(to) ? to : [to];
  const htmlLooksComplete = typeof html === 'string' && /<html[\s>]|<!doctype/i.test(html);
  // Always prefer the base template unless the caller provided a full HTML document.
  const finalHtml = htmlLooksComplete ? html : ensureEmailHtml({ subject, text, html, preheader: subject });
  const payload = {
    from: from || defaultFrom || `webforms@${resolvedDomain}`,
    to: recipients,
    cc: cc && Array.isArray(cc) && cc.length ? cc : undefined,
    bcc: bcc && Array.isArray(bcc) && bcc.length ? bcc : undefined,
    subject,
    text,
    html: finalHtml
  };
  // Attachments (optional)
  // mailgun.js supports `attachment` as:
  // - a single object { data, filename, contentType }
  // - or an array of those objects
  if (attachments && Array.isArray(attachments) && attachments.length) {
    payload.attachment = attachments.map((a) => ({
      data: a.data,
      filename: a.filename,
      contentType: a.contentType || 'application/octet-stream'
    }));
  }
  // Reply-To header (optional). Accepts string or array; multiple addresses
  // are joined with ", " per RFC 5322. Mailgun forwards custom headers via
  // the `h:Header-Name` payload key.
  if (replyTo) {
    const list = (Array.isArray(replyTo) ? replyTo : [replyTo])
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean);
    if (list.length) {
      payload['h:Reply-To'] = list.join(', ');
    }
  }
  return client.messages.create(resolvedDomain, payload);
}

/**
 * Send email via Mailgun (legacy - no logging)
 * Kept for backwards compatibility
 */
export async function sendMailgunMessage({ to, cc, bcc, subject, text, html, from, attachments, replyTo }) {
  return sendMailgunInternal({ to, cc, bcc, subject, text, html, from, attachments, replyTo });
}

/**
 * Send email via Mailgun with logging
 * @param {Object} emailOptions - Standard email options (to, cc, bcc, subject, text, html, from, attachments)
 * @param {Object} logOptions - Logging options
 * @param {string} logOptions.emailType - Type of email for categorization
 * @param {string} logOptions.recipientName - Name of recipient
 * @param {string} logOptions.triggeredById - User ID who triggered the email
 * @param {string} logOptions.clientId - Client user ID the email is about
 * @param {Object} logOptions.metadata - Additional metadata to store
 * @param {boolean} logOptions.skipBodyLogging - If true, store '[redacted - PHI]' instead of body in email_logs
 * @returns {Promise<Object>} Mailgun response with logId
 */
export async function sendMailgunMessageWithLogging(
  { to, cc, bcc, subject, text, html, from, attachments, replyTo },
  { emailType, recipientName, triggeredById, clientId, metadata, skipBodyLogging } = {}
) {
  // Create log entry first
  let logId = null;
  try {
    logId = await createEmailLog({
      emailType: emailType || 'unknown',
      to,
      recipientName,
      cc,
      bcc,
      subject,
      // Redact body if caller signals PHI may be present
      text: skipBodyLogging ? '[redacted - PHI]' : text,
      html: skipBodyLogging ? '[redacted - PHI]' : html,
      triggeredById,
      clientId,
      metadata
    });
  } catch (logErr) {
    console.error('[Email Log] Failed to create log entry:', logErr.message);
    // Continue sending even if logging fails
  }

  try {
    const response = await sendMailgunInternal({ to, cc, bcc, subject, text, html, from, attachments, replyTo });
    
    // Update log with success
    if (logId) {
      await updateEmailLogStatus(logId, {
        status: 'sent',
        mailgunId: response.id,
        mailgunMessage: response.message
      });
    }
    
    return { ...response, logId };
  } catch (err) {
    // Update log with failure
    if (logId) {
      await updateEmailLogStatus(logId, {
        status: 'failed',
        errorMessage: err.message
      });
    }
    throw err;
  }
}

/**
 * Fetch email logs with filtering and pagination
 */
export async function fetchEmailLogs({
  page = 1,
  limit = 50,
  emailType,
  status,
  search,
  dateFrom,
  dateTo,
  clientId
} = {}) {
  const offset = (page - 1) * limit;
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  // Portal callers force clientId = req.portalUserId so a client only ever sees its own emails.
  if (clientId) {
    conditions.push(`client_id = $${paramIndex++}`);
    params.push(clientId);
  }

  if (emailType && emailType !== 'all') {
    conditions.push(`email_type = $${paramIndex++}`);
    params.push(emailType);
  }

  if (status && status !== 'all') {
    conditions.push(`status = $${paramIndex++}`);
    params.push(status);
  }

  if (search) {
    conditions.push(`(recipient_email ILIKE $${paramIndex} OR subject ILIKE $${paramIndex} OR recipient_name ILIKE $${paramIndex})`);
    params.push(`%${search}%`);
    paramIndex++;
  }

  if (dateFrom) {
    conditions.push(`created_at >= $${paramIndex++}`);
    params.push(dateFrom);
  }

  if (dateTo) {
    conditions.push(`created_at <= $${paramIndex++}`);
    params.push(dateTo);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total count
  const countResult = await query(
    `SELECT COUNT(*) as total FROM email_logs ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  // Get paginated results
  const result = await query(
    `SELECT 
      id, email_type, recipient_email, recipient_name, subject, status,
      mailgun_id, error_message, triggered_by_id, client_id, created_at, sent_at,
      delivered_at, opened_at, open_count, clicked_at, click_count,
      bounced_at, bounce_type, bounce_code, complained_at, unsubscribed_at
    FROM email_logs
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, limit, offset]
  );

  return {
    logs: result.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
}

/**
 * Fetch a single email log with full details
 */
export async function fetchEmailLogById(id) {
  const result = await query(
    `SELECT 
      el.*,
      tu.email as triggered_by_email,
      tu.first_name as triggered_by_first_name,
      tu.last_name as triggered_by_last_name,
      cu.email as client_email,
      cu.first_name as client_first_name,
      cu.last_name as client_last_name
    FROM email_logs el
    LEFT JOIN users tu ON el.triggered_by_id = tu.id
    LEFT JOIN users cu ON el.client_id = cu.id
    WHERE el.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Get email type statistics
 */
export async function getEmailStats(days = 30) {
  const result = await query(
    `SELECT 
      email_type,
      status,
      COUNT(*) as count
    FROM email_logs
    WHERE created_at >= NOW() - INTERVAL '${days} days'
    GROUP BY email_type, status
    ORDER BY email_type, status`
  );
  return result.rows;
}
