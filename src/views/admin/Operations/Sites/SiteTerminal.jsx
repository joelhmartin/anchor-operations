import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import SelectField from 'ui-component/extended/SelectField';
import StatusChip from 'ui-component/extended/StatusChip';
import useOperationsTerminal from 'hooks/useOperationsTerminal';

const STATUS_MAP = {
  idle: { status: 'pending', label: 'Idle' },
  connecting: { status: 'in_progress', label: 'Connecting' },
  open: { status: 'completed', label: 'Connected' },
  closed: { status: 'inactive', label: 'Closed' },
  error: { status: 'failed', label: 'Error' }
};

export default function SiteTerminal({ environments }) {
  const containerRef = useRef(null);
  const liveEnv = useMemo(() => environments.find((e) => e.is_live) || environments[0], [environments]);
  const [envId, setEnvId] = useState(liveEnv?.id || '');

  useEffect(() => {
    if (!envId && liveEnv?.id) setEnvId(liveEnv.id);
  }, [envId, liveEnv]);

  const { status, error } = useOperationsTerminal({
    envId,
    containerRef,
    enabled: Boolean(envId)
  });

  const statusInfo = STATUS_MAP[status] || STATUS_MAP.idle;

  return (
    <Stack spacing={1.5} sx={{ height: '100%' }}>
      <Stack direction="row" spacing={2} alignItems="center">
        <SelectField
          label="Environment"
          value={envId}
          onChange={(e) => setEnvId(e.target.value)}
          options={environments.map((e) => ({
            value: e.id,
            label: `${e.environment_name}${e.is_live ? ' (live)' : ''}${e.primary_domain ? ` — ${e.primary_domain}` : ''}`
          }))}
          size="small"
          fullWidth={false}
          sx={{ minWidth: 320 }}
        />
        <StatusChip {...statusInfo} />
        {error && (
          <Typography variant="caption" color="error">
            {error}
          </Typography>
        )}
      </Stack>
      <Box
        ref={containerRef}
        sx={{
          flex: 1,
          minHeight: 360,
          background: '#1e1e1e',
          borderRadius: 1,
          p: 1,
          '& .xterm': { height: '100%' }
        }}
      />
    </Stack>
  );
}
