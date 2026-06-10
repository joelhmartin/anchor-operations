/**
 * CTM sub-agent tools (Phase 7).
 *
 * Wraps the four CTM check collectors as sub-agent tools. All tools are
 * read-only and return aggregate data only — no caller PII (names, phone
 * numbers, transcripts, recordings) is surfaced. Agency-owned tracking-number
 * E.164 values are acceptable.
 *
 * Each tool:
 *   { declaration, mutating, handler(args, ctx) }
 */

import { handler as trackingNumberHealthHandler } from '../../checks/ctm/trackingNumberHealth.js';
import { handler as classificationQualityHandler } from '../../checks/ctm/classificationQuality.js';
import { handler as formFlowHandler } from '../../checks/ctm/formFlow.js';
import { handler as webhookSyncHandler } from '../../checks/ctm/webhookSync.js';

// ---------------- tools ----------------

const ctm_tracking_number_health = {
  declaration: {
    name: 'ctm_tracking_number_health',
    description:
      'Check the health of the client\'s CTM/Twilio tracking numbers: inactive status and zero-call stale numbers. Returns aggregate findings — no caller PII.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  mutating: false,
  async handler(_args, ctx) {
    if (!ctx.clientUserId) return { error: 'No client selected' };
    return trackingNumberHealthHandler({ clientUserId: ctx.clientUserId });
  }
};

const ctm_classification_quality = {
  declaration: {
    name: 'ctm_classification_quality',
    description:
      'Inspect AI lead-classification health: pending count, unreviewed count, spam rate, and 7-day volume trend. Returns aggregate metrics only.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  mutating: false,
  async handler(_args, ctx) {
    if (!ctx.clientUserId) return { error: 'No client selected' };
    return classificationQualityHandler({ clientUserId: ctx.clientUserId });
  }
};

const ctm_form_flow = {
  declaration: {
    name: 'ctm_form_flow',
    description:
      'Verify CTM forms for the client: submission recency, autoresponder configuration completeness. Returns per-form findings (form names only, no submission content).',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  mutating: false,
  async handler(_args, ctx) {
    if (!ctx.clientUserId) return { error: 'No client selected' };
    return formFlowHandler({ clientUserId: ctx.clientUserId });
  }
};

const ctm_webhook_sync = {
  declaration: {
    name: 'ctm_webhook_sync',
    description:
      'Check recency of CTM webhook deliveries by inspecting the last call_log timestamp. Warns if no call has arrived in the past 24 h.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  mutating: false,
  async handler(_args, ctx) {
    if (!ctx.clientUserId) return { error: 'No client selected' };
    return webhookSyncHandler({ clientUserId: ctx.clientUserId });
  }
};

// ---------------- registry ----------------

const TOOLS = {
  ctm_tracking_number_health,
  ctm_classification_quality,
  ctm_form_flow,
  ctm_webhook_sync
};

export const ctmTools = {
  list() {
    return Object.values(TOOLS).map((t) => t.declaration);
  },
  get(name) {
    return TOOLS[name] || null;
  }
};
