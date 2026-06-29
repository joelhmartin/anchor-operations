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
  { value: 'cost', label: 'Cost' },
  { value: 'agent_profile', label: 'Agent profile' }
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
  const openClientSection = useCallback(
    (id, s) => patchParams({ view: 'clients', clientUserId: id, section: s }),
    [patchParams]
  );

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
      openClientSection,
      clients, clientsLoading, reloadClients,
      activeClient, statusByClient
    }),
    [view, setView, clientUserId, setClientUserId, section, setSection, openClientSection, clients, clientsLoading, reloadClients, activeClient, statusByClient]
  );

  return <OpsWorkspaceContext.Provider value={value}>{children}</OpsWorkspaceContext.Provider>;
}
