# anchor-ops

The **Operations command center**, extracted from the `anchor-hub` monorepo into a
standalone app. It owns the `ops_*` / `kinsta_*` schema in the shared Cloud SQL
database and runs cross-platform health/optimization checks (Website, Google Ads,
Meta, CTM) with an AI supervisor + per-client agent, bulk runs, findings triage,
and Kinsta WordPress site operations.

This repo is one of three that share a single GCP project, one Postgres, and one
Secret Manager. See `anchor-three-app-integration-plan.md` for the full design.

## Stack

| Layer | Tech |
|------|------|
| Frontend | React 19 + Vite 7 + MUI 7 (JSX) — the Berry admin shell, trimmed to Operations only |
| Backend | Express 4 + Node 20 (ESM) |
| DB | PostgreSQL 15 (shared `anchor` Cloud SQL; ops connects as the `ops_app` role) |
| AI | Vertex AI (Gemini) supervisor + sub-agents |
| Runs | Pub/Sub → Cloud Run Job (`anchor-ops-runner`); Cloud Scheduler fan-out |
| Deploy | Cloud Run (`anchor-ops` service) in project `anchor-hub-480305` |

## Layout

```
server/
  index.js            # entry: mounts /api/auth, /api/ops, /api/operations, WS, SPA
  migrations.js       # ordered, idempotent ops migration runner
  scripts/runMigrations.js   # `yarn db:migrate`
  auth.js             # login / JWT / MFA (shared JWT secret => SSO with anchor-hub)
  db.js  loadEnv.js
  middleware/ utils/  services/security/
  services/ops/       # the whole Operations engine (checks, agents, runs, skills, kinsta)
  services/ctm.js     # slim shim: just the 2 fns the ctm.* checks read
  routes/ops.js  routes/operations.js
  jobs/opsRunner.js   # Cloud Run Job entry (Pub/Sub consumer)
  ws/operationsTerminal.js
  sql/                # 17 idempotent ops/kinsta migrations
src/
  views/admin/Operations/   # the Operations UI (Command Center · Discoveries · Agent · Bulk)
  api/{ops,opsBulk,operations}.js + shared client/auth
  layout/ themes/ ui-component/ contexts/ hooks/   # shell, trimmed to ops
infra/
  provision-ops.sh    # shared-foundation provisioning (guarded; --apply to run)
  sql/ops_app_role.sql # least-privilege DB role
  pubsub/ops.tf       # Pub/Sub topology (reference)
scripts/gdeploy.sh  scripts/gdeploy-ops-runner.sh
```

## Local development

```bash
yarn install
cp .env.example .env          # fill DATABASE_URL + (for full features) shared secrets
yarn db:migrate               # apply ops migrations (needs base tables present)
./dev.sh                      # backend :4000 + frontend :3000
```

`ENCRYPTION_KEY` and `JWT_SECRET` must match the main app to decrypt
`oauth_connections` and to accept its login tokens (SSO).

## Verify

```bash
yarn build && yarn lint       # green; lint has prettier warnings only
yarn db:migrate               # idempotent
```

## Deploy (production)

See `docs/STANDUP.md`. In short: `infra/provision-ops.sh --apply`, create the
`ops_app` role, then `scripts/gdeploy.sh` + `scripts/gdeploy-ops-runner.sh`.
