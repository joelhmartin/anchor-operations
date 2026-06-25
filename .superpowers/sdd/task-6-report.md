## Task 6 Report — Config sections + authz/audit gap fixes

### Step 1: `OPERATIONS_CREDENTIAL_DELETED` added to `audit.js`

Added after `OPERATIONS_BULK_SCHEDULE_RUN_NOW` in the `SecurityEventTypes` object:
```js
OPERATIONS_CREDENTIAL_DELETED: 'operations.credential_deleted'
```
Style matches all adjacent `OPERATIONS_*` entries.

### Step 2: `isOperationsClient` guards in `ops.js`

**Before → After for each handler:**

`PUT /clients/:id/subscriptions` (line ~1032):
- Before: `isUuid` check only; DML proceeded against any UUID, including non-roster clients.
- After: guard inserted immediately after `isUuid`, before any body parsing or DML:
  ```js
  if (!(await isOperationsClient(req.params.id))) return res.status(404).json({ message: 'Client account not found' });
  ```

`PUT /clients/:id/credentials/:platform` (line ~1104):
- Before: `isUuid` check only; `putCredential` could be called for any UUID.
- After: same guard pattern after `isUuid`, before platform/body validation.

`DELETE /clients/:id/credentials/:credentialId` (line ~1130):
- Before: two `isUuid` checks, then `deleteCredential` with no roster check.
- After: guard after both `isUuid` checks, before `deleteCredential`. Mirrors `POST /runs` exactly.

**Audit event placement** (DELETE handler):
- Fires after `await deleteCredential(req.params.credentialId)` succeeds, before `res.status(204).end()`.
- `details` contains only `{ clientUserId: req.params.id, credentialId: req.params.credentialId }` — no credential values, no PHI.

### Step 3: Config sections wired in `ClientWorkspace.jsx`

- Imported `ClientOpsView` from `'./ClientOpsView'` (same `Clients/` folder).
- `SectionBody` signature updated to `function SectionBody({ section, clientUserId, activeClient, setSection })`.
- Added four new cases to the switch:
  ```jsx
  case 'health':
  case 'connections':
  case 'runs':
  case 'cost':
    return (
      <ClientOpsView
        clientUserId={clientUserId}
        clientName={clientLabel(activeClient)}
        onOpenChat={() => setSection('chat')}
        onOpenRun={() => setSection('runs')}
      />
    );
  ```
- Render site updated to pass `activeClient={activeClient}` and `setSection={setSection}` alongside existing props.

### Build / lint

- `yarn build`: PASS (built in 21.08s, 0 errors)
- `yarn lint`: PASS (0 errors, 347 pre-existing prettier warnings — none from changed files)

### Deviations from brief

- Brief Step 3 referenced `clientLabel(activeClientForName)` / `setSectionRef` as placeholder names; used `clientLabel(activeClient)` and `setSection` matching the actual `useOpsWorkspace()` destructure in `ClientWorkspace`.
- Brief `_clientLabel` import not needed in `ClientWorkspace` — it was already imported on line 5. No duplicate import added.

### Self-review checklist

- [x] All 3 handlers 404 non-roster clients before any DML
- [x] Guard placement mirrors `POST /runs` exactly
- [x] Audit event fires only on successful delete
- [x] Audit `details` contains no PHI, no credential values
- [x] `clientLabel` used for client display name
- [x] `console.warn`/`console.error` only (no `console.log`)
- [x] No new npm dependencies

### Human follow-ups

- None flagged. `GET /clients/:id/credentials` and `GET /clients/:id/subscriptions` remain unguarded (read-only, low-sensitivity), consistent with existing pattern for GET endpoints in this route file. If a future audit requires roster-gating all reads, those two handlers need the same guard.

### Commit

`c46e57f feat(ops): Config sections + close subscription/credential authz & audit gaps`
