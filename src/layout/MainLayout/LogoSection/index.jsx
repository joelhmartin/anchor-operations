import { Link as RouterLink } from 'react-router-dom';

import Box from '@mui/material/Box';
import Link from '@mui/material/Link';

import Logo from 'ui-component/Logo';
import useClientDisplayLogo from 'hooks/useClientDisplayLogo';

export default function LogoSection() {
  const clientLogo = useClientDisplayLogo();

  return (
    <Link
      component={RouterLink}
      to="/"
      aria-label="theme-logo"
      sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}
    >
      {clientLogo?.url ? (
        <Box
          component="img"
          src={clientLogo.url}
          alt="Client logo"
          sx={{ maxHeight: 40, maxWidth: '100%', objectFit: 'contain' }}
        />
      ) : (
        <Logo />
      )}
    </Link>
  );
}
