# Operations Client-First Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the `/operations` command center from feature-first tabs (all clients mixed, inconsistent client selection) into a client-first IA with a slim Home/Clients/Portfolio rail, a single URL-driven active-client context, a per-client page with all sections, curated Home + per-client Overview digests, the revived Kinsta Sites section, and a surgical one-time ops-data wipe.

**Architecture:** A new in-page left rail inside `Operations/index.jsx` switches between three **views** (`home`, `clients`, `portfolio`) tracked by a `?view=` query param. A new `OpsWorkspace` context holds the active client (`?clientUserId=`) and section (`?section=`); every per-client section reads it instead of carrying its own client dropdown. Most sections **reuse existing components** (Discoveries, Content social/blog, Chat, ClientOpsView, Sites drawer) re-scoped to the active client. Two new aggregate endpoints (`/api/ops/clients/:id/overview`, `/api/ops/home`) back the curated digests. The wipe ships as a Node script with a unit-tested table allowlist, run once as admin.

**Tech Stack:** React 19 + Vite 7 + MUI 7 (frontend, `baseUrl: src` aliases, `@mui/material/Grid` → GridLegacy); Express 4 + Node 20 ESM (backend); PostgreSQL 15 (shared `anchor` DB); `node:test` for unit tests. No new dependencies.

## Global Constraints

- **No new npm dependencies.** Everything is composable from what's installed.
- **Import paths:** shared modules via `baseUrl: src` aliases — `import MainCard from 'ui-component/cards/MainCard'`, `import { useToast } from 'contexts/ToastContext'`, `import { listOpsClients } from 'api/ops'`. Within `views/admin/Operations/`, import the local label helper as `import { clientLabel } from '../_clientLabel'` (or `'./_clientLabel'` at the Operations root).
- **Client display name:** always render a client via `clientLabel(c)` from `_clientLabel.js` (`client_identifier_value || client_label || business_name || name || first_name || email || id`). Never hand-roll a name.
- **Toast on every state-changing action** (create/update/delete/assign/link): `const { showToast } = useToast();` success AND failure. No `window.alert/confirm/prompt` — use `ConfirmDialog`/`FormDialog`.
- **Immediate UI updates:** after a mutation, update local state from the server response; a refetch is only a safety net.
- **MUI Grid is aliased to GridLegacy** — use the legacy Grid API (`<Grid container>` / `<Grid item xs=...>`), not Grid2.
- **PHI-free app** → no medical gate anywhere in this work.
- **Parameterized queries only**; never concatenate user input into SQL. UUID-validate path/body params with the existing `isUuid`/`badUuid` helpers in `ops.js`.
- **Server-side authorization:** every per-client mutation endpoint must call `isOperationsClient(clientUserId)` and 404 if false.
- **`console.log` is stripped in prod** (server nulls it; Vite drops it) — use `console.warn`/`console.error` for anything that must survive in Cloud Run logs.
- **Routing reconciliation (deviation from spec §3 path form):** the app uses a flat router with query-param state, not nested route segments. We implement the spec's "URL-driven active-client context" via query params (`?view=clients&clientUserId=<uuid>&section=<name>`), which is equally deep-linkable and avoids an `<Outlet>` restructure. The spec's `/operations/clients/:id/:section` is realized as `/operations?view=clients&clientUserId=:id&section=:section`.
- **Verification norm (no UI/endpoint test suite):** this repo's only automated tests are `node:test` pure-function tests under `server/services/ops/__tests__/`. For new **pure functions** we write `node:test` tests (true TDD). For **endpoints and React UI** the repo has no harness; verification is `yarn build` + `yarn lint` + boot + `curl`/manual, consistent with `docs`/SKILLS norms. Each task states its real verification.

---

## File Structure

**New frontend files (all under `src/views/admin/Operations/`):**
- `OpsWorkspaceContext.jsx` — active-client/view/section context provider + `useOpsWorkspace()` hook (query-param backed).
- `WorkspaceRail.jsx` — slim left rail: Home / Clients / Portfolio.
- `clients/ClientRoster.jsx` — searchable client list with status dots.
- `clients/ClientWorkspace.jsx` — per-client shell: header + section tabs (primary row + Config group) that render the active section.
- `clients/ClientOverview.jsx` — curated per-client digest (Overview section).
- `clients/ClientSitesPanel.jsx` — per-client Kinsta sites list + assign picker + opens `SiteDrawer`.
- `home/HomeDigest.jsx` — curated cross-client digest (Home view).
- `portfolio/PortfolioView.jsx` — relocates Bulk/Skills/Recipes/Run-defs + cost roll-up.

**New backend files:**
- `server/services/ops/clientOverview.js` — pure `shapeClientOverview(parts)` + the per-client query helpers.
- `server/services/ops/homeDigest.js` — pure `shapeHomeDigest(parts)`.
- `server/services/ops/wipePlan.js` — `ALLOWED_ACTIVITY_TABLES`, `SOCIAL_TABLES`, pure `planWipe({ includeSocial })`.
- `infra/scripts/wipe-ops-activity.mjs` — one-time admin runner using `wipePlan`.
- `infra/sql/wipe_ops_activity.sql` — equivalent SQL (documentation/manual path).
- Tests: `server/services/ops/__tests__/clientOverview.test.js`, `homeDigest.test.js`, `wipePlan.test.js`.

**Modified files:**
- `src/views/admin/Operations/index.jsx` — replace the top `Tabs` shell with the rail + view switch wrapped in `OpsWorkspaceProvider`.
- `src/views/admin/Operations/Discoveries/DiscoveriesTab.jsx`, `Content/ContentTab.jsx`, `Content/blog/BlogPane.jsx`, `Content/**` social calendar/queue, `Chat/ClientChat.jsx` — accept an `activeClientId` prop; hide the internal client selector when it's set.
- `src/api/ops.js` — add `getClientOverview(clientUserId)` and `getOpsHome()`.
- `server/routes/ops.js` — add `GET /clients/:id/overview`, `GET /home`; add `isOperationsClient` guards to `PUT /clients/:id/subscriptions`, `PUT /clients/:id/credentials/:platform`, `DELETE /clients/:id/credentials/:credentialId`; emit an audit event on credential delete.
- `server/services/security/audit.js` — add `OPERATIONS_CREDENTIAL_DELETED` event type.
- `docs/OPERATIONS.md` — update the tab list + route table.

---

## Task 1: Workspace shell — rail, active-client context, roster

Replace the 5-tab shell with the Home/Clients/Portfolio rail and a single query-param-backed active-client context. After this task the rail navigates, the roster lists clients with red status dots, selecting a client shows an (initially mostly-empty) client workspace with section tabs, Home renders the existing CommandCenter, and Portfolio renders the existing Bulk tab.

**Files:**
- Create: `src/views/admin/Operations/OpsWorkspaceContext.jsx`
- Create: `src/views/admin/Operations/WorkspaceRail.jsx`
- Create: `src/views/admin/Operations/clients/ClientRoster.jsx`
- Create: `src/views/admin/Operations/clients/ClientWorkspace.jsx`
- Modify: `src/views/admin/Operations/index.jsx`

**Interfaces:**
- Produces:
  - `useOpsWorkspace()` → `{ view, setView, clientUserId, setClientUserId, section, setSection, clients, clientsLoading, activeClient, statusByClient, reloadClients }`. `view ∈ {'home','clients','portfolio'}`; `section` is the active per-client section string; `clients` is the array from `listOpsClients()`; `activeClient` is the roster object whose `id === clientUserId`; `statusByClient` is `Map<clientUserId, 'critical'|'none'>`.
  - `<OpsWorkspaceProvider>` wrapping the Operations view.
  - `CLIENT_SECTIONS` constant: `[{ value:'overview', label:'Overview' }, { value:'findings', label:'Findings' }, { value:'socials', label:'Socials' }, { value:'blog', label:'Blog' }, { value:'sites', label:'Sites' }, { value:'chat', label:'Chat' }]` and `CONFIG_SECTIONS`: `[{ value:'health', label:'Health checks' }, { value:'connections', label:'Connections' }, { value:'runs', label:'Run history' }, { value:'cost', label:'Cost' }]`.
- Consumes: `listOpsClients`, `getCommandCenter` from `api/ops`; `clientLabel` from `../_clientLabel`.

- [ ] **Step 1: Create the workspace context**

