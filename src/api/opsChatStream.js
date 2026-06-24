import { getAccessToken } from './tokenStore';

const API_BASE = import.meta.env.VITE_APP_API_BASE || '/api';

// POST /ops/chat and parse the SSE stream. Calls onEvent({type, ...}) per frame.
// Resolves with the `done` payload; rejects on `error` frame or network failure.
export async function streamOpsChat({ clientUserId, threadId, prompt, modelId, signal, onEvent }) {
  const token = getAccessToken();
  const resp = await fetch(`${API_BASE}/ops/chat`, {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ client_user_id: clientUserId || null, thread_id: threadId || null, prompt, model_id: modelId || null })
  });
  if (!resp.ok || !resp.body) {
    let msg = `Chat failed (${resp.status})`;
    try { msg = (await resp.json()).message || msg; } catch { /* not json */ }
    throw new Error(msg);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = null;
  let errored = null;

  // SSE frames are separated by a blank line; each frame has `event:` + `data:` lines.
  const handleFrame = (frame) => {
    const lines = frame.split('\n');
    let event = 'message';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    const payload = JSON.parse(data);
    if (event === 'done') done = payload;
    else if (event === 'error') errored = new Error(payload.message || 'Chat failed');
    else onEvent({ type: event, ...payload });
  };

  for (;;) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.trim()) handleFrame(frame);
    }
  }
  if (errored) throw errored;
  return done;
}
