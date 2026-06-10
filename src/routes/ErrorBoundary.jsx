import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { useEffect, useMemo } from 'react';

// material-ui
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

// ==============================|| ELEMENT ERROR - COMMON ||============================== //

export default function ErrorBoundary() {
  const error = useRouteError();

  const message = useMemo(() => {
    if (!error) return '';
    if (typeof error === 'string') return error;
    if (error?.message) return String(error.message);
    return '';
  }, [error]);

  // Common production failure after deploys: stale HTML shell points at missing chunk files
  // and dynamic import fails with a "Failed to fetch dynamically imported module" message.
  const isChunkLoadFailure =
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Loading chunk') ||
    message.includes('ChunkLoadError') ||
    message.includes('imported module');

  // Best-effort self-heal: reload once to pick up the latest index.html + assets.
  useEffect(() => {
    if (!isChunkLoadFailure) return;
    const key = 'anchor:lastChunkReloadAt';
    const last = Number(window.localStorage.getItem(key) || '0');
    const now = Date.now();
    // reload at most once per minute to avoid loops
    if (now - last > 60000) {
      window.localStorage.setItem(key, String(now));
      // hard reload to bypass cached HTML where possible
      window.location.reload();
    }
  }, [isChunkLoadFailure]);

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      return <Alert color="error">Error 404 - This page doesn't exist!</Alert>;
    }

    if (error.status === 401) {
      return <Alert color="error">Error 401 - You aren't authorized to see this</Alert>;
    }

    if (error.status === 503) {
      return <Alert color="error">Error 503 - Looks like our API is down</Alert>;
    }

    if (error.status === 418) {
      return <Alert color="error">Error 418 - Contact administrator</Alert>;
    }
  }

  if (isChunkLoadFailure) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error" sx={{ mb: 2 }}>
          This page failed to load (usually after a recent update). Please refresh.
        </Alert>
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary">
            If you keep seeing this, close the tab and reopen `dashboard.anchorcorps.com`.
          </Typography>
          <Button variant="contained" onClick={() => window.location.reload()}>
            Reload Page
          </Button>
          {message && (
            <Typography variant="caption" sx={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
              {message}
            </Typography>
          )}
        </Stack>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2 }}>
      <Alert severity="error" sx={{ mb: 2 }}>
        Unexpected error
      </Alert>
      {message ? (
        <Typography variant="caption" sx={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          {message}
        </Typography>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Under maintenance
        </Typography>
      )}
    </Box>
  );
}
