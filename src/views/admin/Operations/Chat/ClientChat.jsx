/**
 * ClientChat — Phase 7 Operations AI chat UI.
 *
 * One conversation per (admin, picked client). Messages are echoed inline:
 *   - user prompts as plain text
 *   - assistant replies as plain text
 *   - tool calls as compact cards with state (proposed → running → done/error/rejected)
 *
 * Mutating proposals from the supervisor open the shared ApprovalDialog. The
 * approval id round-trips through the backend so the eventual execution is
 * audited via ops_tool_approvals.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Autocomplete, Box, Button, Chip, Divider, MenuItem, Paper, Select, Stack, TextField, Tooltip, Typography } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import HistoryIcon from '@mui/icons-material/History';
import LoadingButton from 'ui-component/extended/LoadingButton';
import EmptyState from 'ui-component/extended/EmptyState';
import { useToast } from 'contexts/ToastContext';
import { clientLabel } from '../_clientLabel';
import { sendOpsChat, approveOpsChatAction, rejectOpsChatAction, listOpsRuns, listOpsClients } from 'api/ops';
import ApprovalDialog from './ApprovalDialog';

const PLATFORM_OPTIONS = [
  { value: 'all', label: 'All platforms' },
  { value: 'website', label: 'Website' },
  { value: 'google_ads', label: 'Google Ads' },
  { value: 'meta', label: 'Meta' },
  { value: 'ctm', label: 'CTM' }
];

const PLATFORM_PREFIXES = {
  website: '[Focus: Website] ',
  google_ads: '[Focus: Google Ads] ',
  meta: '[Focus: Meta] ',
  ctm: '[Focus: CTM] '
};

function MessageBubble({ role, text }) {
  if (!text) return null;
  const palette = {
    user: { bg: 'primary.lighter', align: 'flex-end' },
    model: { bg: 'grey.100', align: 'flex-start' },
    tool: { bg: 'grey.50', align: 'flex-start' }
  }[role] || { bg: 'grey.50', align: 'flex-start' };

  return (
    <Box sx={{ display: 'flex', justifyContent: palette.align, mb: 1 }}>
      <Paper
        elevation={0}
        sx={{
          maxWidth: '85%',
          px: 1.5,
          py: 1,
          bgcolor: palette.bg,
          border: '1px solid',
          borderColor: 'divider',
          whiteSpace: 'pre-wrap',
          fontSize: 14
        }}
      >
        {text}
      </Paper>
    </Box>
  );
}

function ToolCallCard({ name, state, summary }) {
  const colorMap = {
    proposed: 'warning',
    running: 'info',
    done: 'success',
    error: 'error',
    rejected: 'default'
  };
  return (
    <Box sx={{ display: 'flex', justifyContent: 'flex-start', mb: 1 }}>
      <Paper
        elevation={0}
        sx={{
          maxWidth: '85%',
          px: 1.5,
          py: 1,
          bgcolor: 'grey.50',
          border: '1px dashed',
          borderColor: 'divider'
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
            {name}
          </Typography>
          <Chip size="small" label={state} color={colorMap[state] || 'default'} />
        </Stack>
        {summary && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {summary}
          </Typography>
        )}
      </Paper>
    </Box>
  );
}

// Flatten Vertex Content[] into renderable rows.
function renderableFromMessages(messages) {
  const rows = [];
  for (const msg of messages || []) {
    if (msg.role === 'user') {
      const text = (msg.parts || [])
        .map((p) => p.text || '')
        .join('')
        .trim();
      if (text) rows.push({ kind: 'msg', role: 'user', text });
    } else if (msg.role === 'model') {
      const text = (msg.parts || [])
        .map((p) => p.text || '')
        .join('')
        .trim();
      if (text) rows.push({ kind: 'msg', role: 'model', text });
      const fnCalls = (msg.parts || []).filter((p) => p.functionCall);
      for (const fn of fnCalls) {
        rows.push({ kind: 'tool', name: fn.functionCall.name, state: 'running' });
      }
    } else if (msg.role === 'tool') {
      const responses = (msg.parts || []).filter((p) => p.functionResponse);
      for (const r of responses) {
        const resp = r.functionResponse?.response || {};
        const isErr = !!resp.error;
        rows.push({
          kind: 'tool',
          name: r.functionResponse.name,
          state: isErr ? 'error' : 'done',
          summary: isErr ? String(resp.error).slice(0, 200) : null
        });
      }
    }
  }
  // Collapse consecutive identical tool rows so a successful call only shows
  // once even though the call+response pair appears in two messages.
  const collapsed = [];
  for (const row of rows) {
    const last = collapsed[collapsed.length - 1];
    if (
      last &&
      last.kind === 'tool' &&
      row.kind === 'tool' &&
      last.name === row.name &&
      last.state === 'running' &&
      (row.state === 'done' || row.state === 'error')
    ) {
      collapsed[collapsed.length - 1] = { ...last, state: row.state, summary: row.summary };
    } else {
      collapsed.push(row);
    }
  }
  return collapsed;
}

export default function ClientChat({ initialClientUserId } = {}) {
  const { showToast } = useToast();
  const [clients, setClients] = useState([]);
  const [client, setClient] = useState(null);
  const [platform, setPlatform] = useState('all');
  const [history, setHistory] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(null);
  const [latestRuns, setLatestRuns] = useState([]);
  const [costSummary, setCostSummary] = useState(null);

  useEffect(() => {
    listOpsClients()
      .then((rows) => {
        const mapped = rows.map((c) => ({ id: c.id || c.user_id, name: clientLabel(c) })).filter((x) => x.id);
        setClients(mapped);
        if (initialClientUserId) {
          const match = mapped.find((c) => c.id === initialClientUserId);
          if (match) setClient(match);
        }
      })
      .catch(() => setClients([]));
  }, [initialClientUserId]);

  useEffect(() => {
    if (!client) {
      setLatestRuns([]);
      return;
    }
    listOpsRuns({ client_user_id: client.id, limit: 5 })
      .then(setLatestRuns)
      .catch(() => setLatestRuns([]));
    // Reset per-client state
    setHistory([]);
    setPendingApproval(null);
    setCostSummary(null);
  }, [client]);

  const renderable = useMemo(() => renderableFromMessages(history), [history]);

  const send = useCallback(
    async (overridePrompt) => {
      const raw = (overridePrompt ?? prompt).trim();
      if (!raw) return;
      if (!client) {
        showToast('Pick a client first', 'warning');
        return;
      }
      // Prepend platform focus hint when a specific platform is selected.
      const prefix = platform !== 'all' ? PLATFORM_PREFIXES[platform] || '' : '';
      const toSend = prefix + raw;
      setBusy(true);
      try {
        const result = await sendOpsChat({
          clientUserId: client.id,
          prompt: toSend,
          history
        });
        setHistory(result.messages || []);
        setCostSummary(result.costSummary || null);
        if (result.pendingApproval) {
          setPendingApproval(result.pendingApproval);
        }
        if (result.status === 'budget_exhausted') {
          showToast('Per-turn budget exhausted — split the question', 'warning');
        }
        if (overridePrompt === undefined) setPrompt('');
      } catch (err) {
        showToast(`Chat failed: ${err.response?.data?.message || err.message}`, 'error');
      } finally {
        setBusy(false);
      }
    },
    [prompt, client, platform, history, showToast]
  );

  const handleApprove = useCallback(
    async (approvalId) => {
      try {
        const result = await approveOpsChatAction(approvalId);
        if (result.error) {
          showToast(`Approval failed: ${result.error}`, 'error');
        } else {
          showToast('Action approved and executed', 'success');
        }
        setPendingApproval(null);
        // Surface the result back into the conversation as a synthetic tool note.
        setHistory((h) => [
          ...h,
          {
            role: 'tool',
            parts: [
              {
                functionResponse: {
                  name: 'approval_result',
                  response: result.result || { ok: result.ok }
                }
              }
            ]
          }
        ]);
      } catch (err) {
        showToast(`Approval failed: ${err.response?.data?.message || err.message}`, 'error');
      }
    },
    [showToast]
  );

  const handleReject = useCallback(
    async (approvalId) => {
      try {
        await rejectOpsChatAction(approvalId, 'rejected by admin from chat');
        showToast('Proposal rejected', 'info');
        setPendingApproval(null);
        setHistory((h) => [
          ...h,
          {
            role: 'tool',
            parts: [
              {
                functionResponse: {
                  name: 'approval_result',
                  response: { rejected: true }
                }
              }
            ]
          }
        ]);
      } catch (err) {
        showToast(`Reject failed: ${err.response?.data?.message || err.message}`, 'error');
      }
    },
    [showToast]
  );

  const handleReferenceLatestRun = useCallback(() => {
    if (!latestRuns.length) {
      showToast('No recent runs for this client', 'info');
      return;
    }
    const run = latestRuns[0];
    const inject = `Reference latest run: ${run.id} (tier=${run.tier} status=${run.status}). Use load_run to pull its check_results before answering.`;
    setPrompt((p) => (p ? `${p}\n\n${inject}` : inject));
  }, [latestRuns, showToast]);

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="center">
        <Autocomplete
          fullWidth
          options={clients}
          value={client}
          onChange={(_, v) => setClient(v)}
          getOptionLabel={(opt) => (opt ? opt.name || opt.id : '')}
          isOptionEqualToValue={(o, v) => o.id === v.id}
          renderInput={(params) => <TextField {...params} label="Pick client" size="small" />}
          sx={{ minWidth: 280 }}
        />
        <Tooltip title="Focus the agent on a specific platform sub-agent">
          <Select size="small" value={platform} onChange={(e) => setPlatform(e.target.value)} sx={{ minWidth: 160 }}>
            {PLATFORM_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>
                {opt.label}
              </MenuItem>
            ))}
          </Select>
        </Tooltip>
        <Button
          startIcon={<HistoryIcon />}
          variant="outlined"
          size="small"
          onClick={handleReferenceLatestRun}
          disabled={!client || !latestRuns.length}
        >
          Reference latest run
        </Button>
        {costSummary && (
          <Chip
            size="small"
            label={`turn cost: ${costSummary.total_cents}¢`}
            color={costSummary.total_cents >= 50 ? 'warning' : 'default'}
          />
        )}
      </Stack>

      <Divider />

      <Box
        sx={{
          minHeight: 320,
          maxHeight: 520,
          overflow: 'auto',
          bgcolor: 'background.default',
          p: 1.5,
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 1
        }}
      >
        {renderable.length === 0 && (
          <EmptyState
            title="Ask a question about this client"
            message="Try: 'Is GTM installed?' or 'Why did Google Ads conversions drop last week?'"
          />
        )}
        {renderable.map((row, idx) =>
          row.kind === 'msg' ? (
            <MessageBubble key={idx} role={row.role} text={row.text} />
          ) : (
            <ToolCallCard key={idx} name={row.name} state={row.state} summary={row.summary} />
          )
        )}
      </Box>

      <Stack direction="row" spacing={1}>
        <TextField
          fullWidth
          multiline
          minRows={1}
          maxRows={6}
          size="small"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={client ? 'Ask the supervisor…' : 'Pick a client first'}
          disabled={!client || busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <LoadingButton
          variant="contained"
          startIcon={<SendIcon />}
          onClick={() => send()}
          disabled={!client || !prompt.trim()}
          loading={busy}
          loadingLabel="Thinking…"
        >
          Send
        </LoadingButton>
      </Stack>

      <Typography variant="caption" color="text.secondary">
        Per-turn budget cap: 50¢. Cmd/Ctrl+Enter to send.
      </Typography>

      <ApprovalDialog
        open={Boolean(pendingApproval)}
        approval={pendingApproval}
        onApprove={handleApprove}
        onReject={handleReject}
        onDismiss={() => setPendingApproval(null)}
      />
    </Stack>
  );
}
