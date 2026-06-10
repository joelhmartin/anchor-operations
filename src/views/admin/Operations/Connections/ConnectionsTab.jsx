/**
 * ConnectionsTab — admin/config workspace for the Operations area.
 *
 * Wraps the per-section admin views (Schedule, Cost, Runs, Sites, Bulk) into
 * a single sub-section selector keyed off `?section=` so the top-level IA
 * stays at five tabs.
 */

import { Suspense, lazy } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Box, CircularProgress, Stack, Tab, Tabs } from '@mui/material';
import RunsTab from '../Runs/RunsTab';
import SitesTab from '../Sites/SitesTab';

const ScheduleTab = lazy(() => import('../Schedule/ScheduleTab'));
const CostTab = lazy(() => import('../Cost/CostTab'));

const SECTIONS = [
  { value: 'runs', label: 'Runs' },
  { value: 'schedule', label: 'Schedule' },
  { value: 'cost', label: 'Cost' },
  { value: 'sites', label: 'Sites' }
];

function LazyFallback() {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
      <CircularProgress size={24} />
    </Box>
  );
}

export default function ConnectionsTab({ runIdToOpen, onRunOpened, onCloseRun }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('section') || 'runs';
  const active = SECTIONS.some((s) => s.value === requested) ? requested : 'runs';

  const handleChange = (_, next) => {
    const params = new URLSearchParams(searchParams);
    params.set('section', next);
    setSearchParams(params, { replace: true });
  };

  return (
    <Stack spacing={2}>
      <Tabs
        value={active}
        onChange={handleChange}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ borderBottom: 1, borderColor: 'divider' }}
      >
        {SECTIONS.map((s) => (
          <Tab key={s.value} value={s.value} label={s.label} />
        ))}
      </Tabs>

      <Suspense fallback={<LazyFallback />}>
        {active === 'runs' && <RunsTab runIdToOpen={runIdToOpen} onRunOpened={onRunOpened} onCloseRun={onCloseRun} />}
        {active === 'schedule' && <ScheduleTab />}
        {active === 'cost' && <CostTab />}
        {active === 'sites' && <SitesTab />}
      </Suspense>
    </Stack>
  );
}
