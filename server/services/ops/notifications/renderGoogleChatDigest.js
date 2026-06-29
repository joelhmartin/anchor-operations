/**
 * Pure card renderers for outgoing Google Chat notifications.
 * No DB, no network, no PII in any output.
 */

const trunc = (str, max = 200) =>
  typeof str === 'string' && str.length > max ? str.slice(0, max) + '…' : (str || '');

const severityEmoji = { critical: '🔴', warning: '🟡', info: '🔵' };

function makeCard(cardId, header, sections, buttons = []) {
  const card = { header, sections };
  if (buttons.length) {
    card.fixedFooter = {
      primaryButton: buttons[0],
      ...(buttons[1] ? { secondaryButton: buttons[1] } : {})
    };
  }
  return [{ cardId, card }];
}

function textWidget(text) {
  return { textParagraph: { text } };
}

function buttonWidget(text, actionMethodName, parameters = []) {
  return {
    text,
    onClick: {
      action: { actionMethodName, parameters }
    }
  };
}

export function renderDailyDigestCard({ runId, clientName, runStatus, tier, findingCounts, topFindings = [] }) {
  const { critical = 0, warning = 0, info = 0 } = findingCounts;
  const top5 = topFindings.slice(0, 5);

  const header = {
    title: `Daily Digest — ${clientName}`,
    subtitle: `Run: ${runId.slice(0, 8)} · ${tier} · ${runStatus}`
  };

  const summarySection = {
    header: 'Finding Summary',
    widgets: [
      textWidget(`🔴 <b>${critical}</b> critical · 🟡 <b>${warning}</b> warning · 🔵 <b>${info}</b> info`)
    ]
  };

  const findingsSection = top5.length > 0 ? {
    header: 'Top Findings',
    widgets: top5.map((f) => textWidget(
      `${severityEmoji[f.severity] || '⚪'} [${f.category}] ${trunc(f.summary)}`
    ))
  } : null;

  const sections = [summarySection, ...(findingsSection ? [findingsSection] : [])];

  return {
    cardsV2: makeCard(`digest-${runId}`, header, sections),
    threadKey: `run-${runId}`
  };
}

export function renderCriticalAlertCard({ findingId, clientName, summary, severity, category, businessImpact }) {
  const header = {
    title: `${severityEmoji[severity] || '⚪'} Critical Alert — ${clientName}`,
    subtitle: category
  };

  const widgets = [textWidget(trunc(summary))];
  if (businessImpact) widgets.push(textWidget(`<b>Business impact:</b> ${trunc(businessImpact)}`));

  const sections = [{ widgets }];

  return {
    cardsV2: makeCard(`alert-${findingId}`, header, sections),
    threadKey: `finding-${findingId}`
  };
}

export function renderApprovalNeededCard({ actionRecommendationId, clientName, actionType, riskLevel, summary }) {
  // argsJson is intentionally NOT embedded in the card — callers reload from DB on CARD_CLICKED.
  const riskEmoji = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };

  const header = {
    title: `Approval Needed — ${clientName}`,
    subtitle: `${actionType} · risk: ${riskEmoji[riskLevel] || ''} ${riskLevel}`
  };

  const sections = [{ widgets: [textWidget(trunc(summary))] }];

  const approveBtn = buttonWidget('✅ Approve', 'approve_action', [
    { key: 'action_id', value: actionRecommendationId }
  ]);
  const rejectBtn = buttonWidget('❌ Reject', 'reject_action', [
    { key: 'action_id', value: actionRecommendationId }
  ]);

  return {
    cardsV2: makeCard(`approval-${actionRecommendationId}`, header, sections, [approveBtn, rejectBtn]),
    threadKey: `action-${actionRecommendationId}`
  };
}

export function renderActionResultCard({ actionRecommendationId, clientName, actionType, outcome, detail }) {
  const outcomeEmoji = { approved: '✅', rejected: '❌', executed: '✅', failed: '🔴' };

  const header = {
    title: `${outcomeEmoji[outcome] || ''} Action ${outcome} — ${clientName}`,
    subtitle: actionType
  };

  const sections = [{ widgets: [textWidget(trunc(detail))] }];

  return {
    cardsV2: makeCard(`result-${actionRecommendationId}`, header, sections),
    threadKey: `action-${actionRecommendationId}`
  };
}
