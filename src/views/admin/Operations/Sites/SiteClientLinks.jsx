import { useEffect, useMemo, useState } from 'react';
import { Autocomplete, Chip, IconButton, Stack, TextField, Typography } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import LoadingButton from 'ui-component/extended/LoadingButton';
import SelectField from 'ui-component/extended/SelectField';
import EmptyState from 'ui-component/extended/EmptyState';
import { useToast } from 'contexts/ToastContext';
import { listOpsClients } from 'api/ops';
import { linkSiteToClient, unlinkSiteClient } from 'api/operations';

const RELATIONSHIPS = [
  { value: 'primary', label: 'Primary' },
  { value: 'staging', label: 'Staging' },
  { value: 'microsite', label: 'Microsite' }
];

import { clientLabel as canonicalClientLabel } from '../_clientLabel';

function clientLabel(c) {
  // Lead with the canonical informal-business-name fallback; if a person name
  // is available, suffix it for staff context (Sites is the only place where
  // the linked person matters alongside the business).
  const primary = canonicalClientLabel(c);
  const personName = `${c.first_name || ''} ${c.last_name || ''}`.trim();
  return personName && primary !== personName ? `${primary} — ${personName}` : primary;
}

export default function SiteClientLinks({ siteId, links, onChange }) {
  const { showToast: toast } = useToast();
  const [clients, setClients] = useState([]);
  const [picked, setPicked] = useState(null);
  const [relationship, setRelationship] = useState('primary');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    listOpsClients()
      .then(setClients)
      .catch(() => setClients([]));
  }, []);

  const linkedIds = useMemo(() => new Set((links || []).map((l) => l.client_user_id)), [links]);
  const available = clients.filter((c) => !linkedIds.has(c.id));

  async function handleLink() {
    if (!picked) return;
    setSubmitting(true);
    try {
      await linkSiteToClient(siteId, { client_user_id: picked.id, relationship });
      toast('Client linked', 'success');
      setPicked(null);
      onChange?.();
    } catch (err) {
      toast(err.response?.data?.message || 'Link failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUnlink(linkId) {
    try {
      await unlinkSiteClient(siteId, linkId);
      toast('Client unlinked', 'success');
      onChange?.();
    } catch (err) {
      toast(err.response?.data?.message || 'Unlink failed', 'error');
    }
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1.5} alignItems="center">
        <Autocomplete
          sx={{ minWidth: 360 }}
          size="small"
          options={available}
          getOptionLabel={clientLabel}
          value={picked}
          onChange={(_, v) => setPicked(v)}
          renderInput={(params) => <TextField {...params} label="Add client" />}
        />
        <SelectField
          label="Relationship"
          value={relationship}
          onChange={(e) => setRelationship(e.target.value)}
          options={RELATIONSHIPS}
          size="small"
          fullWidth={false}
          sx={{ minWidth: 160 }}
        />
        <LoadingButton variant="contained" onClick={handleLink} loading={submitting} disabled={!picked} loadingLabel="Linking…">
          Link
        </LoadingButton>
      </Stack>

      {(!links || links.length === 0) && (
        <EmptyState title="No linked clients yet." message="Use the form above to associate this site with an Anchor client." />
      )}

      <Stack spacing={1}>
        {(links || []).map((l) => (
          <Stack key={l.id} direction="row" spacing={1.5} alignItems="center">
            <Typography variant="body2" sx={{ minWidth: 280 }}>
              {clientLabel(l)}
            </Typography>
            <Chip size="small" label={l.relationship} />
            <Typography variant="caption" color="text.secondary">
              {l.notes || ''}
            </Typography>
            <IconButton size="small" onClick={() => handleUnlink(l.id)} title="Unlink">
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}
