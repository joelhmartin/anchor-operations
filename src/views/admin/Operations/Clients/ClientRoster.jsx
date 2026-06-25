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
