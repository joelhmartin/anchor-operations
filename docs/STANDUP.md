# anchor-ops — standup state & handoff

**Date:** 2026-06-10
**Source:** extracted from `Anchor-Client-Dashboard` (the `anchor-hub` monorepo,
post Operations-rebuild Phase 10).

## What is done (this session — repo build + local verification only)

- [x] Standalone repo scaffolded in this directory (pruned `package.json`/deps, configs).
- [x] **Backend ops slice** copied: `services/ops/` (whole engine), `services/security/`,
      `db.js`, `auth.js`, `middleware/`, `utils/`, shared services (`clientLabel`,
      `clientAccounts`, `queryHelpers`, `mailgun`, `emailTemplate`, `demoMode`,
      `activityLog`), `routes/{ops,operations}.js`, `jobs/opsRunner.js`,
      `ws/operationsTerminal.js`, 17 ops/kinsta SQL migrations.
- [x] The **only** cross-app coupling (`ctm.js` → 2 read functions) replaced with a
      slim `server/services/ctm.js` shim (no CRM tree pulled in).
- [x] New minimal `server/index.js` (mounts auth/ops/operations + liveness + SPA;
      ops migrations; bulk-schedule tick; WS terminal). Generic `migrations.js` runner.
- [x] **Frontend ops slice**: all of `views/admin/Operations/**` kept; the other
      apps (CRM hub, tasks, ctm-forms, twilio, client portal, analytics, onboarding,
      reviews) stripped. Shell trimmed to ops-only (routes, menu, layout, sidebar,
      header; login + forgot-password retained). 92 dead non-ops files removed.
- [x] **Verified locally:** `yarn build` ✓, `yarn lint` ✓ (0 errors), backend modules
      resolve ✓, 17 migrations run **idempotently** against a throwaway DB ✓, server
      boots + `/api/health` ✓.

## NOT done (paused before any live GCP changes — per your choice)

Nothing has been written to the live `anchor-hub-480305` project. The provisioning
is authored and ready in `infra/` + `scripts/` but not executed.

## GCP provisioning order (when you green-light it)

All additive — does not touch the running `anchor-hub` service. The DB step is the
only one with real blast radius (it writes to the shared `anchor` Cloud SQL).

1. **Foundation (additive):** `./infra/provision-ops.sh --apply`
   Creates the `anchor-ops` service account, grants it `secretAccessor` on the
   EXISTING shared secrets (`ENCRYPTION_KEY`, `JWT_SECRET`, agency tokens — reused so
   AES + JWT are byte-identical → decryption + SSO work), creates the Pub/Sub
   topology, the reports GCS bucket, and an empty `anchor-db-url-ops` secret.
2. **DB role (touches shared DB):**
   `psql "$ADMIN_DATABASE_URL" -v ops_password="'<pw>'" -f infra/sql/ops_app_role.sql`
   Then set the secret value:
   `printf 'postgresql://ops_app:<pw>@<host>:5432/anchor' | gcloud secrets versions add anchor-db-url-ops --data-file=- --project=anchor-hub-480305`
3. **Migrations (once, as admin — some ALTER main-owned base tables):**
   `DATABASE_URL=$ADMIN_DATABASE_URL RUN_MIGRATIONS_ON_START=true yarn db:migrate`
   (Idempotent against the dormant `ops_*`/`kinsta_*` tables already in the shared DB.)
4. **Deploy service:** `./scripts/gdeploy.sh`
5. **Deploy runner Job:** `./scripts/gdeploy-ops-runner.sh`
6. **Scheduler (run cadence):** create Cloud Scheduler jobs that POST the fan-out
   endpoint (daily essentials / weekly deep / monthly audit — see `services/ops/scheduleFanout.js`).

## What YOU need to do (OAuth — can't be automated for you)

- **Google OAuth client:** add the new ops domain's redirect URIs (e.g.
  `https://ops.<domain>/api/auth/oauth/google/callback`) to the existing OAuth
  client (`GOOGLE_OAUTH_CLIENT_ID` in Secret Manager). Same client → SSO stays unified.
- **Decide the prod URL** (subdomain `ops.<domain>` vs path behind a load balancer)
  and point DNS at the `anchor-ops` Cloud Run service.

## Decisions locked (this session)

- DB: **shared `anchor` instance + `ops_app` role** (plan default).
- Service account: **new `anchor-ops` SA**, **reusing existing secrets** (least
  privilege + byte-identical AES/JWT).
- Scope: build repo + verify locally; **pause before live GCP**.

## Reference

- `anchor-three-app-integration-plan.md` — full three-app design.
- `docs/OPERATIONS.md` — Operations subsystem architecture (carried from source).
- The source monorepo remains at `./Anchor-Client-Dashboard/` (gitignored) for reference.
