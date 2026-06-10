import { useEffect, useState, useCallback } from 'react';
import { Box, Stack, Typography, Badge } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SubCard from 'ui-component/cards/SubCard';
import DataTable from 'ui-component/extended/DataTable';
import LoadingButton from 'ui-component/extended/LoadingButton';
import { useToast } from 'contexts/ToastContext';
import { getErrorMessage } from 'utils/errors';
import { listSkills, listPendingSuggestions } from 'api/opsBulk';
import SkillDrawer from './SkillDrawer';

const UMBRELLAS = [
  { value: 'website', label: 'Website' },
  { value: 'google_ads', label: 'Google Ads' },
  { value: 'meta', label: 'Meta' },
  { value: 'ctm', label: 'CTM' }
];

function fmtRel(d) {
  if (!d) return '—';
  const date = new Date(d);
  const m = Math.floor((Date.now() - date.getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return date.toLocaleDateString();
}

export default function SkillsSection() {
  const { showToast } = useToast();
  const [skills, setSkills] = useState([]);
  const [suggestionCounts, setSuggestionCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [openSkillId, setOpenSkillId] = useState(null);
  const [creatingUmbrella, setCreatingUmbrella] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const all = await listSkills();
      setSkills(all);
      // Pending-suggestion counts per directive
      const counts = {};
      await Promise.all(
        all.map(async (s) => {
          try {
            const sugs = await listPendingSuggestions(s.id);
            counts[s.id] = (sugs || []).length;
          } catch {
            counts[s.id] = 0;
          }
        })
      );
      setSuggestionCounts(counts);
    } catch (e) {
      showToast({ type: 'error', message: `Failed to load directives: ${getErrorMessage(e)}` });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { reload(); }, [reload]);

  const onSkillUpdated = () => reload();

  const columns = [
    { id: 'title', label: 'Title' },
    {
      id: 'slug',
      label: 'Slug',
      render: (s) => <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>{s.slug}</Typography>
    },
    {
      id: 'current_version',
      label: 'Version',
      render: (s) => `v${s.current_version}`,
      align: 'right'
    },
    {
      id: 'updated_at',
      label: 'Last edited',
      render: (s) => fmtRel(s.updated_at)
    },
    {
      id: 'pending_suggestions',
      label: 'Suggestions',
      render: (s) => {
        const n = suggestionCounts[s.id] || 0;
        return n > 0 ? <Badge badgeContent={n} color="info" sx={{ ml: 1 }} /> : '—';
      },
      align: 'center'
    }
  ];

  return (
    <Box>
      <Stack direction="row" justifyContent="flex-end" sx={{ mb: 2 }}>
        <LoadingButton
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setCreatingUmbrella('website')}
        >
          New directive
        </LoadingButton>
      </Stack>
      <Stack spacing={2}>
        {UMBRELLAS.map((u) => {
          const rows = skills.filter((s) => s.umbrella === u.value);
          return (
            <SubCard key={u.value} title={u.label}>
              <DataTable
                columns={columns}
                rows={rows}
                rowKey="id"
                paginated
                pageSize={10}
                loading={loading && rows.length === 0}
                emptyTitle="No directives in this umbrella"
                emptyMessage="No directives in this umbrella yet. Click 'New directive' to author one."
                onRowClick={(r) => setOpenSkillId(r.id)}
              />
            </SubCard>
          );
        })}
      </Stack>

      {/* Edit existing directive */}
      <SkillDrawer
        skillId={openSkillId}
        open={!!openSkillId}
        onClose={() => setOpenSkillId(null)}
        onUpdated={onSkillUpdated}
      />

      {/* Create new directive */}
      <SkillDrawer
        skillId={null}
        createUmbrella={creatingUmbrella}
        open={!!creatingUmbrella}
        onClose={() => setCreatingUmbrella(null)}
        onUpdated={() => { setCreatingUmbrella(null); reload(); }}
      />
    </Box>
  );
}
