import axios from 'axios';

const KINSTA_API_BASE = 'https://api.kinsta.com/v2';
const DEFAULT_TIMEOUT_MS = 20000;

function authHeaders() {
  const apiKey = process.env.KINSTA_API_KEY;
  if (!apiKey) throw new Error('KINSTA_API_KEY not set');
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
}

function backoffDelay(attempt, capMs = 8000) {
  return Math.min(1000 * 2 ** (attempt - 1), capMs);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function listAllSites() {
  const agencyId = process.env.KINSTA_AGENCY_ID;
  if (!agencyId) throw new Error('KINSTA_AGENCY_ID not set');

  const res = await axios.get(`${KINSTA_API_BASE}/sites`, {
    params: { company: agencyId, include_environments: true },
    headers: authHeaders(),
    timeout: DEFAULT_TIMEOUT_MS
  });
  return res.data?.company?.sites || [];
}

export async function getEnvironmentDetail(environmentId) {
  const res = await axios.get(`${KINSTA_API_BASE}/sites/environments/${environmentId}`, {
    headers: authHeaders(),
    timeout: DEFAULT_TIMEOUT_MS
  });
  return res.data?.site?.environment || res.data?.environment || null;
}

export async function pushEnvironment(siteId, sourceEnvId, targetEnvId) {
  const res = await axios.put(
    `${KINSTA_API_BASE}/sites/${siteId}/environments`,
    {
      source_environment: sourceEnvId,
      target_environment: targetEnvId,
      push_db: true,
      push_files: true,
      run_search_and_replace: true
    },
    { headers: authHeaders(), timeout: DEFAULT_TIMEOUT_MS }
  );
  return {
    operation_id: res.data?.operation_id,
    message: res.data?.message || 'Push started',
    status: res.status
  };
}

export async function getOperationStatus(operationId) {
  try {
    const res = await axios.get(`${KINSTA_API_BASE}/operations/${operationId}`, {
      headers: authHeaders(),
      timeout: DEFAULT_TIMEOUT_MS,
      validateStatus: (status) => status < 500
    });
    if (res.status === 404) {
      return { status: 'in_progress', message: 'Operation pending registration' };
    }
    if (res.status >= 400) {
      throw new Error(`Kinsta operation status failed: ${res.status}`);
    }
    return { status: res.data?.status || 'unknown', message: res.data?.message || '' };
  } catch (err) {
    if (err.response?.status === 404) {
      return { status: 'in_progress', message: 'Operation pending registration' };
    }
    throw err;
  }
}

export async function getSshPassword(environmentId, { retries = 3 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await axios.get(
        `${KINSTA_API_BASE}/sites/environments/${environmentId}/ssh/password`,
        {
          headers: authHeaders(),
          timeout: DEFAULT_TIMEOUT_MS,
          validateStatus: () => true
        }
      );

      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt < retries) {
          await sleep(backoffDelay(attempt));
          continue;
        }
        console.warn(`[kinstaApi] giving up on ${environmentId} after ${retries} ${res.status} responses`);
        return null;
      }

      if (res.status >= 400) {
        console.warn(`[kinstaApi] ssh password ${environmentId} failed with ${res.status}`);
        return null;
      }

      return (
        res.data?.environment?.sftp_password ||
        res.data?.password ||
        null
      );
    } catch (err) {
      if (attempt < retries) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      console.error(`[kinstaApi] ssh password ${environmentId} network error:`, err.message);
      return null;
    }
  }
  return null;
}

export function pickKinstaEnvironmentSummary(env) {
  return {
    kinsta_environment_id: env.id,
    environment_name: env.name || env.display_name || 'unknown',
    is_live: (env.display_name || env.name || '').toLowerCase() === 'live',
    primary_domain: env.primaryDomain?.name || env.primary_domain?.name || null,
    ssh_host: env.ssh_connection?.ssh_ip?.external_ip || null,
    ssh_ip: env.ssh_connection?.ssh_ip?.external_ip || null,
    ssh_port: Number(env.ssh_connection?.ssh_port) || null,
    ssh_username: env.container_info?.ssh_username || null
  };
}
