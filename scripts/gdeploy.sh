#!/bin/bash
set -euo pipefail
# Deploy the anchor-ops Cloud Run SERVICE (web + API + WS) from source.
#   ./scripts/gdeploy.sh [--dry-run] [--skip-migrate]
#
# Uses `gcloud run deploy --source` so Cloud Build builds the image natively on
# amd64 (Cloud Run's arch) and pushes it to the `cloud-run-source-deploy` repo
# the service already runs from. This is an INCREMENTAL deploy: it ships the
# current code and ensures the content-suite secrets are mapped, while PRESERVING
# the service's existing service account, env vars, Cloud SQL connection, scaling,
# and all other secrets (that config is the live service's own state — this
# script intentionally does not redefine it).
#
# MIGRATIONS (expand pattern): before deploying, this runs the ops migrations as
# ADMIN via the Cloud SQL Auth Proxy. The Cloud Run service connects as the
# least-privilege `ops_app` role (RUN_MIGRATIONS_ON_START=false) which cannot run
# DDL, so migrations MUST run as admin — and they run BEFORE the code deploy so
# new columns/tables exist before the new code references them. Migrations are
# idempotent (CREATE TABLE/ADD COLUMN IF NOT EXISTS), so re-running every deploy is
# safe. Admin creds stay on this machine (fetched from Secret Manager at deploy
# time); nothing is stored in CI. Pass --skip-migrate to deploy without migrating.
#
# History: the previous version did a local `docker build` + push to a repo named
# `anchor-hub-repo`. On Apple Silicon that produced an arm64 image (Cloud Run
# rejects it: "exec format error"), and `anchor-hub-repo` does not exist. All of
# that was removed in favour of `--source`.

PROJECT_ID="anchor-hub-480305"
REGION="us-central1"
SERVICE_NAME="anchor-ops"
SQL_INSTANCE="anchor-hub-480305:us-central1:anchor"
ADMIN_DB_SECRET="DATABASE_URL" # the full-privilege admin connection (NOT anchor-db-url-ops)

# Content suite (social publishing) secrets — the SAME Secret Manager secrets the
# main app (anchor-hub) uses, so page-token decryption and media-token validation
# work across both apps. DATABASE_URL / JWT_SECRET / ENCRYPTION_KEY are already on
# the service and are preserved (no need to re-set them every deploy).
SECRETS="SOCIAL_MEDIA_SECRET=SOCIAL_MEDIA_SECRET:latest"
SECRETS+=",FACEBOOK_SYSTEM_USER_TOKEN=FACEBOOK_SYSTEM_USER_TOKEN:latest"
SECRETS+=",ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest"

DRY_RUN="false"
SKIP_MIGRATE="false"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="true" ;;
    --skip-migrate) SKIP_MIGRATE="true" ;;
  esac
done

# Locate the Cloud SQL Auth Proxy binary.
find_proxy() {
  if command -v cloud-sql-proxy >/dev/null 2>&1; then command -v cloud-sql-proxy; return; fi
  for p in "$HOME/google-cloud-sdk/bin/cloud-sql-proxy" "/usr/local/bin/cloud-sql-proxy"; do
    [[ -x "$p" ]] && { echo "$p"; return; }
  done
  return 1
}

run_migrations() {
  echo "=== Running ops migrations as admin (expand: before deploy) ==="
  local proxy; proxy="$(find_proxy)" || { echo "ERROR: cloud-sql-proxy not found on PATH or in the gcloud SDK bin." >&2; exit 1; }

  # Pick a free local port.
  local port=""
  for p in 6543 6544 7654 7655; do
    if ! (command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1); then port="$p"; break; fi
  done
  [[ -n "$port" ]] || { echo "ERROR: no free local port for the proxy." >&2; exit 1; }

  "$proxy" --port "$port" "$SQL_INSTANCE" --quiet >/tmp/gdeploy-proxy.log 2>&1 &
  local proxy_pid=$!
  trap 'kill "$proxy_pid" 2>/dev/null || true' EXIT

  # Wait for the proxy to accept connections.
  local i
  for i in $(seq 1 15); do
    if (command -v pg_isready >/dev/null 2>&1 && pg_isready -h 127.0.0.1 -p "$port" >/dev/null 2>&1); then break; fi
    sleep 1
  done

  # Build the admin connection string from Secret Manager, repointed at the proxy.
  local raw userpass admin_url
  raw="$(gcloud secrets versions access latest --secret="$ADMIN_DB_SECRET" --project "$PROJECT_ID")"
  userpass="$(echo "$raw" | sed -E 's#^postgres(ql)?://([^@]+)@.*#\2#')"
  admin_url="postgresql://${userpass}@127.0.0.1:${port}/anchor"

  # Run the idempotent ops migrations as admin. Fail the deploy if they fail.
  DATABASE_URL="$admin_url" RUN_MIGRATIONS_ON_START=true yarn db:migrate

  kill "$proxy_pid" 2>/dev/null || true
  trap - EXIT
  echo "=== Migrations applied. ==="
}

echo "=== Deploy ${SERVICE_NAME} from source (dry-run=${DRY_RUN}, skip-migrate=${SKIP_MIGRATE}) ==="

if [[ "$DRY_RUN" == "true" ]]; then
  [[ "$SKIP_MIGRATE" == "true" ]] || echo "[dry-run] would run ops migrations as admin via Cloud SQL proxy (instance ${SQL_INSTANCE})"
  echo "[dry-run] gcloud run deploy ${SERVICE_NAME} --source . \\"
  echo "            --project=${PROJECT_ID} --region=${REGION} \\"
  echo "            --update-secrets=${SECRETS}"
  exit 0
fi

[[ "$SKIP_MIGRATE" == "true" ]] || run_migrations

gcloud run deploy "${SERVICE_NAME}" --source . \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --update-secrets="${SECRETS}"

echo "=== Deployed (migrations ran as admin before deploy unless --skip-migrate). ==="
