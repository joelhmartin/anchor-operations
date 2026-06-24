import { useCallback, useEffect, useMemo, useState } from 'react';
import { Stack, Chip, Button, ToggleButtonGroup, ToggleButton } from '@mui/material';
import dayjs from 'dayjs';
import MainCard from 'ui-component/cards/MainCard';
import DataTable from 'ui-component/extended/DataTable';
import SelectField from 'ui-component/extended/SelectField';
import StatusChip from 'ui-component/extended/StatusChip';
import { listPosts, cancelPost } from 'api/social';
import { useToast } from 'contexts/ToastContext';

export default function QueueView({ clients = [], refreshKey = 0 }) {
  const toast = useToast();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [clientFilter, setClientFilter] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listPosts({});
      setPosts(list);
    } catch (e) {
      toast.error(`Load failed: ${e.response?.data?.error || e.message}`);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const clientName = useCallback((id) => clients.find((c) => c.id === id)?.name || '—', [clients]);

  const filtered = useMemo(() => {
    let xs = posts;
    if (statusFilter !== 'all') xs = xs.filter((p) => p.status === statusFilter);
    if (clientFilter) xs = xs.filter((p) => p.client_id === clientFilter);
    return xs;
  }, [posts, statusFilter, clientFilter]);

  const handleCancel = async (post) => {
    setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, status: 'cancelled' } : p)));
    try {
      await cancelPost(post.id);
      toast.success('Post cancelled');
      refresh();
    } catch (e) {
      setPosts((prev) => prev.map((p) => (p.id === post.id ? post : p)));
      toast.error(`Cancel failed: ${e.response?.data?.error || e.message}`);
    }
  };

  const columns = [
    {
      id: 'client_id',
      label: 'Client',
      sortable: true,
      sortValue: (row) => clientName(row.client_id),
      render: (row) => clientName(row.client_id)
    },
    {
      id: 'platforms',
      label: 'Where',
      render: (row) => (
        <Stack direction="row" spacing={0.5}>
          {row.platforms?.map((p) => (
            <Chip key={p} size="small" label={p} />
          ))}
        </Stack>
      )
    },
    {
      id: 'content',
      label: 'Content',
      render: (row) => {
        const c = row.content || '(media-only)';
        return c.length > 80 ? `${c.slice(0, 80)}…` : c;
      }
    },
    {
      id: 'scheduled_for',
      label: 'When',
      sortable: true,
      sortValue: (row) => dayjs(row.published_at || row.scheduled_for || row.created_at).valueOf(),
      render: (row) => {
        const d = row.published_at || row.scheduled_for || row.created_at;
        return d ? dayjs(d).format('MMM D, h:mm A') : '—';
      }
    },
    {
      id: 'status',
      label: 'Status',
      render: (row) => <StatusChip status={row.status} />
    },
    {
      id: 'actions',
      label: '',
      render: (row) =>
        ['scheduled', 'draft', 'failed'].includes(row.status) ? (
          <Button size="small" color="error" onClick={() => handleCancel(row)}>
            Cancel
          </Button>
        ) : null
    }
  ];

  return (
    <MainCard title="Posts">
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap">
        <ToggleButtonGroup size="small" exclusive value={statusFilter} onChange={(_, v) => v && setStatusFilter(v)}>
          {['all', 'scheduled', 'published', 'partially_published', 'failed', 'draft', 'cancelled'].map((s) => (
            <ToggleButton key={s} value={s}>
              {s.replace('_', ' ')}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <SelectField
          label="Client filter"
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          options={[{ value: '', label: 'All clients' }, ...clients.map((c) => ({ value: c.id, label: c.name || c.email }))]}
          sx={{ minWidth: 200 }}
        />
      </Stack>
      <DataTable
        rows={filtered}
        rowKey="id"
        columns={columns}
        loading={loading}
        searchable
        searchFields={['content']}
        paginated
        pageSize={25}
        emptyTitle="No posts yet"
        emptyMessage="Compose a post to get started."
      />
    </MainCard>
  );
}
