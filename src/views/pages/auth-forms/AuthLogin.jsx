import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

// material-ui
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import InputLabel from '@mui/material/InputLabel';
import OutlinedInput from '@mui/material/OutlinedInput';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';

// project imports
import AnimateButton from 'ui-component/extended/AnimateButton';
import CustomFormControl from 'ui-component/extended/Form/CustomFormControl';
import useAuth from 'hooks/useAuth';
import * as authApi from 'api/auth';
import { useToast } from 'contexts/ToastContext';
import { getErrorMessage } from 'utils/errors';

// assets
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import Button from '@mui/material/Button';

// ===============================|| JWT - LOGIN ||=============================== //

export default function AuthLogin() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, verifyMfa } = useAuth();
  const toast = useToast();

  const [checked, setChecked] = useState(true);
  const [form, setForm] = useState({
    email: location.state?.email || '',
    password: ''
  });
  const [infoMessage, setInfoMessage] = useState(location.state?.resetMessage || '');
  const [mfaChallenge, setMfaChallenge] = useState(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaSubmitting, setMfaSubmitting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('verified') === '1') {
      setInfoMessage('Email verified. You can sign in now.');
    } else if (params.get('verified') === '0') {
      setInfoMessage('Verification link expired or invalid. Request a new email.');
    } else if (params.get('session') === 'expired') {
      setInfoMessage('Your session has expired. Please sign in again.');
    }
  }, [location.search]);

  /**
   * Get the redirect target after successful login
   * Checks sessionStorage for saved path, falls back to location state or home
   */
  const getRedirectTarget = (user) => {
    const role = user?.effective_role || user?.role;
    const onboardingPending = role === 'client' && !user?.onboarding_completed_at;

    if (onboardingPending) return '/onboarding';

    // Check for saved redirect path (from session expiry)
    const savedPath = window.sessionStorage.getItem('redirectAfterLogin');
    if (savedPath) {
      window.sessionStorage.removeItem('redirectAfterLogin');
      return savedPath;
    }

    // Fall back to location state or home
    return location.state?.from?.pathname || '/';
  };
  const handleClickShowPassword = () => {
    setShowPassword(!showPassword);
  };

  const handleMouseDownPassword = (event) => {
    event.preventDefault();
  };

  const handleChange = (event) => {
    setForm((prev) => ({ ...prev, [event.target.name]: event.target.value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setInfoMessage('');
    setSubmitting(true);
    try {
      const result = await login({ ...form, trustDevice: checked });
      if (result?.requiresMfa) {
        setMfaChallenge(result);
        setMfaCode('');
        return;
      }
      const user = result;
      const target = getRedirectTarget(user);
      navigate(target, { replace: true });
    } catch (err) {
      const message = getErrorMessage(err, 'Unable to sign in');
      if (message.toLowerCase().includes('verify')) {
        setInfoMessage('Please verify your email before signing in.');
      }
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const mfaHeading = useMemo(() => {
    if (!mfaChallenge?.maskedEmail) return 'Verification required';
    return `Enter the code sent to ${mfaChallenge.maskedEmail}`;
  }, [mfaChallenge?.maskedEmail]);

  const handleVerifyMfa = async (event) => {
    event.preventDefault();
    if (!mfaChallenge?.challengeId) return;
    setMfaSubmitting(true);
    try {
      const user = await verifyMfa({
        challengeId: mfaChallenge.challengeId,
        code: mfaCode,
        trustDevice: checked
      });
      const target = getRedirectTarget(user);
      navigate(target, { replace: true });
    } catch (err) {
      toast.error(getErrorMessage(err, 'Unable to verify code'));
    } finally {
      setMfaSubmitting(false);
    }
  };

  const handleResendMfa = async () => {
    if (!mfaChallenge?.challengeId) return;
    try {
      const res = await authApi.resendMfa(mfaChallenge.challengeId);
      setInfoMessage('A new code was sent.');
      setMfaChallenge((prev) => (prev ? { ...prev, expiresAt: res.expiresAt } : prev));
    } catch (err) {
      toast.error(getErrorMessage(err, 'Unable to resend code'));
    }
  };

  return (
    <Box component="form" onSubmit={mfaChallenge ? handleVerifyMfa : handleSubmit} sx={{ display: 'grid', gap: 2 }}>
      {infoMessage ? (
        <Typography variant="caption" color="text.secondary">
          {infoMessage}
        </Typography>
      ) : null}

      {mfaChallenge ? (
        <>
          <Typography variant="body2" color="text.secondary">
            {mfaHeading}
          </Typography>
          <CustomFormControl fullWidth>
            <InputLabel htmlFor="outlined-adornment-mfa-code">Verification Code</InputLabel>
            <OutlinedInput
              id="outlined-adornment-mfa-code"
              type="text"
              value={mfaCode}
              onChange={(event) => setMfaCode(event.target.value.replace(/\\D/g, '').slice(0, 6))}
              name="mfaCode"
              autoComplete="one-time-code"
              required
              label="Verification Code"
            />
          </CustomFormControl>
          <Button variant="text" color="secondary" onClick={handleResendMfa} disabled={mfaSubmitting}>
            Resend code
          </Button>
        </>
      ) : (
        <>
          {infoMessage && infoMessage.toLowerCase().includes('verify') ? (
            <Button
              variant="text"
              color="secondary"
              onClick={async () => {
                if (!form.email) {
                  toast.error('Enter your email first.');
                  return;
                }
                try {
                  await authApi.resendEmailVerification(form.email);
                  setInfoMessage('Verification email sent. Please check your inbox.');
                } catch (err) {
                  toast.error(getErrorMessage(err, 'Unable to resend verification'));
                }
              }}
            >
              Resend verification email
            </Button>
          ) : null}
          <CustomFormControl fullWidth>
            <InputLabel htmlFor="outlined-adornment-email-login">Email Address / Username</InputLabel>
            <OutlinedInput
              id="outlined-adornment-email-login"
              type="email"
              value={form.email}
              onChange={handleChange}
              name="email"
              autoComplete="email"
              required
            />
          </CustomFormControl>

          <CustomFormControl fullWidth>
            <InputLabel htmlFor="outlined-adornment-password-login">Password</InputLabel>
            <OutlinedInput
              id="outlined-adornment-password-login"
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              name="password"
              onChange={handleChange}
              autoComplete="current-password"
              required
              endAdornment={
                <InputAdornment position="end">
                  <IconButton
                    aria-label="toggle password visibility"
                    onClick={handleClickShowPassword}
                    onMouseDown={handleMouseDownPassword}
                    edge="end"
                    size="large"
                  >
                    {showPassword ? <Visibility /> : <VisibilityOff />}
                  </IconButton>
                </InputAdornment>
              }
              label="Password"
            />
          </CustomFormControl>
        </>
      )}

      <Grid container sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Grid>
          <FormControlLabel
            control={<Checkbox checked={checked} onChange={(event) => setChecked(event.target.checked)} name="checked" color="primary" />}
            label="Keep me logged in"
          />
        </Grid>
        <Grid>
          <Typography
            variant="subtitle1"
            component={Link}
            to="/pages/forgot-password"
            sx={{ textDecoration: 'none', color: 'secondary.main' }}
          >
            Forgot Password?
          </Typography>
        </Grid>
      </Grid>
      <Box sx={{ mt: 2 }}>
        <AnimateButton>
          <Button
            color="secondary"
            fullWidth
            size="large"
            type="submit"
            variant="contained"
            disabled={submitting || mfaSubmitting}
          >
            {mfaChallenge ? (mfaSubmitting ? 'Verifying...' : 'Verify Code') : submitting ? 'Signing In...' : 'Sign In'}
          </Button>
        </AnimateButton>
      </Box>
    </Box>
  );
}
