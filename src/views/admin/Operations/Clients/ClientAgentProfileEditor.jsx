/**
 * ClientAgentProfileEditor — per-client agent profile Config section.
 *
 * Backed by GET/PUT /api/ops/clients/:id/agent-profile.
 * The GET returns the resolved profile (merged from client_profiles +
 * ops_client_agent_profiles). The PUT saves only agent-profile-specific
 * fields; client_type and monthly_budget_cap_cents are read-only (managed
 * via the existing client profile and Cost config).
 *
 * HIPAA display: if client_type === 'medical', the hipaa_restricted checkbox
 * is rendered checked + disabled. Saving with hipaa_restricted=false for a
 * medical client is rejected server-side anyway, but the UI makes this obvious.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import MainCard from 'ui-component/cards/MainCard';
import LoadingButton from 'ui-component/extended/LoadingButton';
import EmptyState from 'ui-component/extended/EmptyState';
import { useToast } from 'contexts/ToastContext';
import { getClientAgentProfile, updateClientAgentProfile } from 'api/ops';

const PRIMARY_SERVICES_OPTIONS = [
  'paid_ads', 'organic_search', 'website', 'call_tracking', 'analytics', 'social'
];
const PLATFORM_OPTIONS = ['google_ads', 'meta', 'ctm', 'ga4', 'search_console'];

const DEFAULT_FORM = {
  enabled: false,
  client_name: '',
  website_url: '',
  hipaa_restricted: false,
  primary_services_json: [],
  target_cpa_cents: '',
  daily_budget_expected_cents: '',
  monthly_budget_expected_cents: '',
  lead_goal_monthly: '',
  allowed_platforms_json: [],
  auto_action_policy_json: { mode: 'off', max_risk_level: 'low' },
  notification_policy_json: { email: true, digest_frequency: 'weekly' },
  google_chat_policy_json: { enabled: false, space_id: '' },
  agent_notes: ''
};

function profileToForm(profile) {
  if (!profile) return DEFAULT_FORM;
  return {
    enabled: Boolean(profile.enabled),
    client_name: profile.client_name ?? '',
    website_url: profile.website_url ?? '',
    hipaa_restricted: Boolean(profile.hipaa_restricted),
    primary_services_json: Array.isArray(profile.primary_services) ? profile.primary_services : [],
    target_cpa_cents: profile.target_cpa_cents != null ? String(profile.target_cpa_cents) : '',
    daily_budget_expected_cents: profile.daily_budget_expected_cents != null ? String(profile.daily_budget_expected_cents) : '',
    monthly_budget_expected_cents: profile.monthly_budget_expected_cents != null ? String(profile.monthly_budget_expected_cents) : '',
    lead_goal_monthly: profile.lead_goal_monthly != null ? String(profile.lead_goal_monthly) : '',
    allowed_platforms_json: Array.isArray(profile.allowed_platforms) ? profile.allowed_platforms : [],
    auto_action_policy_json: profile.auto_action_policy ?? { mode: 'off', max_risk_level: 'low' },
    notification_policy_json: profile.notification_policy ?? { email: true, digest_frequency: 'weekly' },
    google_chat_policy_json: {
      ...{ enabled: false, space_id: '' },
      ...(profile.google_chat_policy ?? {}),
      space_id: profile.google_chat_policy?.space_id ?? ''
    },
    agent_notes: profile.agent_notes ?? ''
  };
}

function formToPayload(form) {
  const intOrNull = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  return {
    enabled: form.enabled,
    client_name: form.client_name.trim() || null,
    website_url: form.website_url.trim() || null,
    hipaa_restricted: form.hipaa_restricted,
    primary_services_json: form.primary_services_json,
    target_cpa_cents: intOrNull(form.target_cpa_cents),
    daily_budget_expected_cents: intOrNull(form.daily_budget_expected_cents),
    monthly_budget_expected_cents: intOrNull(form.monthly_budget_expected_cents),
    lead_goal_monthly: intOrNull(form.lead_goal_monthly),
    allowed_platforms_json: form.allowed_platforms_json,
    auto_action_policy_json: form.auto_action_policy_json,
    notification_policy_json: form.notification_policy_json,
    google_chat_policy_json: {
      enabled: form.google_chat_policy_json.enabled,
      space_id: form.google_chat_policy_json.space_id.trim() || null
    },
    agent_notes: form.agent_notes.trim() || null
  };
}

export default function ClientAgentProfileEditor({ clientUserId }) {
  const { showToast } = useToast();
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const isMedical = profile?.client_type === 'medical';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { profile: p } = await getClientAgentProfile(clientUserId);
      setProfile(p);
      setForm(profileToForm(p));
    } catch (err) {
      showToast(`Couldn't load agent profile: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [clientUserId, showToast]);

  useEffect(() => { load(); }, [load]);

  const patch = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const patchPolicy = (policyKey, key, value) =>
    setForm((prev) => ({ ...prev, [policyKey]: { ...prev[policyKey], [key]: value } }));

  const toggleList = (listKey, item) =>
    setForm((prev) => {
      const cur = prev[listKey];
      return {
        ...prev,
        [listKey]: cur.includes(item) ? cur.filter((x) => x !== item) : [...cur, item]
      };
    });

  const save = async () => {
    setSaving(true);
    try {
      const { profile: updated } = await updateClientAgentProfile(clientUserId, formToPayload(form));
      setProfile(updated);
      setForm(profileToForm(updated));
      showToast('Agent profile saved', 'success');
    } catch (err) {
      showToast(`Save failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !profile) {
    return <EmptyState title="Loading…" message="Fetching agent profile." />;
  }

  return (
    <Stack spacing={2}>
      {/* Toolbar */}
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="h4">Agent Profile</Typography>
        <Box sx={{ flex: 1 }} />
        <Button startIcon={<RefreshIcon />} variant="outlined" size="small" onClick={load} disabled={loading}>
          Refresh
        </Button>
        <LoadingButton
          startIcon={<SaveIcon />}
          variant="contained"
          size="small"
          onClick={save}
          loading={saving}
          loadingLabel="Saving"
        >
          Save
        </LoadingButton>
      </Stack>

      {/* Identity */}
      <MainCard title="Identity">
        <Stack spacing={2}>
          <FormControlLabel
            control={<Switch checked={form.enabled} onChange={(e) => patch('enabled', e.target.checked)} />}
            label="Agent enabled for this client"
          />
          <TextField
            label="Client name override"
            value={form.client_name}
            onChange={(e) => patch('client_name', e.target.value)}
            size="small"
            fullWidth
            inputProps={{ maxLength: 200 }}
            helperText="Overrides the display name used in agent context."
          />
          <TextField
            label="Website URL"
            value={form.website_url}
            onChange={(e) => patch('website_url', e.target.value)}
            size="small"
            fullWidth
            inputProps={{ maxLength: 500 }}
            placeholder="https://"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={isMedical ? true : form.hipaa_restricted}
                disabled={isMedical}
                onChange={(e) => patch('hipaa_restricted', e.target.checked)}
              />
            }
            label={
              isMedical
                ? 'HIPAA restricted (enforced — medical client type)'
                : 'HIPAA restricted'
            }
          />
        </Stack>
      </MainCard>

      {/* Goals */}
      <MainCard title="Goals">
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} flexWrap="wrap">
          <TextField
            label="Target CPA"
            value={form.target_cpa_cents}
            onChange={(e) => patch('target_cpa_cents', e.target.value)}
            size="small"
            type="number"
            inputProps={{ min: 0 }}
            InputProps={{ endAdornment: <InputAdornment position="end">¢</InputAdornment> }}
            sx={{ width: 180 }}
          />
          <TextField
            label="Daily budget expected"
            value={form.daily_budget_expected_cents}
            onChange={(e) => patch('daily_budget_expected_cents', e.target.value)}
            size="small"
            type="number"
            inputProps={{ min: 0 }}
            InputProps={{ endAdornment: <InputAdornment position="end">¢</InputAdornment> }}
            sx={{ width: 220 }}
          />
          <TextField
            label="Monthly budget expected"
            value={form.monthly_budget_expected_cents}
            onChange={(e) => patch('monthly_budget_expected_cents', e.target.value)}
            size="small"
            type="number"
            inputProps={{ min: 0 }}
            InputProps={{ endAdornment: <InputAdornment position="end">¢</InputAdornment> }}
            sx={{ width: 230 }}
          />
          <TextField
            label="Monthly lead goal"
            value={form.lead_goal_monthly}
            onChange={(e) => patch('lead_goal_monthly', e.target.value)}
            size="small"
            type="number"
            inputProps={{ min: 0 }}
            sx={{ width: 180 }}
          />
        </Stack>
        {profile?.monthly_budget_cap_cents != null && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Monthly run cap: {profile.monthly_budget_cap_cents}¢ — edit via Cost config.
          </Typography>
        )}
      </MainCard>

      {/* Services + Platforms */}
      <MainCard title="Services &amp; Platforms">
        <Stack spacing={1.5}>
          <Typography variant="subtitle2">Primary services</Typography>
          <Stack direction="row" flexWrap="wrap" gap={0.5}>
            {PRIMARY_SERVICES_OPTIONS.map((s) => (
              <FormControlLabel
                key={s}
                control={
                  <Checkbox
                    size="small"
                    checked={form.primary_services_json.includes(s)}
                    onChange={() => toggleList('primary_services_json', s)}
                  />
                }
                label={s}
              />
            ))}
          </Stack>
          <Typography variant="subtitle2" sx={{ pt: 1 }}>Allowed platforms</Typography>
          <Stack direction="row" flexWrap="wrap" gap={0.5}>
            {PLATFORM_OPTIONS.map((p) => {
              const metaGated = isMedical && p === 'meta';
              return (
                <FormControlLabel
                  key={p}
                  control={
                    <Checkbox
                      size="small"
                      checked={form.allowed_platforms_json.includes(p)}
                      onChange={() => !metaGated && toggleList('allowed_platforms_json', p)}
                      disabled={metaGated}
                    />
                  }
                  label={metaGated ? `${p} (HIPAA gated)` : p}
                />
              );
            })}
          </Stack>
        </Stack>
      </MainCard>

      {/* Automation policy */}
      <MainCard title="Automation policy">
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel>Mode</InputLabel>
            <Select
              label="Mode"
              value={form.auto_action_policy_json.mode}
              onChange={(e) => patchPolicy('auto_action_policy_json', 'mode', e.target.value)}
            >
              <MenuItem value="off">Off — no autonomous actions</MenuItem>
              <MenuItem value="suggest">Suggest only</MenuItem>
              <MenuItem value="auto">Autonomous</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel>Max risk level</InputLabel>
            <Select
              label="Max risk level"
              value={form.auto_action_policy_json.max_risk_level}
              onChange={(e) => patchPolicy('auto_action_policy_json', 'max_risk_level', e.target.value)}
            >
              <MenuItem value="low">Low</MenuItem>
              <MenuItem value="medium">Medium</MenuItem>
              <MenuItem value="high">High</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </MainCard>

      {/* Notification policy */}
      <MainCard title="Notifications">
        <Stack spacing={2}>
          <FormControlLabel
            control={
              <Switch
                checked={form.notification_policy_json.email}
                onChange={(e) => patchPolicy('notification_policy_json', 'email', e.target.checked)}
              />
            }
            label="Email notifications"
          />
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel>Digest frequency</InputLabel>
            <Select
              label="Digest frequency"
              value={form.notification_policy_json.digest_frequency}
              onChange={(e) => patchPolicy('notification_policy_json', 'digest_frequency', e.target.value)}
            >
              <MenuItem value="none">None</MenuItem>
              <MenuItem value="daily">Daily</MenuItem>
              <MenuItem value="weekly">Weekly</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </MainCard>

      {/* Google Chat */}
      <MainCard title="Google Chat">
        <Stack spacing={2}>
          <FormControlLabel
            control={
              <Switch
                checked={form.google_chat_policy_json.enabled}
                onChange={(e) => patchPolicy('google_chat_policy_json', 'enabled', e.target.checked)}
              />
            }
            label="Send digests / alerts to Google Chat"
          />
          {form.google_chat_policy_json.enabled && (
            <TextField
              label="Space ID"
              value={form.google_chat_policy_json.space_id}
              onChange={(e) => patchPolicy('google_chat_policy_json', 'space_id', e.target.value)}
              size="small"
              fullWidth
              placeholder="spaces/XXXXXXXXXX"
              helperText="From the Google Chat space URL: chat.google.com/room/<space-id>."
            />
          )}
        </Stack>
      </MainCard>

      {/* Agent notes */}
      <MainCard title="Agent notes">
        <TextField
          multiline
          minRows={3}
          maxRows={8}
          fullWidth
          value={form.agent_notes}
          onChange={(e) => patch('agent_notes', e.target.value)}
          placeholder="Internal notes for the agent — client preferences, campaign context, special constraints…"
          inputProps={{ maxLength: 2000 }}
          helperText={`${form.agent_notes.length}/2000`}
        />
      </MainCard>

      {profile?.client_type && (
        <Typography variant="caption" color="text.secondary">
          Client type: {profile.client_type}
        </Typography>
      )}
    </Stack>
  );
}
