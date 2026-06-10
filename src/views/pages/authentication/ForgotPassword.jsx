import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import useMediaQuery from '@mui/material/useMediaQuery';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import InputLabel from '@mui/material/InputLabel';
import OutlinedInput from '@mui/material/OutlinedInput';

import * as authApi from 'api/auth';
import AuthWrapper1 from './AuthWrapper1';
import AuthCardWrapper from './AuthCardWrapper';
import AnimateButton from 'ui-component/extended/AnimateButton';
import CustomFormControl from 'ui-component/extended/Form/CustomFormControl';
import Logo from 'ui-component/Logo';
import AuthFooter from 'ui-component/cards/AuthFooter';
import Button from '@mui/material/Button';

function ResetRequestForm({ defaultEmail = '', onSuccess }) {
  const [email, setEmail] = useState(defaultEmail);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState({ type: '', message: '', resetUrl: '' });

  const handleSubmit = async (event) => {
    event.preventDefault();
    setStatus({ type: '', message: '', resetUrl: '' });
    setSubmitting(true);
    try {
      const res = await authApi.requestPasswordReset(email);
      const message =
        res?.message || 'If an account exists with that email, we sent password reset instructions.';
      setStatus({ type: 'success', message, resetUrl: res?.resetUrl });
      onSuccess?.({ email, resetUrl: res?.resetUrl });
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Unable to send reset instructions right now.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ display: 'grid', gap: 2, width: 1 }}>
      {status.message && <Alert severity={status.type || 'info'}>{status.message}</Alert>}
      {status.resetUrl && (
        <Alert severity="info">
          Dev reset link (email not configured):{' '}
          <Typography component="span" variant="subtitle2">
            <a href={status.resetUrl} target="_blank" rel="noreferrer">
              {status.resetUrl}
            </a>
          </Typography>
        </Alert>
      )}

      <CustomFormControl fullWidth>
        <InputLabel htmlFor="reset-email">Email Address</InputLabel>
        <OutlinedInput
          id="reset-email"
          type="email"
          name="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
        />
      </CustomFormControl>

      <AnimateButton>
        <Button type="submit" variant="contained" color="secondary" fullWidth size="large" disabled={submitting}>
          {submitting ? 'Sending reset link...' : 'Send reset link'}
        </Button>
      </AnimateButton>
    </Box>
  );
}

function PasswordResetForm({ token, onComplete, onBack }) {
  const [form, setForm] = useState({ password: '', confirm: '' });
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState({ type: '', message: '' });

  const passwordsMatch = useMemo(
    () => form.password && form.password === form.confirm,
    [form.password, form.confirm]
  );

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!passwordsMatch) {
      setStatus({ type: 'error', message: 'Passwords must match.' });
      return;
    }
    setStatus({ type: '', message: '' });
    setSubmitting(true);
    try {
      const res = await authApi.resetPassword({ token, password: form.password });
      setStatus({ type: 'success', message: res?.message || 'Password updated.' });
      onComplete?.(res);
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Unable to reset your password right now.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ display: 'grid', gap: 2, width: 1 }}>
      {status.message && <Alert severity={status.type || 'info'}>{status.message}</Alert>}

      <CustomFormControl fullWidth>
        <InputLabel htmlFor="new-password">New Password</InputLabel>
        <OutlinedInput
          id="new-password"
          type="password"
          name="password"
          value={form.password}
          onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
          autoComplete="new-password"
          required
        />
      </CustomFormControl>

      <CustomFormControl fullWidth>
        <InputLabel htmlFor="confirm-password">Confirm Password</InputLabel>
        <OutlinedInput
          id="confirm-password"
          type="password"
          name="confirm"
          value={form.confirm}
          onChange={(event) => setForm((prev) => ({ ...prev, confirm: event.target.value }))}
          autoComplete="new-password"
          required
          error={Boolean(form.confirm) && !passwordsMatch}
        />
      </CustomFormControl>

      <Stack sx={{ gap: 1 }}>
        <AnimateButton>
          <Button
            type="submit"
            variant="contained"
            color="secondary"
            fullWidth
            size="large"
            disabled={submitting}
          >
            {submitting ? 'Updating password...' : 'Update password'}
          </Button>
        </AnimateButton>
        <Button color="primary" onClick={onBack}>
          Use a different email
        </Button>
      </Stack>
    </Box>
  );
}

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const downMD = useMediaQuery((theme) => theme.breakpoints.down('md'));

  const token = searchParams.get('token') || '';
  const defaultEmail = searchParams.get('email') || '';
  const [email, setEmail] = useState(defaultEmail);

  const clearToken = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('token');
    setSearchParams(next);
  };

  const handleResetComplete = (res) => {
    const emailFromResponse = res?.user?.email || email || '';
    navigate('/pages/login', {
      replace: true,
      state: {
        resetMessage: 'Password updated successfully. Please sign in with your new password.',
        email: emailFromResponse
      }
    });
  };

  return (
    <AuthWrapper1>
      <Stack sx={{ justifyContent: 'flex-end', minHeight: '100vh' }}>
        <Stack sx={{ justifyContent: 'center', alignItems: 'center', minHeight: 'calc(100vh - 68px)' }}>
          <Box sx={{ m: { xs: 1, sm: 3 }, mb: 0, width: { xs: 1, sm: 'auto' } }}>
            <AuthCardWrapper>
              <Stack sx={{ alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                <Box sx={{ mb: 3 }}>
                  <Link to="#" aria-label="logo">
                    <Logo />
                  </Link>
                </Box>
                <Stack sx={{ alignItems: 'center', justifyContent: 'center', gap: 1 }}>
                  <Typography variant={downMD ? 'h3' : 'h2'} sx={{ color: 'secondary.main', textAlign: 'center' }}>
                    {token ? 'Set a new password' : 'Forgot your password?'}
                  </Typography>
                  <Typography variant="caption" sx={{ fontSize: '16px', textAlign: 'center' }}>
                    {token
                      ? 'Enter a new password to secure your account.'
                      : 'Enter your email and we will send you a reset link.'}
                  </Typography>
                </Stack>

                <Box sx={{ width: 1 }}>
                  {token ? (
                    <PasswordResetForm
                      token={token}
                      onComplete={handleResetComplete}
                      onBack={clearToken}
                    />
                  ) : (
                    <ResetRequestForm
                      defaultEmail={email}
                      onSuccess={({ email: submittedEmail }) => setEmail(submittedEmail)}
                    />
                  )}
                </Box>

                <Divider sx={{ width: 1 }} />
                <Stack sx={{ alignItems: 'center' }}>
                  <Typography component={Link} to="/pages/login" variant="subtitle1" sx={{ textDecoration: 'none' }}>
                    Back to login
                  </Typography>
                </Stack>
              </Stack>
            </AuthCardWrapper>
          </Box>
        </Stack>
        <Box sx={{ px: 3, my: 3 }}>
          <AuthFooter />
        </Box>
      </Stack>
    </AuthWrapper1>
  );
}

