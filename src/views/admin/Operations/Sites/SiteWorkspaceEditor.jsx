import { useEffect, useState } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import Editor from '@monaco-editor/react';
import LoadingButton from 'ui-component/extended/LoadingButton';
import StatusChip from 'ui-component/extended/StatusChip';
import { useToast } from 'contexts/ToastContext';
import { fetchSiteWorkspace, saveSiteWorkspace, triggerSiteScan } from 'api/operations';

export default function SiteWorkspaceEditor({ siteId }) {
  const { showToast: toast } = useToast();
  const [workspace, setWorkspace] = useState(null);
  const [claudeMd, setClaudeMd] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchSiteWorkspace(siteId)
      .then((w) => {
        if (!alive) return;
        setWorkspace(w);
        setClaudeMd(w.claude_md || '');
      })
      .catch((err) => toast(err.response?.data?.message || 'Failed to load workspace', 'error'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [siteId, toast]);

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await saveSiteWorkspace(siteId, { claude_md: claudeMd });
      setWorkspace(updated);
      toast('Workspace saved', 'success');
    } catch (err) {
      toast(err.response?.data?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleScan() {
    setScanning(true);
    try {
      await triggerSiteScan(siteId);
      toast('Scan complete', 'success');
    } catch (err) {
      const msg = err.response?.data?.message || 'Scan failed';
      toast(msg, err.response?.status === 501 ? 'info' : 'error');
    } finally {
      setScanning(false);
    }
  }

  if (loading) return <Typography variant="body2">Loading workspace…</Typography>;

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
      <Stack direction="row" spacing={2} alignItems="center">
        <Typography variant="subtitle2">CLAUDE.md</Typography>
        {workspace?.last_scan_status && (
          <StatusChip
            status={workspace.last_scan_status === 'success' ? 'completed' : 'failed'}
            label={`Last scan: ${workspace.last_scan_status}`}
          />
        )}
        <Box sx={{ flex: 1 }} />
        <LoadingButton onClick={handleScan} loading={scanning} loadingLabel="Scanning…" variant="outlined">
          Re-scan
        </LoadingButton>
        <LoadingButton onClick={handleSave} loading={saving} loadingLabel="Saving…" variant="contained">
          Save
        </LoadingButton>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 380, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
        <Editor
          height="100%"
          defaultLanguage="markdown"
          value={claudeMd}
          onChange={(v) => setClaudeMd(v ?? '')}
          options={{ minimap: { enabled: false }, wordWrap: 'on' }}
        />
      </Box>
    </Stack>
  );
}
