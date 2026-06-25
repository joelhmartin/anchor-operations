// src/views/admin/Operations/Chat/ClientChat.jsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Stack, Box, Paper, Autocomplete, TextField, Select, MenuItem, Typography, Chip, Button } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import { useToast } from 'contexts/ToastContext';
import { listOpsClients, listOpsChatThreads, getOpsChatThread, approveOpsChatAction, rejectOpsChatAction } from 'api/ops';
import { streamOpsChat } from 'api/opsChatStream';
import { clientLabel } from '../_clientLabel';
import Markdown from 'ui-component/extended/Markdown';
import ThreadSidebar from './ThreadSidebar';
import ApprovalDialog from './ApprovalDialog';

const MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced)' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 (fast)' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (deep)' }
];

// Flatten persisted Anthropic content blocks into render rows.
function rowsFromMessages(messages) {
  const rows = [];
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    for (const b of blocks) {
      if (b.type === 'text') rows.push({ kind: 'text', role: m.role, text: b.text });
      else if (b.type === 'thinking') rows.push({ kind: 'thinking', text: b.thinking || '' });
      else if (b.type === 'tool_use') rows.push({ kind: 'tool_use', id: b.id, name: b.name, input: b.input, state: 'running', result: null });
      else if (b.type === 'tool_result') {
        const target = [...rows].reverse().find((r) => r.kind === 'tool_use' && r.id === b.tool_use_id);
        if (target) {
          let parsed = b.content;
          try { parsed = typeof b.content === 'string' ? JSON.parse(b.content) : b.content; } catch { parsed = b.content; }
          target.result = parsed;
          target.state = 'done';
        }
      }
    }
  }
  return rows;
}

