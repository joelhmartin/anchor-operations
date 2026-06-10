/**
 * Operations WebSocket terminal (Kinsta SSH).
 *
 * Path: /ws/ssh
 * Query: envId=<uuid>, token=<jwt-access-token>
 *
 * Admin-only. Every session writes a row to kinsta_ssh_command_log on close.
 * Idle timeout 30m; hard cap 4h.
 */

import { WebSocketServer } from 'ws';
import { URL } from 'node:url';
import { verifyAccessToken, validateSession } from '../services/security/index.js';
import { query } from '../db.js';
import { getEffectiveRole } from '../utils/roles.js';
import { openShellChannel } from '../services/ops/operations-website/sshClient.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const HARD_CAP_MS = 4 * 60 * 60 * 1000;
const INPUT_LOG_LIMIT = 200;

async function authenticateUpgrade(token) {
  if (!token) return null;
  const payload = verifyAccessToken(token);
  if (!payload) return null;

  const sessionCheck = await validateSession(payload.sessionId);
  if (!sessionCheck.valid) return null;

  const { rows } = await query(
    'SELECT id, role FROM users WHERE id = $1 LIMIT 1',
    [payload.userId]
  );
  const user = rows[0];
  if (!user) return null;

  const effectiveRole = await getEffectiveRole(user.role);
  if (effectiveRole !== 'admin' && effectiveRole !== 'superadmin') return null;

  return { userId: user.id, role: effectiveRole };
}

function safeSend(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (err) {
    console.warn('[ws/ssh] send failed:', err.message);
  }
}

async function logSession({ environmentId, userId, summary, exitCode, durationMs }) {
  try {
    await query(
      `INSERT INTO kinsta_ssh_command_log
         (environment_id, user_id, channel, command_summary, exit_code, duration_ms, triggered_by)
       VALUES ($1, $2, 'shell', $3, $4, $5, 'manual')`,
      [
        environmentId,
        userId,
        summary ? summary.slice(0, INPUT_LOG_LIMIT) : null,
        typeof exitCode === 'number' ? exitCode : null,
        durationMs
      ]
    );
  } catch (err) {
    console.warn('[ws/ssh] log insert failed:', err.message);
  }
}

export function attachOperationsWebSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws/ssh') return; // not for us

    const envId = url.searchParams.get('envId');
    const token = url.searchParams.get('token');

    if (!envId || !UUID_RE.test(envId)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const auth = await authenticateUpgrade(token);
    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, { envId, userId: auth.userId });
    });
  });

  console.log('[ws/ssh] terminal WebSocket attached');
  return wss;
}

async function handleConnection(ws, { envId, userId }) {
  const startedAt = Date.now();
  let shell = null;
  let inputBuffer = '';
  let exitCode = null;
  let idleTimer = null;
  let hardCapTimer = null;
  let closed = false;

  function cleanup(reason) {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    clearTimeout(hardCapTimer);
    try {
      shell?.end();
    } catch {
      /* ignore */
    }
    logSession({
      environmentId: envId,
      userId,
      summary: inputBuffer,
      exitCode,
      durationMs: Date.now() - startedAt
    });
    if (ws.readyState === ws.OPEN) {
      try {
        ws.close(1000, reason || 'closed');
      } catch {
        /* ignore */
      }
    }
  }

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => cleanup('idle'), IDLE_TIMEOUT_MS);
  }

  hardCapTimer = setTimeout(() => cleanup('hard cap'), HARD_CAP_MS);
  resetIdleTimer();

  try {
    shell = await openShellChannel(envId);
  } catch (err) {
    safeSend(ws, { type: 'error', message: err.message || 'SSH connect failed' });
    cleanup('connect error');
    return;
  }

  shell.stream.on('data', (chunk) => {
    safeSend(ws, { type: 'output', data: chunk.toString('utf8') });
  });
  shell.stream.stderr?.on('data', (chunk) => {
    safeSend(ws, { type: 'output', data: chunk.toString('utf8') });
  });
  shell.stream.on('close', (code) => {
    exitCode = typeof code === 'number' ? code : null;
    safeSend(ws, { type: 'exit', code: exitCode });
    cleanup('shell closed');
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    resetIdleTimer();

    if (msg.type === 'input' && typeof msg.data === 'string') {
      inputBuffer = (inputBuffer + msg.data).slice(-INPUT_LOG_LIMIT);
      try {
        shell.stream.write(msg.data);
      } catch (err) {
        safeSend(ws, { type: 'error', message: err.message });
      }
    } else if (msg.type === 'resize' && Number(msg.rows) > 0 && Number(msg.cols) > 0) {
      try {
        shell.stream.setWindow(Number(msg.rows), Number(msg.cols), 0, 0);
      } catch {
        /* ignore */
      }
    }
  });

  ws.on('close', () => cleanup('client closed'));
  ws.on('error', (err) => {
    console.warn('[ws/ssh] client error:', err.message);
    cleanup('client error');
  });

  safeSend(ws, { type: 'ready' });
}
