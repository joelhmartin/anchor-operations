import { Client } from 'ssh2';
import SftpClient from 'ssh2-sftp-client';
import { decrypt } from '../../security/encryption.js';
import { query } from '../../../db.js';
import { getSshPassword } from './kinstaApi.js';
import { encrypt } from '../../security/encryption.js';

const DEFAULT_EXEC_TIMEOUT_MS = 30000;
const READY_TIMEOUT_MS = 15000;

function loadEnvironmentRow(environmentId) {
  return query(
    `SELECT id, kinsta_environment_id, ssh_host, ssh_port, ssh_username, ssh_password_encrypted, metadata
     FROM kinsta_environments
     WHERE id = $1
     LIMIT 1`,
    [environmentId]
  ).then((res) => res.rows[0] || null);
}

function isReadOnlyEnv(envRow) {
  return Boolean(envRow?.metadata?.read_only);
}

function isReadVerb(command) {
  const lower = String(command || '').trim().toLowerCase();
  // Strip the leading `cd /www/...&& wp ` if present
  const wpStart = lower.indexOf('wp ');
  const tail = wpStart >= 0 ? lower.slice(wpStart + 3) : lower;
  const verb = tail.split(/\s+/, 2)[0] || '';
  // Read-allowed verbs:
  return ['list', 'get', 'search', 'status', '--info', 'core', 'config'].some((v) =>
    verb.startsWith(v)
  ) || tail.startsWith('option get') || tail.startsWith('post list');
}

async function ensurePassword(envRow) {
  if (envRow.ssh_password_encrypted) {
    const plaintext = decrypt(envRow.ssh_password_encrypted);
    if (plaintext) return plaintext;
  }
  if (!envRow.kinsta_environment_id) return null;

  const fresh = await getSshPassword(envRow.kinsta_environment_id);
  if (!fresh) return null;

  const encrypted = encrypt(fresh);
  if (encrypted) {
    await query(
      `UPDATE kinsta_environments
       SET ssh_password_encrypted = $1, ssh_password_fetched_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [encrypted, envRow.id]
    );
  }
  return fresh;
}

function buildClientConfig(envRow, password) {
  if (!envRow.ssh_host || !envRow.ssh_username) {
    throw new Error('SSH host or username missing for environment');
  }
  return {
    host: envRow.ssh_host,
    port: envRow.ssh_port || 22,
    username: envRow.ssh_username,
    password,
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: 15000,
    algorithms: {
      serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']
    }
  };
}

async function connectClient(environmentId) {
  const envRow = await loadEnvironmentRow(environmentId);
  if (!envRow) throw new Error('Environment not found');
  const password = await ensurePassword(envRow);
  if (!password) throw new Error('Could not resolve SSH password for environment');

  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.once('ready', resolve);
    conn.once('error', reject);
    conn.connect(buildClientConfig(envRow, password));
  });
  return { conn, envRow };
}

function logCommand({ environmentId, userId, channel, commandSummary, exitCode, durationMs, triggeredBy }) {
  return query(
    `INSERT INTO kinsta_ssh_command_log
       (environment_id, user_id, channel, command_summary, exit_code, duration_ms, triggered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      environmentId,
      userId,
      channel,
      commandSummary ? commandSummary.slice(0, 200) : null,
      exitCode,
      durationMs,
      triggeredBy || null
    ]
  ).catch((err) => {
    console.warn('[sshClient] command log insert failed:', err.message);
  });
}

export async function execCommand(
  environmentId,
  command,
  { userId, timeoutMs = DEFAULT_EXEC_TIMEOUT_MS, triggeredBy = 'manual' } = {}
) {
  if (!command) throw new Error('command required');

  // Read-only enforcement: refuse any non-read command on locked envs.
  // Belt + suspenders — the agent guard rails should block first, but this
  // guarantees no path bypasses the lock.
  const lockCheck = await loadEnvironmentRow(environmentId);
  if (lockCheck && isReadOnlyEnv(lockCheck) && !isReadVerb(command)) {
    throw new Error('Environment is marked read-only; non-read commands are blocked.');
  }

  const { conn, envRow } = await connectClient(environmentId);
  const startedAt = Date.now();

  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.end();
        reject(new Error(`SSH exec timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }
        let stdout = '';
        let stderr = '';
        let exitCode = null;
        stream.on('data', (chunk) => {
          stdout += chunk.toString('utf8');
        });
        stream.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });
        stream.on('close', (code) => {
          clearTimeout(timer);
          exitCode = typeof code === 'number' ? code : null;
          resolve({ stdout, stderr, exitCode });
        });
      });
    });

    const durationMs = Date.now() - startedAt;
    if (userId) {
      logCommand({
        environmentId: envRow.id,
        userId,
        channel: 'exec',
        commandSummary: command,
        exitCode: result.exitCode,
        durationMs,
        triggeredBy
      });
    }
    return { ...result, durationMs };
  } finally {
    conn.end();
  }
}

export async function openShellChannel(
  environmentId,
  { rows = 24, cols = 80, term = 'xterm-256color' } = {}
) {
  const { conn, envRow } = await connectClient(environmentId);

  const stream = await new Promise((resolve, reject) => {
    conn.shell({ rows, cols, term }, (err, channel) => {
      if (err) return reject(err);
      resolve(channel);
    });
  });

  return {
    envRow,
    stream,
    end() {
      try {
        conn.end();
      } catch (err) {
        console.warn('[sshClient] shell end error:', err.message);
      }
    }
  };
}

export async function withSftp(environmentId, fn, { userId, triggeredBy = 'manual' } = {}) {
  const envRow = await loadEnvironmentRow(environmentId);
  if (!envRow) throw new Error('Environment not found');
  const password = await ensurePassword(envRow);
  if (!password) throw new Error('Could not resolve SSH password for environment');

  const sftp = new SftpClient();
  const startedAt = Date.now();
  try {
    await sftp.connect({
      ...buildClientConfig(envRow, password),
      retries: 1
    });
    const result = await fn(sftp);
    if (userId) {
      logCommand({
        environmentId: envRow.id,
        userId,
        channel: 'sftp',
        commandSummary: 'sftp session',
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        triggeredBy
      });
    }
    return result;
  } catch (err) {
    if (userId) {
      logCommand({
        environmentId: envRow.id,
        userId,
        channel: 'sftp',
        commandSummary: `sftp error: ${err.message}`.slice(0, 200),
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        triggeredBy
      });
    }
    throw err;
  } finally {
    try {
      await sftp.end();
    } catch {
      /* ignore */
    }
  }
}

export async function wpcli(environmentId, args, opts = {}) {
  const envRow = await loadEnvironmentRow(environmentId);
  if (!envRow?.ssh_username) throw new Error('Environment SSH username not set');
  const command = `cd /www/${envRow.ssh_username}_*/public && wp ${args}`;
  return execCommand(environmentId, command, { ...opts, triggeredBy: opts.triggeredBy || 'wpcli' });
}
