// src/views/admin/Operations/Content/blog/BlogCompose.jsx
import { useEffect, useState } from 'react';
import { Stack, TextField, Select, MenuItem, Button, Box, Typography } from '@mui/material';
import { useToast } from 'contexts/ToastContext';
import { listClientWpSites, createBlogPost, uploadBlogMedia } from 'api/blog';
import Markdown from 'ui-component/extended/Markdown';

export default function BlogCompose({ client, onCreated }) {
  const toast = useToast();
  const [sites, setSites] = useState([]);
  const [site, setSite] = useState('');
  const [title, setTitle] = useState('');
  const [md, setMd] = useState('');
  const [featured, setFeatured] = useState(null); // { id, url }
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSites([]); setSite('');
    if (client?.id) listClientWpSites(client.id).then((s) => { setSites(s); if (s[0]) setSite(s[0].kinsta_environment_id); }).catch(() => {});
  }, [client]);

  const chosen = sites.find((s) => s.kinsta_environment_id === site) || {};

  const onPickImage = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { setFeatured(await uploadBlogMedia(f)); } catch { toast.error('Image upload failed'); }
  };

  const submit = async (action) => {
    if (!client) { toast.warning('Pick a client'); return; }
    if (!chosen.kinsta_environment_id) { toast.warning('Pick a Kinsta site'); return; }
    if (!title.trim()) { toast.warning('Title required'); return; }
    setBusy(true);
    try {
      await createBlogPost({
        client_user_id: client.id, action,
        kinsta_environment_id: chosen.kinsta_environment_id || site,
        title, content_markdown: md, featured_file_upload_id: featured?.id || null,
        scheduled_for: action === 'schedule' ? (when ? new Date(when).toISOString() : null) : null
      });
      toast.success(action === 'publish_now' ? 'Queued to publish' : action === 'schedule' ? 'Scheduled' : 'Saved draft');
      setTitle(''); setMd(''); setFeatured(null); setWhen('');
      onCreated?.();
    } catch (e) { toast.error(e?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  return (
    <Stack spacing={1.5}>
      <Select size="small" value={site} onChange={(e) => setSite(e.target.value)} displayEmpty>
        <MenuItem value="" disabled>{sites.length ? 'Select Kinsta site' : 'No Kinsta site with a live environment is assigned — assign one in the Sites tab'}</MenuItem>
        {sites.map((s) => (
          <MenuItem key={s.kinsta_environment_id} value={s.kinsta_environment_id}>
            <Stack>
              <span>{s.label}</span>
              {s.primary_domain && <Typography variant="caption" color="text.secondary">{s.primary_domain}</Typography>}
            </Stack>
          </MenuItem>
        ))}
      </Select>
      <TextField size="small" label="Title" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth />
      <Stack direction="row" spacing={2}>
        <TextField multiline minRows={12} label="Content (markdown)" value={md} onChange={(e) => setMd(e.target.value)} sx={{ flex: 1 }} />
        <Box sx={{ flex: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5, overflow: 'auto', maxHeight: 360 }}>
          <Typography variant="caption" color="text.secondary">Preview</Typography>
          <Markdown>{md}</Markdown>
        </Box>
      </Stack>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button variant="outlined" component="label" size="small">{featured ? 'Change hero image' : 'Add hero image'}<input hidden type="file" accept="image/*" onChange={onPickImage} /></Button>
        {featured && <Typography variant="caption" color="text.secondary">image attached</Typography>}
        <TextField size="small" type="datetime-local" label="Schedule" InputLabelProps={{ shrink: true }} value={when} onChange={(e) => setWhen(e.target.value)} sx={{ ml: 'auto' }} />
      </Stack>
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button disabled={busy} onClick={() => submit('draft')}>Save draft</Button>
        <Button disabled={busy} variant="outlined" onClick={() => submit('schedule')}>Schedule</Button>
        <Button disabled={busy} variant="contained" onClick={() => submit('publish_now')}>Publish now</Button>
      </Stack>
    </Stack>
  );
}
