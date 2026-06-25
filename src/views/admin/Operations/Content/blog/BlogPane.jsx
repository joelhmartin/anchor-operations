// src/views/admin/Operations/Content/blog/BlogPane.jsx
import { useEffect, useState, useCallback } from 'react';
import { Stack, Autocomplete, TextField, Paper, Typography, Chip, Button } from '@mui/material';
import { listOpsClients } from 'api/ops';
import { listBlogPosts, cancelBlogPost } from 'api/blog';
import { clientLabel } from '../../_clientLabel';
import { useToast } from 'contexts/ToastContext';
import BlogCompose from './BlogCompose';

const STATUS_COLOR = { draft: 'default', scheduled: 'info', publishing: 'warning', published: 'success', failed: 'error', cancelled: 'default' };

export default function BlogPane({ activeClientId }) {
  const [clients, setClients] = useState([]);
  const [client, setClient] = useState(null);

  useEffect(() => {
    if (!activeClientId) return;
    if (clients.length) setClient(clients.find((c) => c.id === activeClientId) || null);
  }, [activeClientId, clients]);
  const [posts, setPosts] = useState([]);
  const toast = useToast();

  useEffect(() => { listOpsClients().then(setClients).catch(() => {}); }, []);
  const refresh = useCallback(() => {
    if (!client?.id) { setPosts([]); return; }
    listBlogPosts(client.id).then(setPosts).catch(() => {});
  }, [client]);
  const onCancel = async (id) => {
    try {
      await cancelBlogPost(id);
      toast.success('Cancelled');
      refresh();
    } catch (e) {
      toast.error(e?.response?.data?.message || 'Cancel failed');
    }
  };
  useEffect(() => { refresh(); }, [refresh]);

  return (
    <Stack spacing={2}>
      {!activeClientId && (
        <Autocomplete size="small" options={clients} value={client} getOptionLabel={(c) => clientLabel(c)}
          onChange={(_, v) => setClient(v)} renderInput={(p) => <TextField {...p} label="Client" />} sx={{ maxWidth: 360 }} />
      )}
      {client && <BlogCompose client={client} onCreated={refresh} />}
      <Stack spacing={1}>
        <Typography variant="subtitle2">Posts</Typography>
        {posts.map((p) => (
          <Paper key={p.id} variant="outlined" sx={{ p: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
            <Chip size="small" color={STATUS_COLOR[p.status] || 'default'} label={p.status} />
            <Typography variant="body2" sx={{ flex: 1 }} noWrap>{p.title}</Typography>
            {p.wp_post_url && <a href={p.wp_post_url} target="_blank" rel="noopener noreferrer">view</a>}
            {['draft', 'scheduled', 'failed'].includes(p.status) && <Button size="small" onClick={() => onCancel(p.id)}>Cancel</Button>}
          </Paper>
        ))}
        {!posts.length && <Typography variant="caption" color="text.secondary">No posts yet.</Typography>}
      </Stack>
    </Stack>
  );
}
