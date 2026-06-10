import { useCallback, useEffect, useState } from 'react';

import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import InputAdornment from '@mui/material/InputAdornment';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import MainCard from 'ui-component/cards/MainCard';
import useAuth from 'hooks/useAuth';
import { fetchProfile, updateProfile, uploadAvatar } from 'api/profile';
import { clientLabel } from 'hooks/useClientLabel';
import Button from '@mui/material/Button';

export default function ProfileSettings() {
  const { user, refreshUser } = useAuth();
  const [profile, setProfile] = useState(null);
  const [profileForm, setProfileForm] = useState({
    display_name: '',
    email: '',
    current_password: '',
    new_password: '',
    new_password_confirm: ''
  });
  const [profileLoading, setProfileLoading] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  const loadProfile = useCallback(() => {
    setProfileLoading(true);
    fetchProfile()
      .then((data) => {
        setProfile(data);
        setProfileForm({
          display_name: clientLabel(data),
          email: data.email,
          current_password: '',
          new_password: '',
          new_password_confirm: ''
        });
      })
      .catch((err) => setMessage({ type: 'error', text: err.message || 'Unable to load profile' }))
      .finally(() => setProfileLoading(false));
  }, []);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const handleProfileSave = async () => {
    if (!profileForm.display_name || !profileForm.email) {
      setMessage({ type: 'error', text: 'Display name and email are required' });
      return;
    }
    const wantsPasswordChange = Boolean(profileForm.new_password || profileForm.new_password_confirm || profileForm.current_password);
    if (wantsPasswordChange) {
      if (!profileForm.current_password) {
        setMessage({ type: 'error', text: 'Current password is required to set a new password' });
        return;
      }
      if (!profileForm.new_password) {
        setMessage({ type: 'error', text: 'New password is required' });
        return;
      }
      if (profileForm.new_password !== profileForm.new_password_confirm) {
        setMessage({ type: 'error', text: 'New passwords do not match' });
        return;
      }
    }
    setProfileLoading(true);
    try {
      const payload = {
        first_name: profileForm.display_name.split(' ')[0] || profileForm.display_name,
        last_name: profileForm.display_name.split(' ').slice(1).join(' '),
        email: profileForm.email
      };
      if (wantsPasswordChange) {
        payload.password = profileForm.current_password;
        payload.new_password = profileForm.new_password;
      }
      const updated = await updateProfile(payload);
      setProfile(updated);
      setMessage({ type: 'success', text: 'Profile saved' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Unable to save profile' });
    } finally {
      setProfileLoading(false);
      setProfileForm((prev) => ({ ...prev, current_password: '', new_password: '', new_password_confirm: '' }));
    }
  };

  const handleAvatarUpload = async (file) => {
    if (!file) return;
    try {
      await uploadAvatar(file);
      setMessage({ type: 'success', text: 'Avatar updated' });
      await Promise.all([loadProfile(), refreshUser()]);
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Unable to upload avatar' });
    }
  };

  return (
    <MainCard title="Profile Settings">
      <Stack spacing={3}>
        {message.text && <Alert severity={message.type === 'error' ? 'error' : 'success'}>{message.text}</Alert>}

        {profileLoading && !profile && <LinearProgress />}

        {profile && (
          <Stack spacing={2}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
              <Avatar src={profile.avatar_url || ''} sx={{ width: 96, height: 96 }} />
              <Button variant="outlined" component="label">
                Upload Photo
                <input type="file" hidden accept="image/*" onChange={(e) => handleAvatarUpload(e.target.files?.[0])} />
              </Button>
            </Stack>

            <Stack spacing={2}>
              <TextField
                label="Display Name"
                fullWidth
                value={profileForm.display_name}
                onChange={(e) => setProfileForm((prev) => ({ ...prev, display_name: e.target.value }))}
              />
              <TextField
                label="Email"
                type="email"
                fullWidth
                value={profileForm.email}
                onChange={(e) => setProfileForm((prev) => ({ ...prev, email: e.target.value }))}
              />
              <TextField
                label="Current Password"
                type="password"
                fullWidth
                value={profileForm.current_password}
                onChange={(e) => setProfileForm((prev) => ({ ...prev, current_password: e.target.value }))}
                InputProps={{
                  endAdornment: <InputAdornment position="end">Required to change password</InputAdornment>
                }}
              />
              <TextField
                label="New Password"
                type="password"
                fullWidth
                value={profileForm.new_password}
                onChange={(e) => setProfileForm((prev) => ({ ...prev, new_password: e.target.value }))}
              />
              <TextField
                label="Confirm New Password"
                type="password"
                fullWidth
                value={profileForm.new_password_confirm}
                onChange={(e) => setProfileForm((prev) => ({ ...prev, new_password_confirm: e.target.value }))}
              />
            </Stack>

            <Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Role: <strong>{user?.role || 'Unknown'}</strong>
              </Typography>
            </Box>

            <Button variant="contained" onClick={handleProfileSave} disabled={profileLoading} sx={{ alignSelf: 'flex-start' }}>
              {profileLoading ? 'Saving…' : 'Save Profile'}
            </Button>
          </Stack>
        )}
      </Stack>
    </MainCard>
  );
}
