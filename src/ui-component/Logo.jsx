import { useColorScheme } from '@mui/material/styles';
import logo from 'assets/images/logo.svg';
import logoDark from 'assets/images/logo-dark.svg';

// ==============================|| LOGO IMAGE ||============================== //

export default function Logo() {
  const { mode, systemMode } = useColorScheme();
  const resolved = mode === 'system' ? systemMode || 'light' : mode || 'light';
  const isDark = resolved === 'dark';

  // logo.svg contains white accents (for dark bg); logo-dark.svg contains dark accents (for light bg)
  return <img src={isDark ? logo : logoDark} alt="Logo" width={150} />;
}
