/**
 * Pure response card renderer for Google Chat interactive replies.
 * No DB, no network. No PII in any output.
 */

const trunc = (str, max = 200) =>
  typeof str === 'string' && str.length > max ? str.slice(0, max) + '…' : (str || '');

const sev = { critical: '🔴', warning: '🟡', info: '🔵' };
const risk = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };

function simpleCard(cardId, title, subtitle, widgets) {
  return [{
    cardId,
    card: {
      header: { title, subtitle: subtitle || '' },
      sections: [{ widgets }]
    }
  }];
}

export function renderHelpCard() {
  return {
    text: [
      '*AnchorOps Commands*',
      '`/anchorops help` — Show this help',
      '`/anchorops daily` — Send your daily digest',
      '`/anchorops clients` — List your clients',
      '`/anchorops client <name>` — Client summary',
      '`/anchorops run <name>` — Trigger a named run',
      '`/anchorops issues <name>` — Open issues for a client',
      '`/anchorops approvals` — List pending approvals',
      '`/anchorops approve <id>` — Approve an action',
      '`/anchorops reject <id>` — Reject an action',
      '`/anchorops connect` — How to link your account',
      '`/anchorops audit` — Trigger an access audit'
    ].join('\n')
  };
}

export function renderClientsCard(clients = []) {
  if (clients.length === 0) {
    return { cardsV2: simpleCard('clients', 'Your Clients', 'No clients mapped.', [{ textParagraph: { text: 'No clients found for your account.' } }]) };
  }
  const widgets = clients.map((c) => ({
    textParagraph: {
      text: `*${c.name}* — ${c.openFindings} open finding${c.openFindings !== 1 ? 's' : ''}`
    }
  }));
  return { cardsV2: simpleCard('clients', 'Your Clients', `${clients.length} client(s)`, widgets) };
}

export function renderClientSummaryCard(client, findingCounts = {}, pendingApprovals = 0) {
  const { critical = 0, warning = 0, info = 0 } = findingCounts;
  const widgets = [
    { textParagraph: { text: `🔴 *${critical}* critical · 🟡 *${warning}* warning · 🔵 *${info}* info` } },
    { textParagraph: { text: `⏳ *${pendingApprovals}* pending approval(s)` } }
  ];
  return { cardsV2: simpleCard('client-summary', client.name, 'Client Summary', widgets) };
}

export function renderIssuesCard(findings = [], clientName = '') {
  const top10 = findings.slice(0, 10);
  if (top10.length === 0) {
    return { cardsV2: simpleCard('issues', `Issues — ${clientName}`, 'No open issues.', [{ textParagraph: { text: 'All clear! No open findings.' } }]) };
  }
  const widgets = top10.map((f) => ({
    textParagraph: { text: `${sev[f.severity] || '⚪'} [${f.category}] ${trunc(f.summary)}` }
  }));
  return { cardsV2: simpleCard('issues', `Issues — ${clientName}`, `${top10.length} finding(s)`, widgets) };
}

export function renderApprovalsCard(recs = []) {
  if (recs.length === 0) {
    return { cardsV2: simpleCard('approvals', 'Pending Approvals', 'None pending.', [{ textParagraph: { text: 'No actions awaiting your approval.' } }]) };
  }
  const sections = recs.slice(0, 10).map((rec, i) => ({
    header: `${i + 1}. ${rec.actionType} (${risk[rec.riskLevel] || ''} ${rec.riskLevel}) — ${rec.clientName}`,
    widgets: [
      { textParagraph: { text: trunc(rec.summary) } },
      {
        buttonList: {
          buttons: [
            {
              text: '✅ Approve',
              onClick: { action: { actionMethodName: 'approve_action', parameters: [{ key: 'action_id', value: rec.id }] } }
            },
            {
              text: '❌ Reject',
              onClick: { action: { actionMethodName: 'reject_action', parameters: [{ key: 'action_id', value: rec.id }] } }
            }
          ]
        }
      }
    ]
  }));
  return { cardsV2: [{ cardId: 'approvals', card: { header: { title: 'Pending Approvals', subtitle: `${recs.length} action(s)` }, sections } }] };
}

export function renderErrorCard(message) {
  return { text: `⚠️ ${trunc(String(message || 'An error occurred.'), 300)}` };
}

export function renderConnectCard(connectUrl) {
  return {
    cardsV2: [{
      cardId: 'connect',
      card: {
        header: { title: 'Connect Your Account', subtitle: 'Link Google Chat to AnchorOps' },
        sections: [{
          widgets: [
            { textParagraph: { text: 'Visit the link below and sign in to connect your Google Chat identity to your Anchor account.' } },
            { buttonList: { buttons: [{ text: 'Connect Now', onClick: { openLink: { url: connectUrl } } }] } }
          ]
        }]
      }
    }]
  };
}

export function renderAuditCard(auditStatus) {
  if (!auditStatus) {
    return { text: 'Access Audit: not yet run or no audit on record. Use the Operations dashboard to trigger one.' };
  }
  return { text: `Access Audit status: *${auditStatus}*. See the Operations dashboard for details.` };
}
