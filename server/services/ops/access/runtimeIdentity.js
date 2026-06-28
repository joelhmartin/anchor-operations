/**
 * Detect the runtime identity (north-star §0.2 Google Cloud / Cloud Run).
 * metadata fetch is injectable so tests run with zero network.
 */
const METADATA_BASE = 'http://metadata.google.internal/computeMetadata/v1/';

async function defaultFetchMetadata(path) {
  // Only meaningful on GCP; callers gate this to Cloud Run.
  try {
    const res = await fetch(METADATA_BASE + path, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) return null;
    return (await res.text()).trim() || null;
  } catch {
    return null;
  }
}

function isLocalDb(url) {
  return typeof url === 'string' && /@(localhost|127\.0\.0\.1)[:/]/.test(url);
}

export async function detectRuntime({ env = process.env, fetchMetadata = defaultFetchMetadata } = {}) {
  const cloudRunService = env.K_SERVICE || null;
  const onCloudRun = Boolean(cloudRunService);

  const environment = onCloudRun ? 'cloud-run' : (isLocalDb(env.DATABASE_URL) ? 'local' : 'unknown');

  let projectId = env.GOOGLE_CLOUD_PROJECT || env.VERTEX_PROJECT_ID || null;
  let serviceAccount = null;

  if (onCloudRun) {
    if (!projectId) projectId = await fetchMetadata('project/project-id');
    serviceAccount = await fetchMetadata('instance/service-accounts/default/email');
  }

  return { environment, projectId: projectId || null, serviceAccount, cloudRunService };
}
