#!/bin/bash
# ============================================================================
# anchor-ops — shared-foundation provisioning (the three-app integration plan §1+§3)
# ============================================================================
# Stands up the GCP foundation for the standalone Operations app INSIDE the
# existing shared project (anchor-hub-480305). Everything here is ADDITIVE and
# idempotent — it does NOT touch the running anchor-hub service. It does write to
# the live project, so it is GUARDED: it prints the plan unless you pass --apply.
#
#   ./infra/provision-ops.sh            # dry run — prints what it WOULD do
#   ./infra/provision-ops.sh --apply    # actually provision
#
# What it does NOT do (you / a later step must):
#   - Create the ops_app DB role:   psql ... -f infra/sql/ops_app_role.sql
#   - Set the anchor-db-url-ops secret VALUE (this only creates the empty secret).
#   - Google OAuth client redirect URIs for the new ops domain (you handle OAuth).
#   - Build + deploy the images:    scripts/gdeploy.sh && scripts/gdeploy-ops-runner.sh
# ============================================================================
set -euo pipefail

PROJECT_ID="anchor-hub-480305"
REGION="us-central1"
OPS_SA_NAME="anchor-ops"
OPS_SA_EMAIL="${OPS_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
REPORTS_BUCKET="anchor-ops-reports-${PROJECT_ID}"

APPLY="false"
[[ "${1:-}" == "--apply" ]] && APPLY="true"

run() {
  echo "+ $*"
  if [[ "$APPLY" == "true" ]]; then "$@"; fi
}

echo "=== anchor-ops provisioning (apply=${APPLY}) — project ${PROJECT_ID} ==="
echo

# --- 1. Enable required APIs ------------------------------------------------
run gcloud services enable \
  run.googleapis.com \
  pubsub.googleapis.com \
  cloudscheduler.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  aiplatform.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  --project="${PROJECT_ID}"

# --- 2. Dedicated least-privilege service account ---------------------------
if ! gcloud iam service-accounts describe "${OPS_SA_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  run gcloud iam service-accounts create "${OPS_SA_NAME}" \
    --display-name="Anchor Operations" --project="${PROJECT_ID}"
else
  echo "  (service account ${OPS_SA_EMAIL} already exists)"
fi

# --- 3. Project-level roles for the ops SA ---------------------------------
for role in \
  roles/cloudsql.client \
  roles/pubsub.subscriber \
  roles/pubsub.publisher \
  roles/aiplatform.user \
  roles/logging.logWriter \
  roles/storage.objectAdmin; do
  run gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${OPS_SA_EMAIL}" --role="${role}" --condition=None
done

# --- 4. Reuse the EXISTING shared secrets (byte-identical AES + JWT = SSO) ---
# Grant the ops SA accessor on each. anchor-db-url-ops is created empty below.
SHARED_SECRETS=(
  ENCRYPTION_KEY JWT_SECRET
  GOOGLE_ADS_DEVELOPER_TOKEN GOOGLE_ADS_REFRESH_TOKEN GOOGLE_ADS_MANAGER_ID
  GOOGLE_ADS_CLIENT_ID GOOGLE_ADS_CLIENT_SECRET
  FACEBOOK_SYSTEM_USER_TOKEN
  KINSTA_API_KEY KINSTA_USER KINSTA_USER_PASSWORD KINSTA_AGENCY_ID
  CTM_API_KEY CTM_API_SECRET
  MAILGUN_API_KEY MAILGUN_DOMAIN MAILGUN_DEFAULT_FROM
  GA4_SERVICE_ACCOUNT_KEY
  report-render-secret
  ANTHROPIC_API_KEY GEMINI_API_KEY
)
for s in "${SHARED_SECRETS[@]}"; do
  run gcloud secrets add-iam-policy-binding "${s}" \
    --member="serviceAccount:${OPS_SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" --project="${PROJECT_ID}"
done

# --- 5. Dedicated DB-url secret for the ops_app role (value set separately) --
if ! gcloud secrets describe anchor-db-url-ops --project="${PROJECT_ID}" >/dev/null 2>&1; then
  run gcloud secrets create anchor-db-url-ops --replication-policy=automatic --project="${PROJECT_ID}"
  echo "  >> set its value AFTER creating the ops_app role:"
  echo "     printf 'postgresql://ops_app:PASS@HOST:5432/anchor' | gcloud secrets versions add anchor-db-url-ops --data-file=- --project=${PROJECT_ID}"
fi
run gcloud secrets add-iam-policy-binding anchor-db-url-ops \
  --member="serviceAccount:${OPS_SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" --project="${PROJECT_ID}"

# --- 6. Pub/Sub topology (see infra/pubsub/ops.tf) -------------------------
for t in ops.run.requested ops.run.completed ops.run.cancel ops.run.dead; do
  if ! gcloud pubsub topics describe "$t" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    run gcloud pubsub topics create "$t" --project="${PROJECT_ID}"
  fi
done
if ! gcloud pubsub subscriptions describe ops-runner --project="${PROJECT_ID}" >/dev/null 2>&1; then
  run gcloud pubsub subscriptions create ops-runner \
    --topic=ops.run.requested --ack-deadline=600 \
    --dead-letter-topic=ops.run.dead --max-delivery-attempts=5 \
    --min-retry-delay=10s --max-retry-delay=600s --project="${PROJECT_ID}"
fi
if ! gcloud pubsub subscriptions describe ops-runner-cancel --project="${PROJECT_ID}" >/dev/null 2>&1; then
  run gcloud pubsub subscriptions create ops-runner-cancel \
    --topic=ops.run.cancel --ack-deadline=60 --project="${PROJECT_ID}"
fi

# --- 7. GCS bucket for rendered HTML reports -------------------------------
if ! gcloud storage buckets describe "gs://${REPORTS_BUCKET}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  run gcloud storage buckets create "gs://${REPORTS_BUCKET}" \
    --location="${REGION}" --uniform-bucket-level-access --project="${PROJECT_ID}"
fi

echo
echo "=== Provisioning plan complete (apply=${APPLY}). Next: ==="
echo "  1. psql \"\$ADMIN_DATABASE_URL\" -v ops_password=\"'<pw>'\" -f infra/sql/ops_app_role.sql"
echo "  2. Set anchor-db-url-ops secret value (see step 5 above)."
echo "  3. Run ops migrations once as admin: DATABASE_URL=\$ADMIN_DATABASE_URL RUN_MIGRATIONS_ON_START=true yarn db:migrate"
echo "  4. scripts/gdeploy.sh           # deploy the anchor-ops Cloud Run service"
echo "  5. scripts/gdeploy-ops-runner.sh # deploy the anchor-ops-runner Job"
echo "  6. You: add the ops domain redirect URIs to the Google OAuth client."
