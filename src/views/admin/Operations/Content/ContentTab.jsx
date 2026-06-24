import { useEffect, useState } from 'react';
import { Stack, Tabs, Tab, Box, Button, ToggleButtonGroup, ToggleButton } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useToast } from 'contexts/ToastContext';
import { listOpsClients } from 'api/ops';
import { clientLabel } from '../_clientLabel';
import QueueView from './QueueView';
import CalendarView from './CalendarView';
import ComposeDialog from './ComposeDialog';
import BlogPane from './blog/BlogPane';

export default function ContentTab() {
  const toast = useToast();
  const [mode, setMode] = useState('social');
  const [tab, setTab] = useState('calendar');
  const [clients, setClients] = useState([]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [presetDate, setPresetDate] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    listOpsClients()
      .then((rows) =>
        setClients((rows || []).map((c) => ({ ...c, name: clientLabel(c) })))
      )
      .catch((e) => toast.error(e?.response?.data?.error || 'Could not load clients'));
  }, [toast]);

  const openCompose = (date = null) => {
    setPresetDate(date);
    setComposeOpen(true);
  };

  const handleCreated = () => setRefreshKey((k) => k + 1);

  return (
    <Stack spacing={2}>
      <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_, v) => v && setMode(v)} sx={{ mb: 1 }}>
        <ToggleButton value="social">Social</ToggleButton>
        <ToggleButton value="blog">Blog</ToggleButton>
      </ToggleButtonGroup>
      {mode === 'blog' ? (
        <BlogPane />
      ) : (
        <>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Tabs value={tab} onChange={(_, v) => setTab(v)}>
              <Tab value="calendar" label="Calendar" />
              <Tab value="queue" label="Queue" />
            </Tabs>
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => openCompose()}>
              New post
            </Button>
          </Stack>

          <Box>
            {tab === 'calendar' && (
              <CalendarView
                refreshKey={refreshKey}
                onDayClick={(d) => openCompose(d)}
                onEventClick={() => {
                  /* future: details popover */
                }}
              />
            )}
            {tab === 'queue' && <QueueView clients={clients} refreshKey={refreshKey} />}
          </Box>

          <ComposeDialog
            open={composeOpen}
            onClose={() => setComposeOpen(false)}
            clients={clients}
            presetDate={presetDate}
            onCreated={handleCreated}
          />
        </>
      )}
    </Stack>
  );
}
