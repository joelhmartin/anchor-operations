// src/views/admin/Operations/Chat/ThreadSidebar.jsx
import { List, ListItemButton, ListItemText, Button, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';

export default function ThreadSidebar({ threads, activeId, onSelect, onNew }) {
  return (
    <Stack spacing={1} sx={{ width: 240, borderRight: '1px solid', borderColor: 'divider', pr: 1, height: '100%' }}>
      <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={onNew}>New chat</Button>
      <List dense sx={{ overflowY: 'auto' }}>
        {threads.map((t) => (
          <ListItemButton key={t.id} selected={t.id === activeId} onClick={() => onSelect(t.id)}>
            <ListItemText primary={t.title || 'Untitled'} primaryTypographyProps={{ noWrap: true, variant: 'body2' }} />
          </ListItemButton>
        ))}
        {!threads.length && <Typography variant="caption" sx={{ p: 1, color: 'text.secondary' }}>No conversations yet.</Typography>}
      </List>
    </Stack>
  );
}
