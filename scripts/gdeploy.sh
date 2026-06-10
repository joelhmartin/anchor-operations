#!/bin/bash
set -euo pipefail
# Build + push + deploy the anchor-ops Cloud Run SERVICE (web + API + WS).
# Idempotent: `gcloud run deploy` creates on first run, updates after.
#   ./scripts/gdeploy.sh [--dry-run]

PROJECT_ID="anchor-hub-480305"
REGION="us-central1"
SERVICE_NAME="anchor-ops"
ARTIFACT_REPO_NAME="anchor-hub-repo"
IMAGE_NAME="anchor-ops"
SERVICE_ACCOUNT_EMAIL="anchor-ops@${PROJECT_ID}.iam.gserviceaccount.com"
CLOUD_SQL_INSTANCE="${PROJECT_ID}:${REGION}:anchor"

DRY_RUN="false"; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN="true"

GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo manual)
IMAGE_TAG="${GIT_SHA}-$(date +%Y%m%d%H%M%S)"
IMG="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO_NAME}/${IMAGE_NAME}:${IMAGE_TAG}"

# Secret env mapping. DATABASE_URL -> ops_app role; AES+JWT reuse anchor-hub's
# (byte-identical => decryption + SSO work). Agency tokens reuse the shared set.
SECRETS="DATABASE_URL=anchor-db-url-ops:latest"
SECRETS+=",ENCRYPTION_KEY=ENCRYPTION_KEY:latest,JWT_SECRET=JWT_SECRET:latest"
SECRETS+=",GOOGLE_ADS_DEVELOPER_TOKEN=GOOGLE_ADS_DEVELOPER_TOKEN:latest"
SECRETS+=",GOOGLE_ADS_REFRESH_TOKEN=GOOGLE_ADS_REFRESH_TOKEN:latest"
SECRETS+=",GOOGLE_ADS_MANAGER_ID=GOOGLE_ADS_MANAGER_ID:latest"
SECRETS+=",GOOGLE_ADS_CLIENT_ID=GOOGLE_ADS_CLIENT_ID:latest"
SECRETS+=",GOOGLE_ADS_CLIENT_SECRET=GOOGLE_ADS_CLIENT_SECRET:latest"
SECRETS+=",FACEBOOK_SYSTEM_USER_TOKEN=FACEBOOK_SYSTEM_USER_TOKEN:latest"
SECRETS+=",KINSTA_API_KEY=KINSTA_API_KEY:latest,KINSTA_USER=KINSTA_USER:latest"
SECRETS+=",KINSTA_USER_PASSWORD=KINSTA_USER_PASSWORD:latest,KINSTA_AGENCY_ID=KINSTA_AGENCY_ID:latest"
SECRETS+=",CTM_API_KEY=CTM_API_KEY:latest,CTM_API_SECRET=CTM_API_SECRET:latest"
SECRETS+=",MAILGUN_API_KEY=MAILGUN_API_KEY:latest,MAILGUN_DOMAIN=MAILGUN_DOMAIN:latest"
SECRETS+=",MAILGUN_DEFAULT_FROM=MAILGUN_DEFAULT_FROM:latest"
SECRETS+=",GA4_SERVICE_ACCOUNT_KEY=GA4_SERVICE_ACCOUNT_KEY:latest"
SECRETS+=",REPORT_RENDER_SECRET=report-render-secret:latest"

ENVVARS="NODE_ENV=production,RUN_MIGRATIONS_ON_START=false"
ENVVARS+=",GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_REGION=${REGION}"
ENVVARS+=",VERTEX_PROJECT_ID=${PROJECT_ID},VERTEX_LOCATION=${REGION}"
ENVVARS+=",OPS_REPORTS_BUCKET=anchor-ops-reports-${PROJECT_ID}"
ENVVARS+=",OPS_RUN_SUBSCRIPTION=ops-runner,OPS_RUNNER_CONCURRENCY=4"

echo "=== Deploy ${SERVICE_NAME} (dry-run=${DRY_RUN}) image=${IMG} ==="
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] docker build -t ${IMG} . && push && gcloud run deploy ${SERVICE_NAME} ..."
  echo "[dry-run] secrets: ${SECRETS}"
  exit 0
fi

docker build -t "${IMG}" .
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
docker push "${IMG}"

gcloud run deploy "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --image="${IMG}" \
  --service-account="${SERVICE_ACCOUNT_EMAIL}" \
  --add-cloudsql-instances="${CLOUD_SQL_INSTANCE}" \
  --set-secrets="${SECRETS}" \
  --set-env-vars="${ENVVARS}" \
  --memory=1Gi --cpu=1 --min-instances=0 --max-instances=4 \
  --allow-unauthenticated

echo "=== Deployed. RUN_MIGRATIONS_ON_START is false — run migrations once as admin (see infra/provision-ops.sh). ==="
