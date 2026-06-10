import { Link as RouterLink } from 'react-router-dom';

// material-ui
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export default function Footer() {
  return (
    <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', pt: 3, mt: 'auto', flexWrap: 'wrap', gap: 1 }}>
      <Typography variant="caption">
        &copy; {new Date().getFullYear()}{' '}
        <Typography component={Link} href="https://anchorcorps.com" underline="hover" target="_blank" sx={{ color: 'secondary.main' }}>
          Anchor Corps
        </Typography>
        . All rights reserved.
      </Typography>
      <Stack direction="row" sx={{ gap: 2, alignItems: 'center' }}>
        <Link component={RouterLink} to="/privacy-policy" underline="hover" variant="caption" color="text.primary">
          Privacy Policy
        </Link>
        <Link href="https://www.linkedin.com/company/anchorcorps/" underline="hover" target="_blank" variant="caption" color="text.primary">
          LinkedIn
        </Link>
      </Stack>
    </Stack>
  );
}