`src/views/admin/Operations/OpsWorkspaceContext.jsx`:
```jsx
import { createContext, useContext, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listOpsClients, getCommandCenter } from 'api/ops';

export const CLIENT_SECTIONS = [
  { value: 'overview', label: 'Overview' },
  { value: 'findings', label: 'Findings' },
  { value: 'socials', label: 'Socials' },
  { value: 'blog', label: 'Blog' },
  { value: 'sites', label: 'Sites' },
  { value: 'chat', label: 'Chat' }
];
export const CONFIG_SECTIONS = [
  { value: 'health', label: 'Health checks' },
  { value: 'connections', label: 'Connections' },
  { value: 'runs', label: 'Run history' },
  { value: 'cost', label: 'Cost' }
];
const ALL_SECTIONS = [...CLIENT_SECTIONS, ...CONFIG_SECTIONS].map((s) => s.value);
const VIEWS = ['home', 'clients', 'portfolio'];

const OpsWorkspaceContext = createContext(null);
export function useOpsWorkspace() {
  const ctx = useContext(OpsWorkspaceContext);
  if (!ctx) throw new Error('useOpsWorkspace must be used within OpsWorkspaceProvider');
  return ctx;
}

export function OpsWorkspaceProvider({ children }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [clients, setClients] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [statusByClient, setStatusByClient] = useState(() => new Map());

  const view = VIEWS.includes(searchParams.get('view')) ? searchParams.get('view') : 'home';
  const clientUserId = searchParams.get('clientUserId') || null;
  const section = ALL_SECTIONS.includes(searchParams.get('section')) ? searchParams.get('section') : 'overview';

  const patchParams = useCallback(
    (patch) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          Object.entries(patch).forEach(([k, v]) => {
            if (v == null || v === '') next.delete(k);
            else next.set(k, v);
          });
          return next;
        },
        { replace: false }
      );
    },
    [setSearchParams]
  );

  const setView = useCallback((v) => patchParams({ view: v }), [patchParams]);
  const setClientUserId = useCallback((id) => patchParams({ view: 'clients', clientUserId: id, section: 'overview' }), [patchParams]);
  const setSection = useCallback((s) => patchParams({ section: s }), [patchParams]);

  const reloadClients = useCallback(async () => {
    setClientsLoading(true);
    try {
      const list = await listOpsClients();
      setClients(Array.isArray(list) ? list : []);
    } catch {
      setClients([]);
    } finally {
      setClientsLoading(false);
    }
  }, []);

  useEffect(() => {
    reloadClients();
  }, [reloadClients]);

  // Status dots: red ('critical') for any client with an open critical discovery.
  useEffect(() => {
    let cancelled = false;
    getCommandCenter()
      .then((cc) => {
        if (cancelled) return;
        const map = new Map();
        (cc?.discoveries || []).forEach((d) => {
          if (d.severity === 'critical' && d.client_user_id) map.set(d.client_user_id, 'critical');
        });
        setStatusByClient(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const activeClient = useMemo(
    () => clients.find((c) => c.id === clientUserId) || null,
    [clients, clientUserId]
  );

  const value = useMemo(
    () => ({
      view, setView,
      clientUserId, setClientUserId,
      section, setSection,
      clients, clientsLoading, reloadClients,
      activeClient, statusByClient
    }),
    [view, setView, clientUserId, setClientUserId, section, setSection, clients, clientsLoading, reloadClients, activeClient, statusByClient]
  );

  return <OpsWorkspaceContext.Provider value={value}>{children}</OpsWorkspaceContext.Provider>;
}
```

- [ ] **Step 2: Create the rail**

`src/views/admin/Operations/WorkspaceRail.jsx`:
```jsx
import { List, ListItemButton, ListItemIcon, ListItemText, Box } from '@mui/material';
import HomeIcon from '@mui/icons-material/Home';
import GroupsIcon from '@mui/icons-material/Groups';
import GridViewIcon from '@mui/icons-material/GridView';
import { useOpsWorkspace } from './OpsWorkspaceContext';

const ITEMS = [
  { value: 'home', label: 'Home', Icon: HomeIcon },
  { value: 'clients', label: 'Clients', Icon: GroupsIcon },
  { value: 'portfolio', label: 'Portfolio', Icon: GridViewIcon }
];

export default function WorkspaceRail() {
  const { view, setView } = useOpsWorkspace();
  return (
    <Box sx={{ width: 180, borderRight: 1, borderColor: 'divider', flexShrink: 0 }}>
      <List dense disablePadding>
        {ITEMS.map(({ value, label, Icon }) => (
          <ListItemButton key={value} selected={view === value} onClick={() => setView(value)}>
            <ListItemIcon sx={{ minWidth: 36 }}>
              <Icon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={label} />
          </ListItemButton>
        ))}
      </List>
    </Box>
  );
}
```

- [ ] **Step 3: Create the roster**

`src/views/admin/Operations/clients/ClientRoster.jsx`:
```jsx
import { useMemo, useState } from 'react';
import { Box, List, ListItemButton, ListItemText, TextField, Badge, Typography } from '@mui/material';
import { useOpsWorkspace } from '../OpsWorkspaceContext';
import { clientLabel } from '../_clientLabel';

export default function ClientRoster() {
  const { clients, clientsLoading, clientUserId, setClientUserId, statusByClient } = useOpsWorkspace();
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const labelled = clients.map((c) => ({ ...c, _label: clientLabel(c) }));
    const filtered = term ? labelled.filter((c) => c._label.toLowerCase().includes(term)) : labelled;
    // Attention-first: critical clients on top, then alphabetical.
    return filtered.sort((a, b) => {
      const ac = statusByClient.get(a.id) === 'critical' ? 0 : 1;
      const bc = statusByClient.get(b.id) === 'critical' ? 0 : 1;
      return ac - bc || a._label.localeCompare(b._label);
    });
  }, [clients, q, statusByClient]);

  return (
    <Box sx={{ width: 260, borderRight: 1, borderColor: 'divider', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ p: 1.5 }}>
        <TextField size="small" fullWidth placeholder="Search clients" value={q} onChange={(e) => setQ(e.target.value)} />
      </Box>
      <List dense sx={{ overflowY: 'auto' }}>
        {clientsLoading && <Typography sx={{ px: 2, py: 1 }} variant="body2" color="text.secondary">Loading…</Typography>}
        {!clientsLoading && rows.length === 0 && (
          <Typography sx={{ px: 2, py: 1 }} variant="body2" color="text.secondary">No clients</Typography>
        )}
        {rows.map((c) => (
          <ListItemButton key={c.id} selected={c.id === clientUserId} onClick={() => setClientUserId(c.id)}>
            <Badge
              color="error"
              variant="dot"
              invisible={statusByClient.get(c.id) !== 'critical'}
              sx={{ mr: 1.5 }}
            />
            <ListItemText primary={c._label} primaryTypographyProps={{ noWrap: true }} />
          </ListItemButton>
        ))}
      </List>
    </Box>
  );
}
```

- [ ] **Step 4: Create the client workspace shell**

`src/views/admin/Operations/clients/ClientWorkspace.jsx`. Section bodies are placeholders here except where a reused component is already prop-ready; Tasks 2–6 fill them in. Render the primary section tabs + a Config dropdown.
```jsx
import { useState } from 'react';
import { Box, Tabs, Tab, Typography, Menu, MenuItem, Button } from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import { useOpsWorkspace, CLIENT_SECTIONS, CONFIG_SECTIONS } from '../OpsWorkspaceContext';
import { clientLabel } from '../_clientLabel';
import EmptyState from 'ui-component/extended/EmptyState';

function SectionBody({ section }) {
  // Tasks 2–6 replace these placeholders with the real, client-scoped components.
  return <EmptyState title="Coming up" message={`The "${section}" section renders here.`} />;
}

export default function ClientWorkspace() {
  const { activeClient, section, setSection } = useOpsWorkspace();
  const [anchorEl, setAnchorEl] = useState(null);

  if (!activeClient) {
    return <EmptyState title="Pick a client" message="Choose a client from the roster to open their workspace." />;
  }

  const inConfig = CONFIG_SECTIONS.some((s) => s.value === section);
  const primaryValue = inConfig ? false : section;

  return (
    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ px: 2, pt: 2 }}>
        <Typography variant="h3">{clientLabel(activeClient)}</Typography>
      </Box>
      <Box sx={{ px: 2, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 1 }}>
        <Tabs value={primaryValue} onChange={(_, v) => setSection(v)} variant="scrollable" scrollButtons="auto">
          {CLIENT_SECTIONS.map((s) => (
            <Tab key={s.value} value={s.value} label={s.label} />
          ))}
        </Tabs>
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={<SettingsIcon />} onClick={(e) => setAnchorEl(e.currentTarget)}>
          Config
        </Button>
        <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
          {CONFIG_SECTIONS.map((s) => (
            <MenuItem
              key={s.value}
              selected={section === s.value}
              onClick={() => {
                setSection(s.value);
                setAnchorEl(null);
              }}
            >
              {s.label}
            </MenuItem>
          ))}
        </Menu>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 2 }}>
        <SectionBody section={section} key={`${activeClient.id}:${section}`} />
      </Box>
    </Box>
  );
}
```

- [ ] **Step 5: Rewrite `index.jsx` to use the rail + views**

