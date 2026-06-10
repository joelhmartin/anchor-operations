import { useEffect, useState, useCallback } from 'react';
import { Box, Stack, Typography, Chip, TextField, Dialog, DialogTitle, DialogContent, DialogActions } from '@mui/material';
import SubCard from 'ui-component/cards/SubCard';
import DataTable from 'ui-component/extended/DataTable';
import LoadingButton from 'ui-component/extended/LoadingButton';
import ConfirmDialog from 'ui-component/extended/ConfirmDialog';
import { useToast } from 'contexts/ToastContext';
import { getErrorMessage } from 'utils/errors';
import { listRecipes, updateRecipe, archiveRecipe } from 'api/opsBulk';

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

function SourceChip({ source }) {
  return (
    <Chip
      size="small"
      label={source === 'agent' ? 'Agent' : 'User'}
      color={source === 'agent' ? 'info' : 'default'}
      variant="outlined"
    />
  );
}

function RecipeEditDialog({ recipe, open, onClose, onSaved }) {
  const { showToast } = useToast();
  const [title, setTitle] = useState('');
  const [recipeMd, setRecipeMd] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (recipe) {
      setTitle(recipe.title || '');
      setRecipeMd(recipe.recipe_md || '');
    }
  }, [recipe]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await updateRecipe(recipe.id, { title, recipe_md: recipeMd });
      showToast({ type: 'success', message: 'Recipe updated' });
      onSaved(updated);
    } catch (e) {
      showToast({ type: 'error', message: `Failed to update recipe: ${getErrorMessage(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Edit recipe</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            fullWidth
          />
          <TextField
            label="Recipe (markdown)"
            multiline
            minRows={12}
            value={recipeMd}
            onChange={(e) => setRecipeMd(e.target.value)}
            InputProps={{ sx: { fontFamily: 'monospace', fontSize: 13 } }}
            fullWidth
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <LoadingButton variant="outlined" onClick={onClose}>Cancel</LoadingButton>
        <LoadingButton
          variant="contained"
          loading={saving}
          loadingLabel="Saving…"
          onClick={handleSave}
          disabled={!title.trim()}
        >
          Save
        </LoadingButton>
      </DialogActions>
    </Dialog>
  );
}

export default function RecipesSection() {
  const { showToast } = useToast();
  const [recipes, setRecipes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingRecipe, setEditingRecipe] = useState(null);
  const [archivingRecipe, setArchivingRecipe] = useState(null);
  const [archiving, setArchiving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const all = await listRecipes();
      setRecipes(all);
    } catch (e) {
      showToast({ type: 'error', message: `Failed to load recipes: ${getErrorMessage(e)}` });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { reload(); }, [reload]);

  const handleArchive = async () => {
    if (!archivingRecipe) return;
    setArchiving(true);
    try {
      await archiveRecipe(archivingRecipe.id);
      setRecipes((prev) => prev.filter((r) => r.id !== archivingRecipe.id));
      showToast({ type: 'success', message: `Recipe "${archivingRecipe.title}" archived` });
      setArchivingRecipe(null);
    } catch (e) {
      showToast({ type: 'error', message: `Failed to archive recipe: ${getErrorMessage(e)}` });
    } finally {
      setArchiving(false);
    }
  };

  const handleSaved = (updated) => {
    setRecipes((prev) => prev.map((r) => r.id === updated.id ? updated : r));
    setEditingRecipe(null);
  };

  const columns = [
    { id: 'title', label: 'Title' },
    {
      id: 'slug',
      label: 'Slug',
      render: (r) => <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>{r.slug}</Typography>
    },
    {
      id: 'source',
      label: 'Source',
      render: (r) => <SourceChip source={r.source} />,
      align: 'center'
    },
    {
      id: 'updated_at',
      label: 'Last edited',
      render: (r) => fmtRel(r.updated_at)
    },
    {
      id: 'actions',
      label: '',
      render: (r) => (
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <LoadingButton size="small" variant="outlined" onClick={(e) => { e.stopPropagation(); setEditingRecipe(r); }}>
            Edit
          </LoadingButton>
          <LoadingButton
            size="small"
            variant="outlined"
            color="error"
            onClick={(e) => { e.stopPropagation(); setArchivingRecipe(r); }}
          >
            Archive
          </LoadingButton>
        </Stack>
      ),
      align: 'right'
    }
  ];

  return (
    <Box>
      <Stack spacing={2}>
        {UMBRELLAS.map((u) => {
          const rows = recipes.filter((r) => r.umbrella === u.value);
          return (
            <SubCard key={u.value} title={u.label}>
              <DataTable
                columns={columns}
                rows={rows}
                rowKey="id"
                paginated
                pageSize={10}
                loading={loading && rows.length === 0}
                emptyTitle="No recipes in this umbrella"
                emptyMessage="Recipes are created when agent suggestions are approved, or can be authored by users."
              />
            </SubCard>
          );
        })}
      </Stack>

      <RecipeEditDialog
        recipe={editingRecipe}
        open={!!editingRecipe}
        onClose={() => setEditingRecipe(null)}
        onSaved={handleSaved}
      />

      <ConfirmDialog
        open={!!archivingRecipe}
        onClose={() => setArchivingRecipe(null)}
        onConfirm={handleArchive}
        title="Archive recipe"
        message={`Archive "${archivingRecipe?.title}"? It will no longer be loaded for directive runs.`}
        confirmLabel="Archive"
        confirmColor="error"
        loading={archiving}
        loadingLabel="Archiving…"
        severity="warning"
      />
    </Box>
  );
}
