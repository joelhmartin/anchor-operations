---
schema_version: 2
---

# Operations Polish — State

Routine A reads this file for the queue and known_issues. Merge state lives in GitHub: Routine A's Step 0 derives the done-set from the UNION of (a) `polish/ops-*` PRs already merged in this repo and (b) the `## completed` section below. Routine B addresses the CodeRabbit/Codex findings on the open PR and merges it.

See the full aspect spec in `docs/refactoring/ops-aspects.md`.

## queue

Aspects to work through, in order (real bugs + security/compliance first, then API hygiene, frontend bugs, UX, polish/cleanup). Routine A picks the first item not in the done-set. Slugs must match the headings in `ops-aspects.md`.

- runexec-status-compare-and-set
- runexec-cancel-honors-cancellation
- runexec-cost-rounding
- runexec-check-timeout-abortsignal
- budget-precheck-includes-run-cost
- skill-runs-correlate-report-digest
- fanout-bulk-batch-and-count
- fanout-schedule-timezone-cadence
- fanout-oidc-audience-allowlist
- agents-meta-query-scope-to-client
- sec-approval-execute-atomic-scoped
- agents-wp-password-reset-no-cleartext
- agents-tool-output-sanitize
- agents-verify-tracking-ssrf
- api-write-endpoints-roster-scope
- api-credential-ownership-scope
- sec-credential-lifecycle-audit
- consistency-ops-state-change-audit
- sec-encryption-prod-failfast
- sanitizer-names-and-phones
- sec-chat-rate-limit-fail-closed
- compliance-audit-log-immutability
- api-no-leak-internal-errors
- api-list-pagination
- api-consistent-response-shapes
- api-json-body-limit
- api-runs-detail-roster-scope
- ui-discoveries-open-run-nav
- ui-discovery-detail-edit-stale-list
- ui-discovery-detail-find-any-status
- ui-bulk-runs-refresh
- ui-owner-assign-user-picker
- ui-chat-autoscroll-and-reset
- ui-schedule-hour-timezone-label
- ui-chat-platform-focus-structured
- ui-discoveries-bulk-ack-parallel-confirm
- ui-skills-suggestions-count-endpoint
- ui-ops-pre-pivot-dead-code-cleanup
- api-legacy-operations-deprecation
- agents-meta-pixel-test-event-endpoint
- sec-dead-auth-suite-cleanup
- schema-ops-fk-or-document

## completed

Aspects merged before/outside this repo's PR history (none yet — this repo's polish PRs all start here). Routine A treats anything listed here as done. Leave this section as a fixed record; new completions are tracked via merged `polish/ops-*` PRs in this repo.

(none yet)

## known_issues

Deferred items discovered during runs. Each line prefixed with the discovering aspect slug. Format: `- [{aspect-slug}] {description}`.

- [runexec-check-timeout-abortsignal] Google Ads check handlers (`server/services/ops/checks/google_ads/**`) cannot honor `ctx.signal` until the `google-ads-api` gRPC adapter (via `getCustomerClient`) exposes a cancellation hook — a hung GAQL query past the per-check timeout still consumes resources and tokens. Needs an upstream library bump or a custom gRPC wrapper.
- [runexec-check-timeout-abortsignal] Meta + CTM check handlers don't call `safeHttpFetch` directly — their internal adapters (`meta/_client.js`, ctm collectors) need the same signal-threading treatment so a per-check timeout actually aborts their in-flight HTTP/SDK calls. Same shape as the Google Ads gap.
- [budget-precheck-includes-run-cost] `fanOutBulkSchedule` (`server/services/ops/scheduleFanout.js:262-369`) does NOT call `checkBudget` at all — every bulk-scheduled child run bypasses the per-client monthly cap. Same shape as the legacy tier-fanout bug just fixed. Best wired in alongside `fanout-bulk-batch-and-count` so the inserts can charge a per-skill estimate (`skill.cost_estimate_cents`) rather than a tier-budget approximation against the cap.