Replace the `Tabs`/`TabPanel` shell. Keep importing the existing `CommandCenterTab` and `BulkTab` for Home and Portfolio respectively (Portfolio gets its own component in Task 7; for now mount `BulkTab`). Read the current file first, then replace its returned JSX and remove the `WORKSPACE_TABS`/`TAB_ALIASES`/`TabPanel` machinery. The new body:
```jsx
import { Box } from '@mui/material';
import MainCard from 'ui-component/cards/MainCard';
import { OpsWorkspaceProvider, useOpsWorkspace } from './OpsWorkspaceContext';
import WorkspaceRail from './WorkspaceRail';
import ClientRoster from './clients/ClientRoster';
import ClientWorkspace from './clients/ClientWorkspace';
import CommandCenterTab from './CommandCenter/CommandCenterTab';
import BulkTab from './Bulk/BulkTab';

function WorkspaceBody() {
  const { view, setView, setClientUserId, setSection } = useOpsWorkspace();

  // Deep-link helpers reused by Home (Task 5): jump straight to a client section.
  const openClientSection = (clientUserId, section) => {
    setClientUserId(clientUserId);
    setSection(section);
  };

  return (
    <Box sx={{ display: 'flex', height: 'calc(100vh - 160px)', minHeight: 480 }}>
      <WorkspaceRail />
      {view === 'home' && (
        <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', p: 2 }}>
          <CommandCenterTab
            onOpenDiscovery={() => setView('clients')}
            onOpenDiscoveriesFiltered={(f) => f?.client_user_id && openClientSection(f.client_user_id, 'findings')}
          />
        </Box>
      )}
      {view === 'clients' && (
        <>
          <ClientRoster />
          <ClientWorkspace />
        </>
      )}
      {view === 'portfolio' && (
        <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', p: 2 }}>
          <BulkTab />
        </Box>
      )}
    </Box>
  );
}

export default function Operations() {
  return (
    <MainCard title="Operations" content={false} sx={{ '& .MuiCardContent-root': { p: 0 } }}>
      <OpsWorkspaceProvider>
        <WorkspaceBody />
      </OpsWorkspaceProvider>
    </MainCard>
  );
}
```
Keep any existing top-of-file license/comment header. Delete now-unused imports (`Tabs`, `Tab`, icons, `DiscoveriesTab`, `ClientChat`, `ContentTab` from the shell — they move into sections in later tasks). Leave `CommandCenterTab` and `BulkTab` imported.

- [ ] **Step 6: Verify build + lint + boot**

