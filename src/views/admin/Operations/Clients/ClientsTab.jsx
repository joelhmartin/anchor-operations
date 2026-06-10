/**
 * ClientsTab — Phase 9 per-client command center.
 *
 * Two-pane layout: client list on the left, ClientOpsView on the right showing
 * latest runs, subscriptions, credentials health, and an "Open Chat" link.
 */

import { useEffect, useMemo, useState } from 'react';
import { Box, Grid, Stack, TextField, Typography } from '@mui/material';
import MainCard from 'ui-component/cards/MainCard';
import EmptyState from 'ui-component/extended/EmptyState';
import { useToast } from 'contexts/ToastContext';
import { listOpsClients } from 'api/ops';
import { clientLabel } from '../_clientLabel';
import ClientOpsView from './ClientOpsView';

export default function ClientsTab({ onOpenChat, onOpenRun, initialClientUserId }) {
  const { showToast } = useToast();
  const [clients, setClients] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(initialClientUserId || null);

  useEffect(() => {
    listOpsClients()
      .then((rows) => {
        const mapped = (rows || [])
          .map((c) => ({
            id: c.id || c.user_id,
            name: clientLabel(c)
          }))
          .filter((x) => x.id);
        setClients(mapped);
        if (!selectedId && mapped[0]) setSelectedId(mapped[0].id);
      })
      .catch((err) => showToast(`Couldn't load clients: ${err.message}`, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) => (c.name || '').toLowerCase().includes(q));
  }, [clients, search]);

  const selected = clients.find((c) => c.id === selectedId) || null;

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} md={3}>
        <MainCard title="Clients" contentSX={{ p: 1 }}>
          <Stack spacing={1}>
            <TextField size="small" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Box sx={{ maxHeight: 600, overflowY: 'auto' }}>
              {filtered.length === 0 ? (
                <EmptyState title="No clients" />
              ) : (
                filtered.map((c) => (
                  <Box
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    sx={{
                      p: 1,
                      borderRadius: 1,
                      cursor: 'pointer',
                      bgcolor: c.id === selectedId ? 'primary.lighter' : 'transparent',
                      '&:hover': { bgcolor: 'action.hover' }
                    }}
                  >
                    <Typography variant="body2" noWrap>
                      {c.name}
                    </Typography>
                  </Box>
                ))
              )}
            </Box>
          </Stack>
        </MainCard>
      </Grid>
      <Grid item xs={12} md={9}>
        {selected ? (
          <ClientOpsView clientUserId={selected.id} clientName={selected.name} onOpenChat={onOpenChat} onOpenRun={onOpenRun} />
        ) : (
          <MainCard>
            <EmptyState title="Pick a client on the left" message="Their ops snapshot will appear here." />
          </MainCard>
        )}
      </Grid>
    </Grid>
  );
}