export default function ClientChat({ initialClientUserId, lockedClientUserId }) {
  const toast = useToast();
  const [clients, setClients] = useState([]);
  const [client, setClient] = useState(null);
  const [threads, setThreads] = useState([]);
  const [threadId, setThreadId] = useState(null);
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [rows, setRows] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamThinking, setStreamThinking] = useState('');
  const [streamTools, setStreamTools] = useState([]);
  const [pendingApproval, setPendingApproval] = useState(null);
  const [cost, setCost] = useState(null);
  const abortRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => { listOpsClients().then(setClients).catch(() => {}); }, []);
  useEffect(() => {
    if (initialClientUserId && clients.length) setClient(clients.find((c) => c.id === initialClientUserId) || null);
  }, [initialClientUserId, clients]);
  useEffect(() => {
    if (!lockedClientUserId) return;
    if (clients.length) setClient(clients.find((c) => c.id === lockedClientUserId) || null);
  }, [lockedClientUserId, clients]);
  const refreshThreads = useCallback(() => {
    listOpsChatThreads(client?.id).then(setThreads).catch(() => {});
  }, [client]);
  useEffect(() => { refreshThreads(); }, [refreshThreads]);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [rows, streamText, streamThinking, streamTools]);

  const openThread = useCallback(async (id) => {
    setThreadId(id);
    setStreamText(''); setStreamThinking(''); setStreamTools([]);
    if (!id) { setRows([]); return; }
    try {
      const data = await getOpsChatThread(id);
      setRows(rowsFromMessages((data.messages || []).map((r) => ({ role: r.role, content: r.content_json }))));
      if (data.thread?.model_id) setModel(data.thread.model_id);
    } catch { toast.error('Could not load conversation'); }
  }, [toast]);

  const newChat = useCallback(() => { setThreadId(null); setRows([]); setStreamText(''); setStreamThinking(''); setStreamTools([]); }, []);

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text) return;
    if (!client) { toast.warning('Pick a client first'); return; }
    setBusy(true);
    setRows((r) => [...r, { kind: 'text', role: 'user', text }]);
    setPrompt(''); setStreamText(''); setStreamThinking(''); setStreamTools([]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const done = await streamOpsChat({
        clientUserId: client.id, threadId, prompt: text, modelId: model, signal: controller.signal,
        onEvent: (evt) => {
          if (evt.type === 'text') setStreamText((s) => s + (evt.delta || ''));
          else if (evt.type === 'thinking') setStreamThinking((s) => s + (evt.delta || ''));
          else if (evt.type === 'tool_use') setStreamTools((t) => [...t, { name: evt.name, input: evt.input, state: 'running' }]);
          else if (evt.type === 'tool_result') setStreamTools((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, state: 'done', result: evt.result } : x)));
          else if (evt.type === 'cost') setCost(evt.summary);
        }
      });
      // Reconcile: reload the thread so persisted blocks render canonically.
      if (done?.threadId) { setThreadId(done.threadId); await openThread(done.threadId); refreshThreads(); }
      if (done?.pendingApproval) setPendingApproval(done.pendingApproval);
      if (done?.costSummary) setCost(done.costSummary);
      if (done?.status === 'budget_exhausted') toast.warning('Per-turn budget hit — split the question');
    } catch (e) {
      if (e.name === 'AbortError') toast.info('Stopped');
      else toast.error(e.message || 'Chat failed');
    } finally {
      setBusy(false); abortRef.current = null;
      setStreamText(''); setStreamThinking(''); setStreamTools([]);
    }
  }, [prompt, client, threadId, model, toast, openThread, refreshThreads]);

  const stop = useCallback(() => { abortRef.current?.abort(); }, []);

  const handleApprove = useCallback(async (id) => {
    try { await approveOpsChatAction(id); setPendingApproval(null); if (threadId) await openThread(threadId); }
    catch { toast.error('Approval failed'); }
  }, [threadId, openThread, toast]);
  const handleReject = useCallback(async (id) => {
    try { await rejectOpsChatAction(id); setPendingApproval(null); if (threadId) await openThread(threadId); }
    catch { toast.error('Reject failed'); }
  }, [threadId, openThread, toast]);

  const allRows = useMemo(() => {
    const live = [];
    if (streamThinking) live.push({ kind: 'thinking', text: streamThinking });
    streamTools.forEach((t) => live.push({ kind: 'tool_use', name: t.name, input: t.input, state: t.state, result: t.result }));
    if (streamText) live.push({ kind: 'text', role: 'assistant', text: streamText });
    return [...rows, ...live];
  }, [rows, streamText, streamThinking, streamTools]);

  return (
    <Stack direction="row" spacing={2} sx={{ height: '70vh' }}>
      <ThreadSidebar threads={threads} activeId={threadId} onSelect={openThread} onNew={newChat} />
      <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          {!lockedClientUserId && (
            <Autocomplete sx={{ flex: 1 }} size="small" options={clients} value={client}
              getOptionLabel={(c) => clientLabel(c)} onChange={(_, v) => { setClient(v); newChat(); }}
              renderInput={(p) => <TextField {...p} label="Client" />} />
          )}
          <Select size="small" value={model} onChange={(e) => setModel(e.target.value)} sx={{ minWidth: 200 }}>
            {MODELS.map((m) => <MenuItem key={m.id} value={m.id}>{m.label}</MenuItem>)}
          </Select>
        </Stack>

        <Box ref={scrollRef} sx={{ flex: 1, overflowY: 'auto', p: 1, bgcolor: 'grey.50', borderRadius: 1 }}>
          {allRows.map((row, i) => {
            if (row.kind === 'text') return (
              <Paper key={i} sx={{ p: 1.5, mb: 1, maxWidth: '85%', ml: row.role === 'user' ? 'auto' : 0, bgcolor: row.role === 'user' ? 'primary.lighter' : 'background.paper' }}>
                {row.role === 'user' ? <Typography sx={{ whiteSpace: 'pre-wrap' }}>{row.text}</Typography> : <Markdown>{row.text}</Markdown>}
              </Paper>
            );
            if (row.kind === 'thinking') return (
              <Box key={i} sx={{ mb: 1 }}>
                <Chip size="small" label="thinking" sx={{ mb: 0.5 }} />
                <Typography variant="caption" sx={{ display: 'block', whiteSpace: 'pre-wrap', color: 'text.secondary', pl: 1 }}>{row.text}</Typography>
              </Box>
            );
            if (row.kind === 'tool_use') return (
              <Paper key={i} variant="outlined" sx={{ p: 1, mb: 1, bgcolor: 'grey.100' }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip size="small" color={row.state === 'done' ? 'success' : 'info'} label={row.name} />
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>{JSON.stringify(row.input)}</Typography>
                </Stack>
                {row.result != null && (
                  <Box component="pre" sx={{ mt: 0.5, m: 0, fontSize: '0.75rem', whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>
                    {typeof row.result === 'string' ? row.result : JSON.stringify(row.result, null, 2)}
                  </Box>
                )}
              </Paper>
            );
            return null; // tool_result is shown inline on the tool_use card
          })}
        </Box>

        {cost && <Typography variant="caption" sx={{ color: 'text.secondary' }}>This turn: {cost.total_cents}¢ · {cost.total_tokens} tokens</Typography>}

        <Stack direction="row" spacing={1} alignItems="flex-end">
          <TextField fullWidth multiline minRows={1} maxRows={6} size="small" placeholder="Ask about this client…"
            value={prompt} onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } }} />
          {busy
            ? <Button color="warning" variant="outlined" startIcon={<StopIcon />} onClick={stop}>Stop</Button>
            : <Button variant="contained" endIcon={<SendIcon />} disabled={!client || !prompt.trim()} onClick={send}>Send</Button>}
        </Stack>
      </Stack>

      <ApprovalDialog open={Boolean(pendingApproval)} approval={pendingApproval}
        onApprove={handleApprove} onReject={handleReject} onDismiss={() => setPendingApproval(null)} />
    </Stack>
  );
}