Run: `cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations" && yarn build && yarn lint`
Expected: both succeed (no unused-import errors — that's what lint catches here).

Run the backend + frontend (`./dev.sh`) and manually confirm: the rail shows Home/Clients/Portfolio; Home renders the command center; Clients shows the roster (red dots on clients with critical findings) and selecting one shows the client header + section tabs + Config menu with placeholder bodies; Portfolio shows the Bulk tab. Confirm the browser console has no new errors.

- [ ] **Step 7: Commit**
```bash
git add src/views/admin/Operations/OpsWorkspaceContext.jsx src/views/admin/Operations/WorkspaceRail.jsx \
  src/views/admin/Operations/clients/ClientRoster.jsx src/views/admin/Operations/clients/ClientWorkspace.jsx \
  src/views/admin/Operations/index.jsx
git commit -m "feat(ops): client-first workspace shell — rail, active-client context, roster"
```

---

## Task 2: Re-scope reused sections to the active client (Findings, Socials, Blog, Chat)

Make `DiscoveriesTab`, the Content social view, `BlogPane`, and `ClientChat` accept an `activeClientId` prop; when set, they lock to that client and hide their internal client selector. Then wire them into `ClientWorkspace`'s `SectionBody`.

**Files:**
- Modify: `src/views/admin/Operations/Discoveries/DiscoveriesTab.jsx`
- Modify: `src/views/admin/Operations/Content/ContentTab.jsx` and the social calendar/queue it renders (`Content/` — confirm exact child filenames when editing)
- Modify: `src/views/admin/Operations/Content/blog/BlogPane.jsx`
- Modify: `src/views/admin/Operations/Chat/ClientChat.jsx`
- Modify: `src/views/admin/Operations/clients/ClientWorkspace.jsx`

**Interfaces:**
- Consumes: `useOpsWorkspace().activeClient`.
- Produces: each component accepts an optional `activeClientId` (string uuid). When present, it fetches only that client's data and renders no client `<Autocomplete>`.

- [ ] **Step 1: `DiscoveriesTab` — accept `activeClientId`**

Change the signature and the client-filter logic. Current: `export default function DiscoveriesTab({ onOpenRun, onOpenDiscovery })` with internal `const [clientFilter, setClientFilter] = useState(null)`.
- Add `activeClientId` to props: `export default function DiscoveriesTab({ onOpenRun, onOpenDiscovery, activeClientId })`.
- In the `load` callback, replace `if (clientFilter) params.client_user_id = clientFilter.id;` with:
```jsx
const effectiveClientId = activeClientId || clientFilter?.id || null;
if (effectiveClientId) params.client_user_id = effectiveClientId;
```
- Add `activeClientId` to the `load` dependency array.
- Wrap the client `<Autocomplete>` (around line 299) so it only renders when `!activeClientId`:
```jsx
{!activeClientId && (
  <Autocomplete /* ...existing client selector unchanged... */ />
)}
```

- [ ] **Step 2: `BlogPane` — accept `activeClientId`**

Current: `export default function BlogPane()` with internal `[clients]`/`[client]` + Autocomplete.
- Signature → `export default function BlogPane({ activeClientId })`.
- After the existing `const [client, setClient] = useState(null);`, add an effect that pins the client when `activeClientId` is provided:
```jsx
useEffect(() => {
  if (!activeClientId) return;
  if (clients.length) setClient(clients.find((c) => c.id === activeClientId) || null);
}, [activeClientId, clients]);
```
- Hide the selector when pinned: wrap the `<Autocomplete>` (line ~36) in `{!activeClientId && ( ... )}`.
- Everything downstream already keys off `client?.id`, so no further change.

- [ ] **Step 3: Content social view + `ContentTab` — accept `activeClientId`**

`ContentTab` currently renders a Social/Blog `mode` toggle and passes `clients` to its social `QueueView`/`CalendarView`. For the client workspace we want each as its own section, so:
- Signature → `export default function ContentTab({ activeClientId, mode: forcedMode })`. If `forcedMode` is provided (`'social'` or `'blog'`), use it and hide the mode toggle; otherwise keep the existing internal `mode` state (preserves standalone use).
- Pass `activeClientId` down to `BlogPane` (blog mode) and to the social `QueueView`/`CalendarView` (social mode).
- In the social `QueueView`/`CalendarView` (the components ContentTab renders for social), add an `activeClientId` prop: when set, filter `listPosts({ clientId: activeClientId })` and hide any internal client picker. Read the actual child filenames in `Content/` when editing and apply the same pin-and-hide pattern as Steps 1–2 (lock the selected client to `activeClientId`, render no client Autocomplete).

- [ ] **Step 4: `ClientChat` — lock to `activeClientId`**

Current: `export default function ClientChat({ initialClientUserId })` with an internal client `<Autocomplete>` (line 142) and `onChange={(_, v) => { setClient(v); newChat(); }}`.
- Add `lockedClientUserId` prop: `export default function ClientChat({ initialClientUserId, lockedClientUserId })`.
- Add an effect to pin the client:
```jsx
useEffect(() => {
  if (!lockedClientUserId) return;
  if (clients.length) setClient(clients.find((c) => c.id === lockedClientUserId) || null);
}, [lockedClientUserId, clients]);
```
- Hide the selector when locked: wrap the client `<Autocomplete>` in `{!lockedClientUserId && ( ... )}`.

- [ ] **Step 5: Wire sections into `ClientWorkspace`**

Replace the placeholder `SectionBody` in `clients/ClientWorkspace.jsx` with the real components for the four sections handled in this task (others stay `EmptyState` until their task):
```jsx
import DiscoveriesTab from '../Discoveries/DiscoveriesTab';
import ContentTab from '../Content/ContentTab';
import ClientChat from '../Chat/ClientChat';
// ...
function SectionBody({ section, clientUserId }) {
  switch (section) {
    case 'findings':
      return <DiscoveriesTab activeClientId={clientUserId} onOpenDiscovery={() => {}} onOpenRun={() => {}} />;
    case 'socials':
      return <ContentTab activeClientId={clientUserId} mode="social" />;
    case 'blog':
      return <ContentTab activeClientId={clientUserId} mode="blog" />;
    case 'chat':
      return <ClientChat lockedClientUserId={clientUserId} />;
    default:
      return <EmptyState title="Coming up" message={`The "${section}" section renders here.`} />;
  }
}
```
Pass `clientUserId={activeClient.id}` where `SectionBody` is rendered.

- [ ] **Step 6: Verify**

`yarn build && yarn lint` (both pass). Boot and manually confirm: selecting a client → Findings shows only that client's findings with no client dropdown; Socials and Blog show only that client's content; Chat is locked to that client (no client dropdown, threads scoped). Switch clients and confirm each section re-scopes (the `key={clientId:section}` remount handles this).

- [ ] **Step 7: Commit**
```bash
git add src/views/admin/Operations/Discoveries/DiscoveriesTab.jsx src/views/admin/Operations/Content \
  src/views/admin/Operations/Chat/ClientChat.jsx src/views/admin/Operations/clients/ClientWorkspace.jsx
git commit -m "feat(ops): re-scope Findings/Socials/Blog/Chat sections to the active client"
```

---

## Task 3: Sites section — revive Kinsta per client

Add the per-client Sites section: list the client's mapped Kinsta sites, assign a new site (the picker that went missing), and open the existing `SiteDrawer` for detail. All backend already exists (`fetchClientSites`, `fetchOperationsSites`, `linkSiteToClient`, `unlinkSiteClient`, `SiteDrawer`).

**Files:**
- Create: `src/views/admin/Operations/clients/ClientSitesPanel.jsx`
- Modify: `src/views/admin/Operations/clients/ClientWorkspace.jsx`

**Interfaces:**
- Consumes: `fetchClientSites(clientId)`, `fetchOperationsSites(params)`, `linkSiteToClient(siteId, body)`, `unlinkSiteClient(siteId, linkId)` from `api/operations`; `SiteDrawer` from `../Sites/SiteDrawer`; `useToast`.
- Produces: `<ClientSitesPanel clientUserId={...} />`.

- [ ] **Step 1: Create `ClientSitesPanel`**

`src/views/admin/Operations/clients/ClientSitesPanel.jsx`:
```jsx
import { useCallback, useEffect, useState } from 'react';
import { Box, Stack, Autocomplete, TextField, Button, Card, CardContent, Typography, IconButton, Chip } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { fetchClientSites, fetchOperationsSites, linkSiteToClient, unlinkSiteClient } from 'api/operations';
import { useToast } from 'contexts/ToastContext';
import EmptyState from 'ui-component/extended/EmptyState';
import LoadingButton from 'ui-component/extended/LoadingButton';
import SiteDrawer from '../Sites/SiteDrawer';

export default function ClientSitesPanel({ clientUserId }) {
  const { showToast } = useToast();
  const [sites, setSites] = useState([]);
  const [allSites, setAllSites] = useState([]);
  const [picked, setPicked] = useState(null);
  const [linking, setLinking] = useState(false);
  const [openSiteId, setOpenSiteId] = useState(null);

  const reload = useCallback(() => {
    fetchClientSites(clientUserId)
      .then((r) => setSites(r?.sites || r || []))
      .catch(() => setSites([]));
  }, [clientUserId]);

  useEffect(() => {
    reload();
  }, [reload]);
  useEffect(() => {
    fetchOperationsSites()
      .then((r) => setAllSites(r?.sites || r || []))
      .catch(() => setAllSites([]));
  }, []);

  const assign = async () => {
    if (!picked) return;
    setLinking(true);
    try {
      await linkSiteToClient(picked.id, { client_user_id: clientUserId, relationship: 'primary' });
      showToast('Site assigned to client', 'success');
      setPicked(null);
      reload();
    } catch (err) {
      showToast(err?.response?.data?.message || 'Failed to assign site', 'error');
    } finally {
      setLinking(false);
    }
  };

  const unassign = async (site) => {
    const linkId = site.link_id || site.client_link_id;
    try {
      await unlinkSiteClient(site.id, linkId);
      setSites((prev) => prev.filter((s) => s.id !== site.id));
      showToast('Site unlinked', 'success');
    } catch (err) {
      showToast(err?.response?.data?.message || 'Failed to unlink', 'error');
      reload();
    }
  };

  const available = allSites.filter((s) => !sites.some((cs) => cs.id === s.id));

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ mb: 2 }} alignItems="center">
        <Autocomplete
          size="small"
          sx={{ minWidth: 320 }}
          options={available}
          value={picked}
          onChange={(_, v) => setPicked(v)}
          getOptionLabel={(s) => s.display_name || s.site_name || s.kinsta_site_id || ''}
          renderInput={(p) => <TextField {...p} label="Assign a Kinsta site" />}
        />
        <LoadingButton variant="contained" loading={linking} loadingLabel="Assigning…" disabled={!picked} onClick={assign}>
          Assign
        </LoadingButton>
      </Stack>

      {sites.length === 0 ? (
        <EmptyState title="No sites linked" message="Assign a Kinsta site to this client to manage it here." />
      ) : (
        <Stack spacing={1.5}>
          {sites.map((s) => (
            <Card key={s.id} variant="outlined">
              <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle1" noWrap>
                    {s.display_name || s.site_name}
                  </Typography>
                  {s.primary_domain && (
                    <Typography variant="body2" color="text.secondary" noWrap>
                      {s.primary_domain}
                    </Typography>
                  )}
                </Box>
                {s.relationship && <Chip size="small" label={s.relationship} />}
                <Button size="small" startIcon={<OpenInNewIcon />} onClick={() => setOpenSiteId(s.id)}>
                  Open
                </Button>
                <IconButton size="small" onClick={() => unassign(s)} aria-label="unlink">
                  <LinkOffIcon fontSize="small" />
                </IconButton>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}

      <SiteDrawer siteId={openSiteId} open={Boolean(openSiteId)} onClose={() => setOpenSiteId(null)} />
    </Box>
  );
}
```
Note: confirm the exact shape returned by `fetchClientSites` when editing (the `.sites` vs array unwrap, and the `link_id` field name for unlink); adjust the two marked spots if the field differs. `SiteDrawer` already tolerates a null `siteId` with `open={false}`.

- [ ] **Step 2: Wire into `ClientWorkspace`**

Add to `SectionBody`:
```jsx
import ClientSitesPanel from './ClientSitesPanel';
// ...
case 'sites':
  return <ClientSitesPanel clientUserId={clientUserId} />;
```

- [ ] **Step 3: Verify**

`yarn build && yarn lint`. Boot and manually confirm: a client's Sites section lists linked sites (or an empty state), the assign Autocomplete lists unlinked sites, assigning shows a success toast and the site appears immediately, Open launches the SiteDrawer, unlink removes it immediately. (Requires `KINSTA_*` env to populate real sites; with none, the empty state + assign list being empty is the expected dev behavior.)

- [ ] **Step 4: Commit**
```bash
git add src/views/admin/Operations/clients/ClientSitesPanel.jsx src/views/admin/Operations/clients/ClientWorkspace.jsx
git commit -m "feat(ops): revive Kinsta Sites as a per-client section with assign picker"
```

---

## Task 4: Per-client Overview (curated digest)

Add `GET /api/ops/clients/:id/overview` backed by a unit-tested pure shaper, and the `ClientOverview` section component.

**Files:**
- Create: `server/services/ops/clientOverview.js`
- Create: `server/services/ops/__tests__/clientOverview.test.js`
- Modify: `server/routes/ops.js`
- Modify: `src/api/ops.js`
- Create: `src/views/admin/Operations/clients/ClientOverview.jsx`
- Modify: `src/views/admin/Operations/clients/ClientWorkspace.jsx`

**Interfaces:**
- Produces:
  - `shapeClientOverview({ findings, scheduledBlogs, scheduledSocial, lastRun, cost })` → `{ topFindings, scheduledToday: { blogs, social }, site: null, counts: { openFindings, postsScheduled, mtdSpendCents, capCents } }`.
  - `getClientOverview(clientUserId)` (api) → that shape.
- Consumes: `query` from `db.js`; `useOpsWorkspace`.

- [ ] **Step 1: Write the failing test for the shaper**

`server/services/ops/__tests__/clientOverview.test.js`:
```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeClientOverview } from '../clientOverview.js';

test('shapeClientOverview caps top findings at 5 and counts open findings', () => {
  const findings = Array.from({ length: 8 }, (_, i) => ({
    id: `f${i}`, severity: i < 2 ? 'critical' : 'warning', summary: `s${i}`, status: 'open', attention_score: 100 - i
  }));
  const out = shapeClientOverview({
    findings, scheduledBlogs: [], scheduledSocial: [], lastRun: null, cost: { spend_cents: 250, cap_cents: 5000 }
  });
  assert.equal(out.topFindings.length, 5);
  assert.equal(out.counts.openFindings, 8);
  assert.equal(out.counts.mtdSpendCents, 250);
  assert.equal(out.counts.capCents, 5000);
});

test('shapeClientOverview groups scheduled content and counts posts', () => {
  const out = shapeClientOverview({
    findings: [],
    scheduledBlogs: [{ id: 'b1', title: 'Post', scheduled_for: '2026-06-25T10:00:00Z' }],
    scheduledSocial: [{ id: 's1', content: 'Hi', scheduled_for: '2026-06-25T12:00:00Z' }],
    lastRun: null, cost: null
  });
  assert.equal(out.scheduledToday.blogs.length, 1);
  assert.equal(out.scheduledToday.social.length, 1);
  assert.equal(out.counts.postsScheduled, 2);
  assert.equal(out.counts.mtdSpendCents, 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations" && node --test server/services/ops/__tests__/clientOverview.test.js`
Expected: FAIL — `Cannot find module '../clientOverview.js'`.

- [ ] **Step 3: Implement the shaper + query helpers**

`server/services/ops/clientOverview.js`:
```javascript
import { query } from '../../db.js';

export function shapeClientOverview({ findings = [], scheduledBlogs = [], scheduledSocial = [], lastRun = null, cost = null }) {
  const sorted = [...findings].sort(
    (a, b) => (b.attention_score ?? 0) - (a.attention_score ?? 0)
  );
  return {
    topFindings: sorted.slice(0, 5),
    scheduledToday: { blogs: scheduledBlogs, social: scheduledSocial },
    site: null,
    lastRun: lastRun || null,
    counts: {
      openFindings: findings.length,
      postsScheduled: scheduledBlogs.length + scheduledSocial.length,
      mtdSpendCents: cost?.spend_cents ?? 0,
      capCents: cost?.cap_cents ?? null
    }
  };
}

export async function loadClientOverview(clientUserId) {
  const [findings, blogs, social, runRes, capRes, spendRes] = await Promise.all([
    query(
      `SELECT id, severity, category, summary, status, attention_score, created_at
         FROM ops_findings
        WHERE client_user_id = $1 AND status IN ('open','investigating')
        ORDER BY attention_score DESC NULLS LAST, created_at DESC
        LIMIT 25`,
      [clientUserId]
    ),
    query(
      `SELECT id, title, scheduled_for
         FROM ops_blog_posts
        WHERE client_id = $1 AND status = 'scheduled'
          AND scheduled_for >= date_trunc('day', NOW())
          AND scheduled_for < date_trunc('day', NOW()) + INTERVAL '2 days'
        ORDER BY scheduled_for ASC`,
      [clientUserId]
    ),
    query(
      `SELECT id, content, scheduled_for
         FROM social_posts
        WHERE client_id = $1 AND status = 'scheduled'
          AND scheduled_for >= date_trunc('day', NOW())
          AND scheduled_for < date_trunc('day', NOW()) + INTERVAL '2 days'
        ORDER BY scheduled_for ASC`,
      [clientUserId]
    ),
    query(
      `SELECT id, status, tier, created_at FROM ops_runs
        WHERE client_user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [clientUserId]
    ),
    query(`SELECT ops_monthly_cap_cents FROM client_profiles WHERE user_id = $1`, [clientUserId]),
    query(
      `SELECT COALESCE(SUM(cost_cents),0)::int AS spend_cents FROM ops_runs
        WHERE client_user_id = $1 AND created_at >= date_trunc('month', NOW())`,
      [clientUserId]
    )
  ]);
  return shapeClientOverview({
    findings: findings.rows,
    scheduledBlogs: blogs.rows,
    scheduledSocial: social.rows,
    lastRun: runRes.rows[0] || null,
    cost: { spend_cents: spendRes.rows[0]?.spend_cents ?? 0, cap_cents: capRes.rows[0]?.ops_monthly_cap_cents ?? null }
  });
}
```
Note: confirm `ops_runs` has a `cost_cents` column when editing (the exploration shows runs track cost/token usage); if the column name differs, adjust the spend query.

- [ ] **Step 4: Run the test — pass**

Run: `node --test server/services/ops/__tests__/clientOverview.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the endpoint**

