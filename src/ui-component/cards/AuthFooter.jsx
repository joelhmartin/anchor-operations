import { Link as RouterLink } from 'react-router-dom';

// material-ui
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';

// ==============================|| FOOTER - AUTHENTICATION 2 & 3 ||============================== //

export default function AuthFooter() {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
      <Typography variant="subtitle2" component={Link} href="https://anchorcorps.com" target="_blank" underline="hover">
        anchorcorps.com
      </Typography>
      <Stack direction="row" sx={{ gap: 2 }}>
        <Typography
          variant="subtitle2"
          component={RouterLink}
          to="/privacy-policy"
          sx={{ textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
        >
          Privacy Policy
        </Typography>
        <Typography variant="subtitle2">&copy; {new Date().getFullYear()} Anchor Corps</Typography>
      </Stack>
    </Stack>
  );
}
