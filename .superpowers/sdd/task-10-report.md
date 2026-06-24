# Task 10 Report — Port Social UI as Content Tab

## Files Created

```
src/views/admin/Operations/Content/
  CalendarView.jsx   — verbatim copy
  QueueView.jsx      — verbatim copy
  ComposeDialog.jsx  — verbatim copy
  MediaPicker.jsx    — verbatim copy
  ContentTab.jsx     — authored adapter
```

---

## Verbatim Copy Confirmation

All 4 leaf files were copied via `cp` from:
`Anchor-Client-Dashboard/src/views/admin/AdminHub/social/`

No edits were made after copying. Byte-for-byte identical to source.

---

## `/ops/clients` Row Shape

Source: `anchor-operations/server/services/ops/clientRoster.js` lines 62–83

```sql
SELECT
  u.id,
  u.id AS user_id,        -- client user_id (same value as id)
  u.first_name,
  u.last_name,
  u.email,
  u.role,
  cp.client_identifier_value,
  cp.client_package,
  cp.onboarding_completed_at,
  ba.business_name,
  ${labelExpr} AS client_label,
  tc.id AS tracking_config_id,
  tc.client_type AS tracking_client_type,
  tc.client_type,         -- used by ComposeDialog's medical HIPAA check
  tc.website_domain,
  tc.ga4_property_id, tc.ga4_measurement_id,
  tc.google_ads_customer_id,
  tc.meta_ad_account_id, tc.meta_pixel_id,
  tc.browser_meta_pixel_enabled
```

**id field**: `u.id` (user_id). This is the same field stored in `meta_page_links.client_id` / `oauth_resources.client_id`.

---

## Normalization Written

```jsx
listOpsClients()
  .then((rows) =>
    setClients((rows || []).map((c) => ({ ...c, name: clientLabel(c) })))
  )
```

- Spreads raw row (keeps `id`, `client_identifier_value`, `client_type`, `client_label`, `email`, etc.)
- Adds `name: clientLabel(c)` so QueueView's `c.name || c.email` lookup works

`clientLabel` imported from `../_clientLabel` (ops view-local labeler, reads `client_identifier_value → client_label → business_name → name → first_name → email → id`).

---

## Prop-Name Cross-Check vs Children

| Child | Props passed | Child signature |
|-------|-------------|-----------------|
| `CalendarView` | `refreshKey`, `onDayClick`, `onEventClick` | `{ refreshKey=0, onEventClick, onDayClick }` ✓ |
| `QueueView` | `clients`, `refreshKey` | `{ clients=[], refreshKey=0 }` ✓ |
| `ComposeDialog` | `open`, `onClose`, `clients`, `presetDate`, `onCreated` | `{ open, onClose, clients=[], presetDate=null, onCreated }` ✓ |

Note: SocialSection also passed `clients` to CalendarView, but CalendarView's signature doesn't accept it — intentionally omitted in ContentTab since CalendarView doesn't use it.

---

## Build / Lint Summary

```
yarn build  →  ✓ built in 17.27s  (0 errors)
yarn lint   →  ✖ 213 warnings, 0 errors
             All warnings are pre-existing prettier issues in:
               - Sites/SiteDrawer.jsx
               - Sites/SiteFindings.jsx
               - pages/auth-forms/AuthLogin.jsx
               - pages/authentication/ForgotPassword.jsx
             No new warnings or errors introduced by Task 10.
```

---

## Operations Tab Registry

`src/views/admin/Operations/index.jsx` defines `WORKSPACE_TABS` with 4 entries (command-center, discoveries, agent, bulk). The Content tab is **not yet registered** — that is Task 11's responsibility.

---

## HUMAN VERIFY

Runtime confirmation needed:
1. Navigate to Operations → Content tab (after Task 11 wires the tab)
2. Confirm Calendar and Queue load without errors
3. Compose a post: verify client dropdown populates with correct business names
4. Verify `client_type === 'medical'` triggers the PHI warning in ComposeDialog
5. Verify day-click on Calendar opens Compose with preset date
6. Verify post creation bumps `refreshKey` and Calendar/Queue refresh