In `server/routes/ops.js`, import at top: `import { loadClientOverview } from '../services/ops/clientOverview.js';`. Add (after the `/clients/:id/credentials` group):
```javascript
router.get('/clients/:id/overview', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'client id');
  if (!(await isOperationsClient(req.params.id))) {
    return res.status(404).json({ message: 'Client account not found' });
  }
  try {
    const overview = await loadClientOverview(req.params.id);
    res.json(overview);
  } catch (err) {
    console.error('[ops] GET /clients/:id/overview failed:', err);
    res.status(500).json({ message: 'Failed to load client overview' });
  }
});
```

- [ ] **Step 6: Add the api client function**

In `src/api/ops.js`, mirroring the existing per-client functions (which use the shared `client`/axios wrapper — copy the exact call style from `listClientOpsCredentials`):
```javascript
export const getClientOverview = (clientUserId) =>
  client.get(`/ops/clients/${clientUserId}/overview`).then((r) => r.data);
```

- [ ] **Step 7: Create `ClientOverview.jsx`**

`src/views/admin/Operations/clients/ClientOverview.jsx`:
```jsx
import { useEffect, useState } from 'react';
import { Grid, Card, CardContent, Typography, Stack, Chip, List, ListItemButton, ListItemText, Box } from '@mui/material';
import { getClientOverview } from 'api/ops';
import { useOpsWorkspace } from '../OpsWorkspaceContext';
import EmptyState from 'ui-component/extended/EmptyState';
import StatusChip from 'ui-component/extended/StatusChip';

function StatCard({ label, value }) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="h2">{value}</Typography>
        <Typography variant="body2" color="text.secondary">{label}</Typography>
      </CardContent>
    </Card>
  );
}

export default function ClientOverview({ clientUserId }) {
  const { setSection } = useOpsWorkspace();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getClientOverview(clientUserId)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [clientUserId]);

  if (loading) return <Typography color="text.secondary">Loading…</Typography>;
  if (!data) return <EmptyState title="No overview" message="Couldn't load this client's overview." />;

  const dollars = (cents) => (cents == null ? '—' : `$${(cents / 100).toFixed(2)}`);

  return (
    <Stack spacing={2}>
      <Grid container spacing={2}>
        <Grid item xs={6} md={3}><StatCard label="Open findings" value={data.counts.openFindings} /></Grid>
        <Grid item xs={6} md={3}><StatCard label="Posts scheduled" value={data.counts.postsScheduled} /></Grid>
        <Grid item xs={6} md={3}><StatCard label="MTD spend" value={dollars(data.counts.mtdSpendCents)} /></Grid>
        <Grid item xs={6} md={3}><StatCard label="Monthly cap" value={dollars(data.counts.capCents)} /></Grid>
      </Grid>

      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
            <Typography variant="h4" sx={{ flex: 1 }}>Notable findings</Typography>
            <Chip size="small" label="View all" onClick={() => setSection('findings')} />
          </Box>
          {data.topFindings.length === 0 ? (
            <Typography variant="body2" color="text.secondary">Nothing needs attention.</Typography>
          ) : (
            <List dense>
              {data.topFindings.map((f) => (
                <ListItemButton key={f.id} onClick={() => setSection('findings')}>
                  <StatusChip status={f.severity} size="small" sx={{ mr: 1 }} />
                  <ListItemText primary={f.summary} secondary={f.category} />
                </ListItemButton>
              ))}
            </List>
          )}
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Typography variant="h4" sx={{ mb: 1 }}>Scheduled soon</Typography>
          {data.scheduledToday.blogs.length === 0 && data.scheduledToday.social.length === 0 ? (
            <Typography variant="body2" color="text.secondary">No content scheduled in the next 48h.</Typography>
          ) : (
            <Stack spacing={0.5}>
              {data.scheduledToday.blogs.map((b) => (
                <Box key={b.id} sx={{ display: 'flex', gap: 1 }}>
                  <Chip size="small" label="Blog" color="primary" variant="outlined" onClick={() => setSection('blog')} />
                  <Typography variant="body2" noWrap>{b.title}</Typography>
                </Box>
              ))}
              {data.scheduledToday.social.map((s) => (
                <Box key={s.id} sx={{ display: 'flex', gap: 1 }}>
                  <Chip size="small" label="Social" color="secondary" variant="outlined" onClick={() => setSection('socials')} />
                  <Typography variant="body2" noWrap>{(s.content || '').slice(0, 80)}</Typography>
                </Box>
              ))}
            </Stack>
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}
```
Note: `StatusChip`'s status→color map may not include severity strings (`critical`/`warning`); when editing, confirm and either pass a `label` or fall back to a plain `<Chip>` if the severity isn't mapped.

- [ ] **Step 8: Wire into `ClientWorkspace`**
```jsx
import ClientOverview from './ClientOverview';
// ...
case 'overview':
  return <ClientOverview clientUserId={clientUserId} />;
```

- [ ] **Step 9: Verify**

`node --test server/services/ops/__tests__/clientOverview.test.js` (pass), then `yarn build && yarn lint`. Boot; confirm the Overview section shows the 4 stat cards, notable findings (capped at 5, clicking jumps to Findings), and scheduled-soon content. Curl the endpoint with an admin cookie/token to confirm shape; unauthenticated → 401, bad uuid → 400, non-roster uuid → 404.

- [ ] **Step 10: Commit**
```bash
git add server/services/ops/clientOverview.js server/services/ops/__tests__/clientOverview.test.js \
  server/routes/ops.js src/api/ops.js src/views/admin/Operations/clients/ClientOverview.jsx \
  src/views/admin/Operations/clients/ClientWorkspace.jsx
git commit -m "feat(ops): per-client Overview digest (endpoint + section)"
```

---

## Task 5: Home digest

Add `GET /api/ops/home` (command-center payload + scheduled-today content across all clients) backed by a unit-tested shaper, and a `HomeDigest` component that replaces the raw CommandCenter on the Home view with curated, deep-linking sections.

**Files:**
- Create: `server/services/ops/homeDigest.js`
- Create: `server/services/ops/__tests__/homeDigest.test.js`
- Modify: `server/routes/ops.js`
- Modify: `src/api/ops.js`
- Create: `src/views/admin/Operations/home/HomeDigest.jsx`
- Modify: `src/views/admin/Operations/index.jsx`

**Interfaces:**
- Produces: `shapeHomeDigest({ commandCenter, scheduledBlogs, scheduledSocial })` → `{ needsAttention, scheduledToday: { blogs, social }, approvalsWaiting, kpis }`; `getOpsHome()` (api) → that shape.

- [ ] **Step 1: Failing test**

