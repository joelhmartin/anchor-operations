import { useEffect, useState, useMemo } from 'react';
import {
  Drawer,
  Box,
  Stack,
  Typography,
  IconButton,
  Tabs,
  Tab,
  TextField,
  Autocomplete,
  Chip,
  Skeleton,
  Divider,
  Alert
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import LoadingButton from 'ui-component/extended/LoadingButton';
import SelectField from 'ui-component/extended/SelectField';
import { useToast } from 'contexts/ToastContext';
import { getErrorMessage } from 'utils/errors';
import {
  getSkill,
  listSkillVersions,
  saveSkillVersion,
  listPendingSuggestions,
  approveSuggestion,
  rejectSuggestion,
  listChecks,
  createSkill
} from 'api/opsBulk';

const UMBRELLA_OPTIONS = [
  { value: 'website', label: 'Website' },
  { value: 'google_ads', label: 'Google Ads' },
  { value: 'meta', label: 'Meta' },
  { value: 'ctm', label: 'CTM' }
];

const MODEL_OPTIONS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-pro'
];

function toSlug(umbrella, title) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return umbrella ? `${umbrella}.${base}` : base;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}

export default function SkillDrawer({ skillId, open, onClose, onUpdated, createUmbrella = null }) {
  const { showToast } = useToast();
  const isCreateMode = !skillId && !!createUmbrella;

  const [tab, setTab] = useState(0);
  const [skill, setSkill] = useState(null);
  const [versions, setVersions] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [allChecks, setAllChecks] = useState([]);
  const [loading, setLoading] = useState(false);

  // Editor state (edit mode)
  const [draftPrompt, setDraftPrompt] = useState('');
  const [draftCollectors, setDraftCollectors] = useState([]);
  const [draftReason, setDraftReason] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [saving, setSaving] = useState(false);

  // Create mode state
  const [newUmbrella, setNewUmbrella] = useState(createUmbrella || 'website');
  const [newTitle, setNewTitle] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [newCollectors, setNewCollectors] = useState([]);
  const [newModel, setNewModel] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [creating, setCreating] = useState(false);

  // Suggestion review state
  const [reviewBusy, setReviewBusy] = useState(null); // suggestion id

  // Reset create state when drawer opens
  useEffect(() => {
    if (open && isCreateMode) {
      setNewUmbrella(createUmbrella || 'website');
      setNewTitle('');
      setNewSlug('');
      setNewPrompt('');
      setNewCollectors([]);
      setNewModel('');
      setSlugEdited(false);
    }
  }, [open, isCreateMode, createUmbrella]);

  // Auto-generate slug from title unless manually edited
  useEffect(() => {
    if (!slugEdited && newTitle) {
      setNewSlug(toSlug(newUmbrella, newTitle));
    }
  }, [newTitle, newUmbrella, slugEdited]);

  // Load skill data in edit mode
  useEffect(() => {
    if (!open || !skillId) return;
    let cancelled = false;
    setLoading(true);
    setSkill(null);
    setTab(0);
    Promise.all([
      getSkill(skillId),
      listSkillVersions(skillId),
      listPendingSuggestions(skillId),
      listChecks().catch(() => [])
    ])
      .then(([s, v, sg, c]) => {
        if (cancelled) return;
        setSkill(s);
        setVersions(v || []);
        setSuggestions(sg || []);
        setAllChecks(c || []);
        setDraftPrompt(s?.prompt_md || '');
        setDraftCollectors(Array.isArray(s?.collectors_json) ? s.collectors_json : []);
        setDraftReason('');
        setDraftModel(s?.model || '');
      })
      .catch((e) => { if (!cancelled) showToast({ type: 'error', message: `Failed to load directive: ${getErrorMessage(e)}` }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, skillId, showToast]);

  // Load checks for create mode collector picker
  useEffect(() => {
    if (open && isCreateMode && allChecks.length === 0) {
      listChecks().catch(() => []).then((c) => setAllChecks(c || []));
    }
  }, [open, isCreateMode, allChecks.length]);

  const collectorOptions = useMemo(
    () => {
      const umbrella = isCreateMode ? newUmbrella : skill?.umbrella;
      return allChecks.filter((c) => !umbrella || c.umbrella === umbrella).map((c) => c.check_id);
    },
    [allChecks, skill, isCreateMode, newUmbrella]
  );

  const dirty = skill
    ? draftPrompt !== (skill.prompt_md || '') ||
      JSON.stringify(draftCollectors) !== JSON.stringify(skill.collectors_json || []) ||
      (draftModel || '') !== (skill.model || '')
    : false;

  const handleSave = async () => {
    if (!skill) return;
    setSaving(true);
    try {
      await saveSkillVersion(skill.id, {
        prompt_md: draftPrompt,
        collectors: draftCollectors,
        model: draftModel || null,
        edit_reason: draftReason || null
      });
      const [fresh, v] = await Promise.all([
        getSkill(skill.id),
        listSkillVersions(skill.id)
      ]);
      setSkill(fresh);
      setVersions(v || []);
      setDraftReason('');
      showToast({ type: 'success', message: `Saved as v${fresh.current_version}` });
      if (onUpdated) onUpdated();
    } catch (e) {
      showToast({ type: 'error', message: `Failed to save: ${getErrorMessage(e)}` });
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async () => {
    if (!newTitle.trim() || !newSlug.trim() || !newUmbrella) return;
    setCreating(true);
    try {
      await createSkill({
        slug: newSlug.trim(),
        umbrella: newUmbrella,
        title: newTitle.trim(),
        prompt_md: newPrompt,
        collectors: newCollectors,
        model: newModel || null
      });
      showToast({ type: 'success', message: `Directive "${newTitle}" created` });
      if (onUpdated) onUpdated();
    } catch (e) {
      showToast({ type: 'error', message: `Failed to create directive: ${getErrorMessage(e)}` });
    } finally {
      setCreating(false);
    }
  };

  const handleApprove = async (sug) => {
    setReviewBusy(sug.id);
    try {
      await approveSuggestion(skill.id, sug.id, null);
      setSuggestions((s) => s.filter((x) => x.id !== sug.id));
      // Reload skill state but don't bump version display — approve now creates a recipe
      const fresh = await getSkill(skill.id);
      setSkill(fresh);
      showToast({ type: 'success', message: 'Suggestion approved → recipe created' });
      if (onUpdated) onUpdated();
    } catch (e) {
      showToast({ type: 'error', message: `Failed to approve: ${getErrorMessage(e)}` });
    } finally {
      setReviewBusy(null);
    }
  };

  const handleReject = async (sug) => {
    setReviewBusy(sug.id);
    try {
      await rejectSuggestion(skill.id, sug.id, null);
      setSuggestions((s) => s.filter((x) => x.id !== sug.id));
      showToast({ type: 'success', message: 'Suggestion rejected' });
      if (onUpdated) onUpdated();
    } catch (e) {
      showToast({ type: 'error', message: `Failed to reject: ${getErrorMessage(e)}` });
    } finally {
      setReviewBusy(null);
    }
  };

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{ sx: { width: { xs: '100%', md: 760 } } }}
    >
      <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Box>
            {isCreateMode ? (
              <Typography variant="h5">New directive</Typography>
            ) : (
              <>
                <Typography variant="h5">{skill?.title || 'Directive'}</Typography>
                {skill && (
                  <Typography variant="caption" sx={{ fontFamily: 'monospace' }} color="text.secondary">
                    {skill.slug} &middot; v{skill.current_version}
                  </Typography>
                )}
              </>
            )}
          </Box>
          <IconButton onClick={onClose}><CloseIcon /></IconButton>
        </Stack>

        {/* CREATE MODE */}
        {isCreateMode && (
          <Stack spacing={2} sx={{ flex: 1, minHeight: 0 }}>
            <SelectField
              label="Umbrella"
              value={newUmbrella}
              onChange={(e) => setNewUmbrella(e.target.value)}
              options={UMBRELLA_OPTIONS}
              fullWidth
            />
            <TextField
              label="Title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              fullWidth
              required
            />
            <TextField
              label="Slug"
              value={newSlug}
              onChange={(e) => { setNewSlug(e.target.value); setSlugEdited(true); }}
              fullWidth
              required
              InputProps={{ sx: { fontFamily: 'monospace', fontSize: 13 } }}
              helperText="Auto-generated from umbrella + title. Edit to override."
            />
            <Autocomplete
              multiple
              options={collectorOptions}
              value={newCollectors}
              onChange={(_, v) => setNewCollectors(v)}
              renderTags={(value, getTagProps) =>
                value.map((opt, idx) => (
                  <Chip size="small" label={opt} {...getTagProps({ index: idx })} key={opt} />
                ))
              }
              renderInput={(params) => <TextField {...params} label="Collectors" />}
            />
            <Autocomplete
              freeSolo
              options={MODEL_OPTIONS}
              value={newModel}
              onChange={(_, v) => setNewModel(v || '')}
              onInputChange={(_, v) => setNewModel(v || '')}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Model override"
                  helperText="Leave blank to inherit OPERATIONS_AGENT_MODEL / VERTEX_MODEL env"
                />
              )}
            />
            <TextField
              label="Prompt (markdown)"
              multiline
              minRows={10}
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              InputProps={{ sx: { fontFamily: 'monospace', fontSize: 13 } }}
            />
            <Stack direction="row" spacing={1}>
              <LoadingButton
                variant="contained"
                disabled={!newTitle.trim() || !newSlug.trim()}
                loading={creating}
                onClick={handleCreate}
              >
                Create directive
              </LoadingButton>
            </Stack>
          </Stack>
        )}

        {/* EDIT MODE */}
        {!isCreateMode && (
          <>
            <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
              <Tab label="Editor" />
              <Tab label={`History (${versions.length})`} />
              <Tab label={`Suggestions (${suggestions.length})`} />
            </Tabs>

            {loading && (
              <Stack spacing={1}>
                <Skeleton variant="rectangular" height={48} />
                <Skeleton variant="rectangular" height={300} />
              </Stack>
            )}

            {!loading && skill && tab === 0 && (
              <Stack spacing={2} sx={{ flex: 1, minHeight: 0 }}>
                <Autocomplete
                  multiple
                  options={collectorOptions}
                  value={draftCollectors}
                  onChange={(_, v) => setDraftCollectors(v)}
                  renderTags={(value, getTagProps) =>
                    value.map((opt, idx) => (
                      <Chip size="small" label={opt} {...getTagProps({ index: idx })} key={opt} />
                    ))
                  }
                  renderInput={(params) => <TextField {...params} label="Collectors" />}
                />
                <Autocomplete
                  freeSolo
                  options={MODEL_OPTIONS}
                  value={draftModel}
                  onChange={(_, v) => setDraftModel(v || '')}
                  onInputChange={(_, v) => setDraftModel(v || '')}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Model override"
                      helperText="Leave blank to inherit OPERATIONS_AGENT_MODEL / VERTEX_MODEL env"
                    />
                  )}
                />
                <TextField
                  label="Prompt (markdown)"
                  multiline
                  minRows={14}
                  value={draftPrompt}
                  onChange={(e) => setDraftPrompt(e.target.value)}
                  InputProps={{ sx: { fontFamily: 'monospace', fontSize: 13 } }}
                />
                <TextField
                  label="Edit reason (optional)"
                  value={draftReason}
                  onChange={(e) => setDraftReason(e.target.value)}
                  placeholder="What changed and why?"
                  fullWidth
                />
                <Stack direction="row" spacing={1}>
                  <LoadingButton
                    variant="contained"
                    disabled={!dirty}
                    loading={saving}
                    onClick={handleSave}
                  >
                    Save as new version
                  </LoadingButton>
                </Stack>
              </Stack>
            )}

            {!loading && skill && tab === 1 && (
              <Stack spacing={1.5} sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {versions.length === 0 && (
                  <Typography variant="body2" color="text.secondary">No version history yet.</Typography>
                )}
                {versions.map((v) => (
                  <Box key={v.id} sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="subtitle2">v{v.version_number}</Typography>
                      <Typography variant="caption" color="text.secondary">{fmtDate(v.created_at)}</Typography>
                    </Stack>
                    {v.edit_reason && (
                      <Typography variant="body2" sx={{ mt: 0.5 }}>{v.edit_reason}</Typography>
                    )}
                    {v.model && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: 'monospace' }}>
                        Model: {v.model}
                      </Typography>
                    )}
                    <Typography variant="caption" color="text.secondary">
                      {v.edited_by_agent ? 'Edited by agent' : 'Edited by user'}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            )}

            {!loading && skill && tab === 2 && (
              <Stack spacing={1.5} sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {suggestions.length === 0 && (
                  <Alert severity="info">No pending agent suggestions.</Alert>
                )}
                {suggestions.map((sug) => (
                  <Box key={sug.id} sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>{sug.rationale || 'Agent suggestion (new recipe)'}</Typography>
                    <Divider sx={{ my: 1 }} />
                    <Typography variant="caption" color="text.secondary">Proposed prompt</Typography>
                    <Box
                      component="pre"
                      sx={{
                        fontSize: 12,
                        fontFamily: 'monospace',
                        whiteSpace: 'pre-wrap',
                        bgcolor: 'background.default',
                        p: 1,
                        borderRadius: 0.5,
                        maxHeight: 240,
                        overflow: 'auto'
                      }}
                    >
                      {sug.proposed_prompt_md || ''}
                    </Box>
                    {Array.isArray(sug.proposed_collectors_json) && sug.proposed_collectors_json.length > 0 && (
                      <>
                        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                          Proposed collectors
                        </Typography>
                        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                          {sug.proposed_collectors_json.map((c) => (
                            <Chip key={c} size="small" label={c} />
                          ))}
                        </Stack>
                      </>
                    )}
                    <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                      <LoadingButton
                        variant="contained"
                        color="success"
                        loading={reviewBusy === sug.id}
                        onClick={() => handleApprove(sug)}
                      >
                        Approve → recipe
                      </LoadingButton>
                      <LoadingButton
                        variant="outlined"
                        color="error"
                        loading={reviewBusy === sug.id}
                        onClick={() => handleReject(sug)}
                      >
                        Reject
                      </LoadingButton>
                    </Stack>
                  </Box>
                ))}
              </Stack>
            )}
          </>
        )}
      </Box>
    </Drawer>
  );
}
