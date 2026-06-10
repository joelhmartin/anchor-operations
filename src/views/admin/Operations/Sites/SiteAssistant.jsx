/**
 * SiteAssistant — decommissioned panel (Phase 10).
 *
 * The inline per-site assistant was replaced by the unified per-client AI
 * supervisor in Phase 7. Phase 10 removed the legacy `/api/operations/assistant/chat`
 * endpoint. This component now renders a forwarding notice; the SiteDrawer
 * panel is kept so existing deep links don't 404.
 */

import { Alert, Button, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

export default function SiteAssistant() {
  return (
    <Stack spacing={2} sx={{ p: 1 }}>
      <Alert severity="info" variant="outlined">
        <Typography variant="body2" sx={{ mb: 1 }}>
          The per-site assistant moved. AI chat is now per-client and lives in
          its own tab — pick a client, ask anything, and the supervisor will
          delegate to the right specialist (website, Google Ads, Meta).
        </Typography>
        <Button
          component={RouterLink}
          to="/operations?tab=chat"
          variant="contained"
          size="small"
        >
          Open AI Chat
        </Button>
      </Alert>
    </Stack>
  );
}