`server/services/ops/__tests__/homeDigest.test.js`:
```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeHomeDigest } from '../homeDigest.js';

test('shapeHomeDigest derives needs-attention from critical discoveries grouped by client', () => {
  const cc = {
    discoveries: [
      { id: 'd1', client_user_id: 'c1', severity: 'critical', summary: 'A' },
      { id: 'd2', client_user_id: 'c1', severity: 'critical', summary: 'B' },
      { id: 'd3', client_user_id: 'c2', severity: 'warning', summary: 'C' }
    ],
    kpis: { clients_at_risk: 1, approvals_waiting: 3 }
  };
  const out = shapeHomeDigest({ commandCenter: cc, scheduledBlogs: [], scheduledSocial: [] });
  assert.equal(out.needsAttention.length, 1);
  assert.equal(out.needsAttention[0].clientUserId, 'c1');
  assert.equal(out.needsAttention[0].criticalCount, 2);
  assert.equal(out.approvalsWaiting, 3);
});

test('shapeHomeDigest passes through scheduled content', () => {
  const out = shapeHomeDigest({
    commandCenter: { discoveries: [], kpis: {} },
    scheduledBlogs: [{ id: 'b1', client_id: 'c9', title: 'T' }],
    scheduledSocial: []
  });
  assert.equal(out.scheduledToday.blogs.length, 1);
  assert.equal(out.scheduledToday.social.length, 0);
});
```

- [ ] **Step 2: Run — fail** (`node --test server/services/ops/__tests__/homeDigest.test.js` → module not found).

- [ ] **Step 3: Implement**

`server/services/ops/homeDigest.js`:
```javascript
import { query } from '../../db.js';

export function shapeHomeDigest({ commandCenter, scheduledBlogs = [], scheduledSocial = [] }) {
  const byClient = new Map();
  (commandCenter?.discoveries || []).forEach((d) => {
    if (d.severity !== 'critical' || !d.client_user_id) return;
    const cur = byClient.get(d.client_user_id) || { clientUserId: d.client_user_id, criticalCount: 0, top: null };
    cur.criticalCount += 1;
    if (!cur.top) cur.top = d.summary;
    byClient.set(d.client_user_id, cur);
  });
  return {
    needsAttention: [...byClient.values()].sort((a, b) => b.criticalCount - a.criticalCount),
    scheduledToday: { blogs: scheduledBlogs, social: scheduledSocial },
    approvalsWaiting: commandCenter?.kpis?.approvals_waiting ?? 0,
    kpis: commandCenter?.kpis || {}
  };
}

export async function loadHomeDigest(commandCenter) {
  const [blogs, social] = await Promise.all([
    query(
      `SELECT id, client_id, title, scheduled_for FROM ops_blog_posts
        WHERE status = 'scheduled'
          AND scheduled_for >= date_trunc('day', NOW())
          AND scheduled_for < date_trunc('day', NOW()) + INTERVAL '1 day'
        ORDER BY scheduled_for ASC LIMIT 50`
    ),
    query(
      `SELECT id, client_id, content, scheduled_for FROM social_posts
        WHERE status = 'scheduled'
          AND scheduled_for >= date_trunc('day', NOW())
          AND scheduled_for < date_trunc('day', NOW()) + INTERVAL '1 day'
        ORDER BY scheduled_for ASC LIMIT 50`
    )
  ]);
  return shapeHomeDigest({ commandCenter, scheduledBlogs: blogs.rows, scheduledSocial: social.rows });
}
```

- [ ] **Step 4: Run — pass.**

- [ ] **Step 5: Add the endpoint** (reuse the existing command-center query inline; keep `/command-center` as-is for back-compat).

In `server/routes/ops.js`, import `loadHomeDigest`. Add a `/home` route that runs the same aggregate the `/command-center` handler builds, then wraps it. The cleanest approach: extract the command-center aggregate into a helper used by both. Minimal version that avoids refactor risk — call the digest with a fresh command-center aggregate:
```javascript
import { loadHomeDigest } from '../services/ops/homeDigest.js';
// ...
router.get('/home', async (req, res) => {
  try {
    // Reuse the command-center aggregate shape. Fetch it via the same queries the
    // /command-center handler uses; factor those into a `loadCommandCenter()` helper
    // if not already, and call it here:
    const commandCenter = await loadCommandCenter();
    const digest = await loadHomeDigest(commandCenter);
    res.json(digest);
  } catch (err) {
    console.error('[ops] GET /home failed:', err);
    res.status(500).json({ message: 'Failed to load home digest' });
  }
});
```
To support this, refactor the body of the existing `GET /command-center` handler into an exported-or-local `async function loadCommandCenter()` returning `{ discoveries, kpis, activity }`, and have both `/command-center` and `/home` call it. This is a pure extraction — no behavior change to `/command-center`.

- [ ] **Step 6: Add the api function**
```javascript
export const getOpsHome = () => client.get('/ops/home').then((r) => r.data);
```

- [ ] **Step 7: Create `HomeDigest.jsx`**

`src/views/admin/Operations/home/HomeDigest.jsx` — three curated cards. It needs the roster (to label clients) and the workspace deep-link setters:
```jsx
import { useEffect, useState } from 'react';
import { Card, CardContent, Typography, Stack, List, ListItemButton, ListItemText, Chip, Box } from '@mui/material';
import { getOpsHome } from 'api/ops';
import { useOpsWorkspace } from '../OpsWorkspaceContext';
import { clientLabel } from '../_clientLabel';
import EmptyState from 'ui-component/extended/EmptyState';

export default function HomeDigest() {
  const { clients, setClientUserId, setSection } = useOpsWorkspace();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getOpsHome()
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const labelFor = (id) => clientLabel(clients.find((c) => c.id === id));
  const openClient = (id, section) => {
    setClientUserId(id);
    setSection(section);
  };

  if (loading) return <Typography color="text.secondary">Loading…</Typography>;
  if (!data) return <EmptyState title="No data" message="Couldn't load the home digest." />;

  return (
    <Stack spacing={2}>
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h4" sx={{ mb: 1 }}>Needs attention</Typography>
          {data.needsAttention.length === 0 ? (
            <Typography variant="body2" color="text.secondary">All clear — no critical findings.</Typography>
          ) : (
            <List dense>
              {data.needsAttention.map((n) => (
                <ListItemButton key={n.clientUserId} onClick={() => openClient(n.clientUserId, 'findings')}>
                  <Chip size="small" color="error" label={n.criticalCount} sx={{ mr: 1.5 }} />
                  <ListItemText primary={labelFor(n.clientUserId)} secondary={n.top} />
                </ListItemButton>
              ))}
            </List>
          )}
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Typography variant="h4" sx={{ mb: 1 }}>Scheduled today</Typography>
          {data.scheduledToday.blogs.length === 0 && data.scheduledToday.social.length === 0 ? (
            <Typography variant="body2" color="text.secondary">Nothing scheduled to publish today.</Typography>
          ) : (
            <Stack spacing={0.5}>
              {data.scheduledToday.blogs.map((b) => (
                <Box key={b.id} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  <Chip size="small" label="Blog" color="primary" variant="outlined" />
                  <Typography variant="body2" sx={{ flex: 1 }} noWrap>{labelFor(b.client_id)} — {b.title}</Typography>
                  <Chip size="small" label="Review" onClick={() => openClient(b.client_id, 'blog')} />
                </Box>
              ))}
              {data.scheduledToday.social.map((s) => (
                <Box key={s.id} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  <Chip size="small" label="Social" color="secondary" variant="outlined" />
                  <Typography variant="body2" sx={{ flex: 1 }} noWrap>{labelFor(s.client_id)} — {(s.content || '').slice(0, 60)}</Typography>
                  <Chip size="small" label="Review" onClick={() => openClient(s.client_id, 'socials')} />
                </Box>
              ))}
            </Stack>
          )}
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Typography variant="h4" sx={{ flex: 1 }}>Approvals waiting</Typography>
            <Chip size="small" color={data.approvalsWaiting ? 'warning' : 'default'} label={data.approvalsWaiting} />
          </Box>
          <Typography variant="body2" color="text.secondary">
            Pending AI tool approvals across all clients. Open a client&apos;s Chat to review.
          </Typography>
        </CardContent>
      </Card>
    </Stack>
  );
}
```

- [ ] **Step 8: Swap Home to render `HomeDigest`**

In `index.jsx`, replace the `view === 'home'` block's `<CommandCenterTab .../>` with `<HomeDigest />` (import it). Remove the now-unused `CommandCenterTab` import from `index.jsx` if nothing else uses it. (`getCommandCenter` is still used by `OpsWorkspaceContext` for status dots, so leave that.)

- [ ] **Step 9: Verify**

