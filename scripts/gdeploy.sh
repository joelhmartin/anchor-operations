#!/bin/bash
set -euo pipefail
# Deploy the anchor-ops Cloud Run SERVICE (web + API + WS) from source.
#   ./scripts/gdeploy.sh [--dry-run]
#
# Uses `gcloud run deploy --source` so Cloud Build builds the image natively on
# amd64 (Cloud Run's arch) and pushes it to the `cloud-run-source-deploy` repo
# the service already runs from. This is an INCREMENTAL deploy: it ships the
# current code and ensures the content-suite secrets are mapped, while PRESERVING
# the service's existing service account, env vars, Cloud SQL connection, scaling,
# and all other secrets (that config is the live service's own state — this
# script intentionally does not redefine it).
#
# History: the previous version did a local `docker build` + push to a repo named
# `anchor-hub-repo`. On Apple Silicon that produced an arm64 image (Cloud Run
# rejects it: "exec format error"), and `anchor-hub-repo` does not exist. It also
# passed a `--service-account` / `--set-env-vars` set that did not match the live
# service. All of that was removed in favour of `--source`.

PROJECT_ID="anchor-hub-480305"
REGION="us-central1"
SERVICE_NAME="anchor-ops"

# Content suite (social publishing) secrets — the SAME Secret Manager secrets the
# main app (anchor-hub) uses, so page-token decryption and media-token validation
# work across both apps. DATABASE_URL / JWT_SECRET / ENCRYPTION_KEY are already on
# the service and are preserved (no need to re-set them every deploy).
SECRETS="SOCIAL_MEDIA_SECRET=SOCIAL_MEDIA_SECRET:latest"
SECRETS+=",FACEBOOK_SYSTEM_USER_TOKEN=FACEBOOK_SYSTEM_USER_TOKEN:latest"
SECRETS+=",ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest"

DRY_RUN="false"; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN="true"

echo "=== Deploy ${SERVICE_NAME} from source (dry-run=${DRY_RUN}) ==="
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] gcloud run deploy ${SERVICE_NAME} --source . \\"
  echo "            --project=${PROJECT_ID} --region=${REGION} \\"
  echo "            --update-secrets=${SECRETS}"
  exit 0
fi

gcloud run deploy "${SERVICE_NAME}" --source . \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --update-secrets="${SECRETS}"

echo "=== Deployed. RUN_MIGRATIONS_ON_START is false — run ops migrations once as admin (see infra/provision-ops.sh). ==="
