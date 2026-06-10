import { useEffect, useState } from 'react';
import {
  TextField,
  Stack,
  Switch,
  FormControlLabel,
  Autocomplete,
  Chip
} from '@mui/material';
import FormDialog from 'ui-component/extended/FormDialog';
import SelectField from 'ui-component/extended/SelectField';
import { useToast } from 'contexts/ToastContext';
import { getErrorMessage } from 'utils/errors';
import { createSchedule, updateSchedule, listSkills as fetchSkills } from 'api/opsBulk';

const CADENCE_OPTIONS = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' }
];

const DOW_OPTIONS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' }
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({
  value: h,
  label: `${String(h).padStart(2, '0')}:00 UTC`
}));

const empty = {
  name: '',
  skill_ids: [],
  cadence: 'daily',
  day_of_week: 1,
  day_of_month: 1,
  hour_local: 8,
  enabled: true
};

export default function ScheduleDialog({ open, schedule, onClose, onSaved }) {
  const { showToast } = useToast();
  const [form, setForm] = useState(empty);
  const [skills, setSkills] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetchSkills()
      .then(setSkills)
      .catch(() => setSkills([]));
    if (schedule) {
      setForm({
        name: schedule.name || '',
        skill_ids: schedule.skill_ids || [],
        cadence: schedule.cadence || 'daily',
        day_of_week: schedule.day_of_week ?? 1,
        day_of_month: schedule.day_of_month ?? 1,
        hour_local: schedule.hour_local ?? 8,
        enabled: !!schedule.enabled
      });
    } else {
      setForm(empty);
    }
  }, [open, schedule]);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async () => {
    if (!form.name.trim() || form.skill_ids.length === 0) {
      showToast({ type: 'error', message: 'Name and at least one skill are required.' });
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        skill_ids: form.skill_ids,
        cadence: form.cadence,
        day_of_week: form.cadence === 'weekly' ? form.day_of_week : null,
        day_of_month: form.cadence === 'monthly' ? form.day_of_month : null,
        hour_local: form.hour_local,
        enabled: form.enabled
      };
      let saved;
      let mode;
      if (schedule) {
        saved = await updateSchedule(schedule.id, body);
        mode = 'update';
      } else {
        saved = await createSchedule(body);
        mode = 'create';
      }
      onSaved(saved, mode);
      onClose();
    } catch (e) {
      showToast({ type: 'error', message: `Failed to save: ${getErrorMessage(e)}` });
    } finally {
      setSaving(false);
    }
  };

  const skillOptions = (skills || []).map((s) => ({
    id: s.id,
    label: s.title,
    umbrella: s.umbrella
  }));
  const selectedSkills = skillOptions.filter((opt) => form.skill_ids.includes(opt.id));

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      onSubmit={handleSubmit}
      title={schedule ? 'Edit schedule' : 'New schedule'}
      submitLabel={schedule ? 'Save' : 'Create'}
      loading={saving}
      maxWidth="sm"
    >
      <Stack spacing={2}>
        <TextField
          label="Name"
          fullWidth
          required
          value={form.name}
          onChange={(e) => update('name', e.target.value)}
        />

        <Autocomplete
          multiple
          options={skillOptions}
          value={selectedSkills}
          onChange={(_, v) => update('skill_ids', v.map((x) => x.id))}
          groupBy={(opt) => opt.umbrella}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          getOptionLabel={(opt) => opt.label || ''}
          renderTags={(value, getTagProps) =>
            value.map((opt, idx) => (
              <Chip size="small" label={opt.label} {...getTagProps({ index: idx })} key={opt.id} />
            ))
          }
          renderInput={(params) => <TextField {...params} label="Skills" required />}
        />

        <SelectField
          label="Cadence"
          value={form.cadence}
          onChange={(e) => update('cadence', e.target.value)}
          options={CADENCE_OPTIONS}
          fullWidth
        />

        {form.cadence === 'weekly' && (
          <SelectField
            label="Day of week"
            value={form.day_of_week}
            onChange={(e) => update('day_of_week', Number(e.target.value))}
            options={DOW_OPTIONS}
            fullWidth
          />
        )}

        {form.cadence === 'monthly' && (
          <TextField
            label="Day of month (1–28)"
            type="number"
            value={form.day_of_month}
            onChange={(e) =>
              update('day_of_month', Math.max(1, Math.min(28, Number(e.target.value) || 1)))
            }
            inputProps={{ min: 1, max: 28 }}
            fullWidth
          />
        )}

        <SelectField
          label="Hour"
          value={form.hour_local}
          onChange={(e) => update('hour_local', Number(e.target.value))}
          options={HOUR_OPTIONS}
          fullWidth
        />

        <FormControlLabel
          control={
            <Switch
              checked={form.enabled}
              onChange={(e) => update('enabled', e.target.checked)}
            />
          }
          label="Enabled"
        />
      </Stack>
    </FormDialog>
  );
}