`node --test server/services/ops/__tests__/homeDigest.test.js` (pass), `yarn build && yarn lint`. Boot; Home shows Needs-attention (clicking a client opens their Findings), Scheduled-today (Review opens the client's Blog/Socials), Approvals-waiting count. Curl `/api/ops/home` for shape; `/api/ops/command-center` still returns its original shape unchanged.

- [ ] **Step 10: Commit**
```bash
git add server/services/ops/homeDigest.js server/services/ops/__tests__/homeDigest.test.js \
  server/routes/ops.js src/api/ops.js src/views/admin/Operations/home/HomeDigest.jsx src/views/admin/Operations/index.jsx
git commit -m "feat(ops): curated Home digest (endpoint + view) with client deep-links"
```

---

## Task 6: Config sections + auth/audit gap fixes

Render the four Config-group sections from the existing `ClientOpsView` content, and close the flagged server-side authorization/audit gaps.

**Files:**
- Modify: `server/services/security/audit.js`
- Modify: `server/routes/ops.js`
- Modify: `src/views/admin/Operations/clients/ClientWorkspace.jsx`
- (Reuse) `src/views/admin/Operations/Clients/ClientOpsView.jsx`

**Interfaces:**
- Consumes: `ClientOpsView({ clientUserId, clientName, onOpenChat, onOpenRun })`.

- [ ] **Step 1: Add the audit event type**

In `server/services/security/audit.js` `SecurityEventTypes`, add:
```javascript
OPERATIONS_CREDENTIAL_DELETED: 'operations.credential_deleted',
```

- [ ] **Step 2: Add `isOperationsClient` guards + delete audit in `ops.js`**

In the three flagged handlers, add the guard as the first check after uuid validation (mirroring `POST /runs`):
- `PUT /clients/:id/subscriptions`:
```javascript
if (!(await isOperationsClient(req.params.id))) return res.status(404).json({ message: 'Client account not found' });
```
- `PUT /clients/:id/credentials/:platform`: same guard line.
- `DELETE /clients/:id/credentials/:credentialId`: add the guard, then after the successful delete, emit:
```javascript
await logSecurityEvent({
  userId: req.user?.id || null,
  eventType: SecurityEventTypes.OPERATIONS_CREDENTIAL_DELETED,
  eventCategory: SecurityEventCategories.OPERATIONS,
  success: true,
  details: { clientUserId: req.params.id, credentialId: req.params.credentialId }
});
```
(`logSecurityEvent`, `SecurityEventTypes`, `SecurityEventCategories` are already imported in `ops.js`.)

- [ ] **Step 3: Wire Config sections into `ClientWorkspace`**

`ClientOpsView` already renders recent runs + subscriptions + credentials in one view. For now, render it for all four Config sections (it's the existing per-client admin surface); a later refinement can split it. Add:
```jsx
import ClientOpsView from '../Clients/ClientOpsView';
import { clientLabel } from '../_clientLabel';
// inside SectionBody, passing activeClient for the name:
case 'health':
case 'connections':
case 'runs':
case 'cost':
  return (
    <ClientOpsView
      clientUserId={clientUserId}
      clientName={clientLabel(activeClientForName)}
      onOpenChat={() => setSectionRef('chat')}
      onOpenRun={() => setSectionRef('runs')}
    />
  );
```
To do this cleanly, give `SectionBody` access to `activeClient` and `setSection` (pass them as props from `ClientWorkspace`, which already has them from `useOpsWorkspace`). Update the `SectionBody` signature to `function SectionBody({ section, clientUserId, activeClient, setSection })` and pass `onOpenChat={() => setSection('chat')}` / `onOpenRun={() => setSection('runs')}`.

- [ ] **Step 4: Verify**

`yarn build && yarn lint`. Boot; the Config menu's four entries open the per-client admin view (subscriptions editable + saved with a toast, credentials list with validate/delete). Manually verify the guard: `curl -X PUT .../api/ops/clients/<non-roster-uuid>/subscriptions` with an admin token returns 404 (was previously not guarded). After a credential delete, confirm a `operations.credential_deleted` row appears in `security_audit_log`.

- [ ] **Step 5: Commit**
```bash
git add server/services/security/audit.js server/routes/ops.js src/views/admin/Operations/clients/ClientWorkspace.jsx
git commit -m "feat(ops): Config sections + close subscription/credential authz & audit gaps"
```

---

## Task 7: Portfolio view

Give Portfolio its own component (currently `index.jsx` mounts `BulkTab` directly). Wrap Bulk and add a portfolio cost roll-up so Portfolio reads as the cross-client home.

**Files:**
- Create: `src/views/admin/Operations/portfolio/PortfolioView.jsx`
- Modify: `src/views/admin/Operations/index.jsx`

**Interfaces:**
- Consumes: `BulkTab`; `getOpsCostSummary` from `api/ops`.

- [ ] **Step 1: Create `PortfolioView`**

`src/views/admin/Operations/portfolio/PortfolioView.jsx` — a tabbed shell: Bulk (the existing `BulkTab`, which already has Runs/Schedules/Skills/Recipes sub-tabs) + a Cost roll-up tab:
```jsx
import { useEffect, useState } from 'react';
import { Box, Tabs, Tab, Card, CardContent, Typography } from '@mui/material';
import BulkTab from '../Bulk/BulkTab';
import { getOpsCostSummary } from 'api/ops';
import EmptyState from 'ui-component/extended/EmptyState';

function CostRollup() {
  const [data, setData] = useState(null);
  useEffect(() => {
    getOpsCostSummary().then(setData).catch(() => setData(null));
  }, []);
  if (!data) return <EmptyState title="No cost data" message="Cost summary is unavailable." />;
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="h4">Portfolio spend (MTD)</Typography>
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(data, null, 2)}</pre>
      </CardContent>
    </Card>
  );
}

export default function PortfolioView() {
  const [tab, setTab] = useState('bulk');
  return (
    <Box>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab value="bulk" label="Bulk & automation" />
        <Tab value="cost" label="Cost" />
      </Tabs>
      {tab === 'bulk' ? <BulkTab /> : <CostRollup />}
    </Box>
  );
}
```
Note: shape the `CostRollup` rendering to the real `getOpsCostSummary()` response when editing (the JSON dump is a deliberate minimal placeholder for an unspecified shape — replace with a small table once the shape is confirmed; do not ship the raw `<pre>` if a clean table is feasible in-task).

- [ ] **Step 2: Use it in `index.jsx`**

Replace the `view === 'portfolio'` block's `<BulkTab />` with `<PortfolioView />` (import it; drop the now-unused `BulkTab` import from `index.jsx`).

- [ ] **Step 3: Verify**

`yarn build && yarn lint`. Boot; Portfolio shows Bulk & automation (all existing sub-tabs work) + a Cost tab.

- [ ] **Step 4: Commit**
```bash
git add src/views/admin/Operations/portfolio/PortfolioView.jsx src/views/admin/Operations/index.jsx
git commit -m "feat(ops): Portfolio view (Bulk & automation + cost roll-up)"
```

---

## Task 8: One-time ops-activity wipe

A Node runner with a unit-tested table allowlist that deletes ops-owned activity data, with `social_posts` gated behind an explicit flag. Plus the equivalent SQL file for the manual path.

**Files:**
- Create: `server/services/ops/wipePlan.js`
- Create: `server/services/ops/__tests__/wipePlan.test.js`
- Create: `infra/scripts/wipe-ops-activity.mjs`
- Create: `infra/sql/wipe_ops_activity.sql`

**Interfaces:**
- Produces: `ALLOWED_ACTIVITY_TABLES` (string[]), `SOCIAL_TABLES` (string[]), `planWipe({ includeSocial })` → ordered `string[]` of tables to delete (FK-safe order), throws if any planned table is outside the allowlist.

- [ ] **Step 1: Failing test**

`server/services/ops/__tests__/wipePlan.test.js`:
```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { planWipe, ALLOWED_ACTIVITY_TABLES, SOCIAL_TABLES } from '../wipePlan.js';

test('planWipe excludes social tables by default', () => {
  const plan = planWipe({ includeSocial: false });
  assert.ok(plan.length > 0);
  for (const t of SOCIAL_TABLES) assert.ok(!plan.includes(t), `${t} must be excluded by default`);
  // child-before-parent ordering: messages before threads
  assert.ok(plan.indexOf('ops_chat_messages') < plan.indexOf('ops_chat_threads'));
});

test('planWipe includes social tables only when flagged, child before parent', () => {
  const plan = planWipe({ includeSocial: true });
  for (const t of SOCIAL_TABLES) assert.ok(plan.includes(t), `${t} must be included when flagged`);
  assert.ok(plan.indexOf('social_media_tokens') < plan.indexOf('social_posts'));
});

test('planWipe never emits a table outside the allowlist', () => {
  const allowed = new Set([...ALLOWED_ACTIVITY_TABLES, ...SOCIAL_TABLES]);
  for (const t of planWipe({ includeSocial: true })) assert.ok(allowed.has(t), `${t} not in allowlist`);
});
```

- [ ] **Step 2: Run — fail.**

- [ ] **Step 3: Implement `wipePlan.js`**
```javascript
// Ops-owned ACTIVITY tables only. Config tables (run_definitions, skills, recipes,
// credentials, kinsta_* mappings, meta_page_links, subscriptions) are intentionally
// excluded — the wipe clears test activity, not configuration.
// FK-safe order: children before parents.
export const ALLOWED_ACTIVITY_TABLES = [
  'ops_chat_messages',
  'ops_chat_threads',
  'ops_tool_approvals',
  'ops_bulk_runs',
  'ops_blog_posts',
  'ops_reports',
  'ops_findings',
  'ops_check_results',
  'ops_runs',
  'kinsta_ssh_command_log',
  'kinsta_findings'
];

// Shared with the main app's social publisher. Only wiped when explicitly flagged.
// social_media_tokens FKs into social_posts → delete tokens first.
export const SOCIAL_TABLES = ['social_media_tokens', 'social_posts'];

export function planWipe({ includeSocial = false } = {}) {
  const plan = [...ALLOWED_ACTIVITY_TABLES];
  if (includeSocial) plan.push(...SOCIAL_TABLES);
  const allowed = new Set([...ALLOWED_ACTIVITY_TABLES, ...SOCIAL_TABLES]);
  for (const t of plan) {
    if (!allowed.has(t)) throw new Error(`Refusing to wipe non-allowlisted table: ${t}`);
  }
  return plan;
}
```
Note: confirm `ops_reports` exists as a table when editing (the exploration lists it among ops tables); if findings/reports are stored differently, drop the line. The `DELETE FROM` is keyed only by table name from this constant — never from user input.

- [ ] **Step 4: Run — pass.**

- [ ] **Step 5: Implement the runner**

`infra/scripts/wipe-ops-activity.mjs`:
```javascript
/**
 * One-time ops-activity wipe. Run as DB admin via the Cloud SQL Auth Proxy.
 *
 *   ADMIN_DATABASE_URL=postgres://... node infra/scripts/wipe-ops-activity.mjs            # dry-run
 *   ADMIN_DATABASE_URL=postgres://... node infra/scripts/wipe-ops-activity.mjs --apply
 *   ADMIN_DATABASE_URL=postgres://... node infra/scripts/wipe-ops-activity.mjs --apply --include-social
 *
 * Deletes ops-owned ACTIVITY tables only (see wipePlan.js). social_posts is
 * excluded unless --include-social is passed. NEVER wired into migrations/cron.
 */
import pg from 'pg';
import { planWipe, SOCIAL_TABLES } from '../../server/services/ops/wipePlan.js';

const apply = process.argv.includes('--apply');
const includeSocial = process.argv.includes('--include-social');
const url = process.env.ADMIN_DATABASE_URL;
if (!url) {
  console.error('ADMIN_DATABASE_URL is required');
  process.exit(1);
}

const plan = planWipe({ includeSocial });
const client = new pg.Client({ connectionString: url });

const run = async () => {
  await client.connect();

  // Seatbelt: report social_posts volume before any social wipe.
  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM social_posts');
  console.warn(`[wipe] social_posts currently holds ${rows[0].n} row(s).`);
  if (!includeSocial) console.warn('[wipe] social tables EXCLUDED (pass --include-social to include).');

  console.warn(`[wipe] plan (${apply ? 'APPLY' : 'DRY-RUN'}):`, plan.join(', '));
  if (!apply) {
    console.warn('[wipe] dry-run only — no rows deleted. Re-run with --apply.');
    await client.end();
    return;
  }

  await client.query('BEGIN');
  try {
    for (const table of plan) {
      const res = await client.query(`DELETE FROM ${table}`); // table from allowlist constant only
      console.warn(`[wipe] ${table}: ${res.rowCount} deleted`);
    }
    await client.query('COMMIT');
    console.warn('[wipe] committed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[wipe] rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
};

run().catch((err) => {
  console.error('[wipe] fatal:', err.message);
  process.exit(1);
});
```
(`pg` is already a dependency — the app uses it via `server/db.js`.)

- [ ] **Step 6: Write the equivalent SQL file (manual path)**

`infra/sql/wipe_ops_activity.sql`:
```sql
-- One-time ops-activity wipe (admin only; ops_app cannot DELETE all rows).
-- Activity tables only; config preserved. social_* are commented out by default —
-- uncomment ONLY after confirming social_posts holds no production rows.
-- Usage: psql "$ADMIN_DATABASE_URL" -f infra/sql/wipe_ops_activity.sql
BEGIN;
DELETE FROM ops_chat_messages;
DELETE FROM ops_chat_threads;
DELETE FROM ops_tool_approvals;
DELETE FROM ops_bulk_runs;
DELETE FROM ops_blog_posts;
DELETE FROM ops_reports;
DELETE FROM ops_findings;
DELETE FROM ops_check_results;
DELETE FROM ops_runs;
DELETE FROM kinsta_ssh_command_log;
DELETE FROM kinsta_findings;
-- DELETE FROM social_media_tokens;
-- DELETE FROM social_posts;
COMMIT;
```

- [ ] **Step 7: Verify**

`node --test server/services/ops/__tests__/wipePlan.test.js` (3 pass). Dry-run against the local dev DB:
`ADMIN_DATABASE_URL=postgresql://bif@localhost:5432/anchor node infra/scripts/wipe-ops-activity.mjs`
Expected: prints the plan, the social_posts count, "dry-run only", deletes nothing. (Run `--apply` only against the dev DB when actually clearing it; confirm afterwards that config tables — `ops_run_definitions`, `ops_skills`, `client_run_subscriptions`, `kinsta_sites`, `kinsta_site_clients`, `client_platform_credentials` — still have their rows and dashboard tables are untouched.)

- [ ] **Step 8: Commit**
```bash
git add server/services/ops/wipePlan.js server/services/ops/__tests__/wipePlan.test.js \
  infra/scripts/wipe-ops-activity.mjs infra/sql/wipe_ops_activity.sql
git commit -m "feat(ops): one-time ops-activity wipe (allowlisted runner + SQL, social flag-gated)"
```

---

## Task 9: Decommission dead routing + docs

Remove now-obsolete tab-alias machinery left in `index.jsx` and update the architecture docs to the new IA. (The orphaned pre-pivot tab folders — `Overview/`, `Connections/`, `Runs/`, `Schedule/`, `Cost/` — are out of scope to delete here unless they break the build; leave them and note them in docs to avoid scope creep.)

**Files:**
- Modify: `src/views/admin/Operations/index.jsx` (remove leftover `TAB_ALIASES`/`WORKSPACE_TABS`/`TabPanel` if any remain after Task 1)
- Modify: `docs/OPERATIONS.md`

- [ ] **Step 1: Confirm no dead shell code remains**

Grep the shell for leftovers: `grep -nE 'WORKSPACE_TABS|TAB_ALIASES|TabPanel' src/views/admin/Operations/index.jsx` — expected: no matches (Task 1 removed them). If any remain, delete them.

- [ ] **Step 2: Update `docs/OPERATIONS.md`**

Replace the stale "9-tab"/"5-tab" UI description with the new IA: a Home/Clients/Portfolio left rail; the per-client page sections (Overview · Findings · Socials · Blog · Sites · Chat + Config: Health checks · Connections · Run history · Cost); the curated Home + per-client Overview digests; the revived Kinsta Sites section. Add the two new endpoints (`GET /api/ops/clients/:id/overview`, `GET /api/ops/home`) to the route table, and note the new `operations.credential_deleted` audit event and the closed subscription/credential authz gaps. Note the one-time wipe lives at `infra/scripts/wipe-ops-activity.mjs` (+ `infra/sql/wipe_ops_activity.sql`) and is admin-run, never automated.

- [ ] **Step 3: Verify**

`yarn build && yarn lint` (clean). `grep` shows no dead shell identifiers. `docs/OPERATIONS.md` reflects the new IA.

- [ ] **Step 4: Commit**
```bash
git add src/views/admin/Operations/index.jsx docs/OPERATIONS.md
git commit -m "chore(ops): remove dead tab shell + document client-first IA"
```

---

## Deployment (after all tasks + final review)

Ops deploys via `gcloud run deploy --source` (`scripts/gdeploy.sh`, Cloud Build → amd64). The two new endpoints need no schema change (they read existing tables). No new secrets. After merging to `main`:
1. `scripts/gdeploy.sh` (build + deploy).
2. Run the wipe once as admin against the prod DB via the Cloud SQL Auth Proxy, **dry-run first**, then `--apply` (and `--include-social` only after confirming `social_posts` holds no production rows — per the strategic decision that the dashboard publisher is being retired with no real posts).
3. Smoke-check `https://ops.anchorcorps.com` (the allowlisted host — not the raw run.app URL): rail navigates, a client page loads all sections, Home digest deep-links work.

## Self-Review Notes (spec coverage)

- Spec §3 IA (rail, active-client context, roster, client page) → Tasks 1–2. Config grouping → Task 6. Per-client Overview §3.3 → Task 4. Home §3.4 → Task 5. Portfolio §3.5 → Task 7. Sites revival §3 → Task 3. Backend additions §4 (overview, home, auth/audit gaps) → Tasks 4–6 (Sites reuses legacy endpoints per the exploration, so the proposed `/api/ops/clients/:id/sites` was intentionally dropped in favor of existing `/api/operations/sites/:siteId/clients` + `fetchClientSites`). Wipe §5 (allowlist, social flag-gated seatbelt) → Task 8. Decommission/docs §7 → Task 9. Compliance §6 (no PHI gate, parameterized queries, server-side authz, audit preserved) is enforced across tasks via Global Constraints.
- Routing deviation (query params vs nested path segments) is documented in Global Constraints and Task 1, realizing the spec's URL-driven intent without an `<Outlet>` restructure.
