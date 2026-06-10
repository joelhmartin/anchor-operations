import { IconButton, Tooltip } from '@mui/material';
import { useColorScheme } from '@mui/material/styles';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';

export default function ThemeModeToggle({ size = 'medium' }) {
  const { mode, systemMode, setMode } = useColorScheme();
  if (!mode) return null;

  const resolved = mode === 'system' ? systemMode || 'light' : mode;
  const next = resolved === 'dark' ? 'light' : 'dark';
  const label = resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <Tooltip title={label}>
      <IconButton size={size} onClick={() => setMode(next)} aria-label={label}>
        {resolved === 'dark' ? <LightModeIcon fontSize="small" /> : <DarkModeIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  );
}
