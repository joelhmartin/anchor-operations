import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Stack,
  Typography,
  TextField,
  FormControl,
  FormLabel,
  FormControlLabel,
  Checkbox,
  RadioGroup,
  Radio,
  Alert,
  Autocomplete,
  Button
} from '@mui/material';
import dayjs from 'dayjs';
import { LocalizationProvider, MobileDateTimePicker } from '@mui/x-date-pickers';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import FormDialog from 'ui-component/extended/FormDialog';
import SelectField from 'ui-component/extended/SelectField';
import FacebookPostPreview from 'ui-component/extended/FacebookPostPreview';
import { getClientPages, createPost, getSystemPages, setPagePublishing } from 'api/social';
import { useToast } from 'contexts/ToastContext';
import MediaPicker from './MediaPicker';
import { clientLabel } from 'hooks/useClientLabel';
import { Box } from '@mui/material';

// Real Meta-enforced limits. Going over these means the API rejects the post.
const IG_CAPTION_MAX = 2200;
const IG_HASHTAG_MAX = 30;
const FB_CAPTION_HARD_MAX = 63206;
const FB_CAPTION_SOFT_MAX = 5000; // readability — gets truncated in feed

export default function ComposeDialog({ open, onClose, clients = [], activeClientId = null, presetDate = null, onCreated }) {
  const toast = useToast();

  const [clientPages, setClientPages] = useState([]);
  const [pagesLoading, setPagesLoading] = useState(false);
  const [clientId, setClientId] = useState('');
  const [systemPages, setSystemPages] = useState([]);
  const [linkFbPageId, setLinkFbPageId] = useState('');
  const [linking, setLinking] = useState(false);
  const [selectedFbPageId, setSelectedFbPageId] = useState('');
  const [platforms, setPlatforms] = useState({ facebook: true, instagram: false });
  const [content, setContent] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [media, setMedia] = useState([]);
  const [action, setAction] = useState('publish_now');
  const [scheduledFor, setScheduledFor] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(null);

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setClientId(activeClientId || '');
    setSelectedFbPageId('');
    setClientPages([]);
    setLinkFbPageId('');
    setPlatforms({ facebook: true, instagram: false });
    setContent('');
    setLinkUrl('');
    setMedia([]);
    if (presetDate) {
      setAction('schedule');
      setScheduledFor(dayjs(presetDate).hour(9).minute(0).second(0));
    } else {
      setAction('publish_now');
      setScheduledFor(null);
    }
    setIdempotencyKey(
      typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())
    );
  }, [open, presetDate, activeClientId]);

  // Loader for a client's enabled publishing pages — reusable so we can refresh
  // after linking a Page from the system user's accessible set.
  const loadClientPages = useCallback(async (id) => {
    if (!id) {
      setClientPages([]);
      setSelectedFbPageId('');
      return;
    }
    setPagesLoading(true);
    try {
      const pages = await getClientPages(id);
      const enabled = (pages || []).filter((p) => p.publishing_enabled);
      setClientPages(enabled);
      // Auto-select if exactly one option
      if (enabled.length === 1) setSelectedFbPageId(enabled[0].fb_page_id);
      else setSelectedFbPageId('');
    } catch {
      setClientPages([]);
      setSelectedFbPageId('');
    } finally {
      setPagesLoading(false);
    }
  }, []);

  // Load pages whenever the picked client changes
  useEffect(() => {
    if (!open || !clientId) {
      setClientPages([]);
      setSelectedFbPageId('');
      return;
    }
    let cancelled = false;
    (async () => {
      await loadClientPages(clientId);
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [open, clientId, loadClientPages]);

  // When a scoped client has no enabled pages, load the system user's Pages so
  // staff can link one. Lazy — only fetched when the linker is actually needed.
  useEffect(() => {
    if (!open || !clientId || pagesLoading || clientPages.length > 0) return;
    let cancelled = false;
    getSystemPages()
      .then((rows) => {
        if (!cancelled) setSystemPages(rows || []);
      })
      .catch(() => {
        if (!cancelled) setSystemPages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, clientId, pagesLoading, clientPages.length]);

  const handleLinkPage = async () => {
    if (!clientId || !linkFbPageId) return;
    setLinking(true);
    try {
      await setPagePublishing(clientId, linkFbPageId, true);
      toast.success('Facebook Page linked');
      setLinkFbPageId('');
      await loadClientPages(clientId);
    } catch (e) {
      toast.error(`Could not link Page: ${e.response?.data?.error || e.message}`);
    } finally {
      setLinking(false);
    }
  };

  const selectedPage = useMemo(
    () => clientPages.find((p) => p.fb_page_id === selectedFbPageId) || null,
    [clientPages, selectedFbPageId]
  );
  const pageLinkId = selectedPage?.page_link_id || '';
  const igAvailable = !!selectedPage?.ig_user_id;
  const selectedClient = clients.find((c) => c.id === clientId);
  const isMedical = selectedClient?.client_type === 'medical';

  const platformsArr = [platforms.facebook && 'facebook', platforms.instagram && 'instagram'].filter(Boolean);
  const onlyIg = platforms.instagram && !platforms.facebook;

  const igHashtagCount = useMemo(
    () => (platforms.instagram ? (content.match(/#[\w]+/g) || []).length : 0),
    [content, platforms.instagram]
  );

  const captionIssues = useMemo(() => {
    const issues = [];
    if (platforms.instagram && content.length > IG_CAPTION_MAX) {
      issues.push({
        severity: 'error',
        text: `Instagram caps captions at ${IG_CAPTION_MAX.toLocaleString()} characters. You're at ${content.length.toLocaleString()} — Meta will reject the post.`
      });
    }
    if (platforms.instagram && igHashtagCount > IG_HASHTAG_MAX) {
      issues.push({
        severity: 'error',
        text: `Instagram allows up to ${IG_HASHTAG_MAX} hashtags per post. You have ${igHashtagCount}.`
      });
    }
    if (platforms.facebook && content.length > FB_CAPTION_HARD_MAX) {
      issues.push({
        severity: 'error',
        text: `Facebook caps posts at ${FB_CAPTION_HARD_MAX.toLocaleString()} characters. You're at ${content.length.toLocaleString()}.`
      });
    } else if (platforms.facebook && content.length > FB_CAPTION_SOFT_MAX) {
      issues.push({
        severity: 'warning',
        text: `Facebook will truncate posts over ${FB_CAPTION_SOFT_MAX.toLocaleString()} characters in the feed with a "See more" link.`
      });
    }
    return issues;
  }, [platforms.facebook, platforms.instagram, content, igHashtagCount]);

  const hasHardError = captionIssues.some((i) => i.severity === 'error');

  const submitDisabled =
    !clientId ||
    !pageLinkId ||
    platformsArr.length === 0 ||
    (platforms.instagram && media.length === 0) ||
    (platforms.facebook && content.trim() === '' && media.length === 0) ||
    (action === 'schedule' && (!scheduledFor || scheduledFor.valueOf() < Date.now() + 5 * 60 * 1000)) ||
    hasHardError ||
    submitting;

  const previewCreative = useMemo(() => {
    const firstImage = media.find((m) => m.type === 'image' && m._previewUrl);
    const firstVideo = media.find((m) => m.type === 'video');
    if (!content && media.length === 0) return null;
    return {
      body: content,
      imageUrl: firstImage?._previewUrl || null,
      thumbnailUrl: firstVideo?._previewUrl || null,
      isVideo: !!firstVideo && !firstImage,
      linkUrl: onlyIg ? null : linkUrl || null,
      headline: null,
      callToAction: null
    };
  }, [content, media, linkUrl, onlyIg]);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const mediaForServer = media.map(({ _previewUrl, _warning, ...rest }) => rest);
      const post = await createPost({
        clientId,
        pageLinkId,
        platforms: platformsArr,
        content,
        linkUrl: onlyIg ? null : linkUrl || null,
        media: mediaForServer,
        scheduledFor: action === 'schedule' && scheduledFor ? scheduledFor.toISOString() : null,
        action,
        idempotencyKey
      });
      toast.success(action === 'publish_now' ? 'Posted!' : action === 'schedule' ? 'Scheduled' : 'Saved as draft');
      onCreated?.(post);
      onClose();
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.error || e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const renderPagePicker = () => {
    if (!clientId) {
      return (
        <SelectField label="Facebook Page" value="" options={[]} disabled required onChange={() => {}} />
      );
    }
    if (pagesLoading) {
      return (
        <Typography variant="caption" color="text.secondary">
          Loading pages…
        </Typography>
      );
    }
    if (clientPages.length === 0) {
      return (
        <Stack spacing={1}>
          <Alert severity="info">
            This client has no linked Facebook Page yet. Pick one of the agency&apos;s Pages below to link it
            for publishing.
          </Alert>
          <Stack direction="row" spacing={1} alignItems="center">
            <Autocomplete
              sx={{ flex: 1 }}
              options={systemPages}
              value={systemPages.find((p) => p.id === linkFbPageId) || null}
              onChange={(_e, v) => setLinkFbPageId(v?.id || '')}
              getOptionLabel={(opt) => (opt ? (opt.instagram ? `${opt.name} (IG: @${opt.instagram})` : opt.name) : '')}
              isOptionEqualToValue={(opt, val) => opt.id === val?.id}
              renderInput={(params) => <TextField {...params} label="Link this client's Facebook Page" />}
            />
            <Button variant="contained" onClick={handleLinkPage} disabled={!linkFbPageId || linking}>
              {linking ? 'Linking…' : 'Link'}
            </Button>
          </Stack>
        </Stack>
      );
    }
    if (clientPages.length === 1) {
      const only = clientPages[0];
      return (
        <Typography variant="body2">
          Posting to: <strong>{only.fb_page_name}</strong>
          {only.ig_username ? ` (IG: @${only.ig_username})` : ''}
        </Typography>
      );
    }
    return (
      <Autocomplete
        options={clientPages}
        value={selectedPage}
        onChange={(_e, v) => setSelectedFbPageId(v?.fb_page_id || '')}
        getOptionLabel={(opt) =>
          opt ? (opt.ig_username ? `${opt.fb_page_name} (IG: @${opt.ig_username})` : opt.fb_page_name) : ''
        }
        isOptionEqualToValue={(opt, val) => opt.fb_page_id === val?.fb_page_id}
        renderInput={(params) => <TextField {...params} label="Facebook Page" required />}
      />
    );
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Compose Post"
      maxWidth="md"
      loading={submitting}
      submitLabel={action === 'publish_now' ? 'Post now' : action === 'schedule' ? 'Schedule' : 'Save draft'}
      loadingLabel={action === 'publish_now' ? 'Posting…' : 'Saving…'}
      submitDisabled={submitDisabled}
      onSubmit={handleSubmit}
    >
      {activeClientId ? (
        <TextField
          label="Client"
          value={selectedClient ? clientLabel(selectedClient) : ''}
          InputProps={{ readOnly: true }}
          disabled
          fullWidth
        />
      ) : (
        <Autocomplete
          size="small"
          options={clients}
          getOptionLabel={clientLabel}
          isOptionEqualToValue={(opt, val) => opt.id === val.id}
          value={clients.find((c) => c.id === clientId) || null}
          onChange={(_, v) => {
            setClientId(v ? v.id : '');
            setSelectedFbPageId('');
          }}
          renderInput={(params) => <TextField {...params} label="Client" required />}
        />
      )}
      {isMedical && (
        <Alert severity="warning">
          Medical client — captions are public and must not contain PHI (patient names, conditions, photos, contact
          info).
        </Alert>
      )}

      {renderPagePicker()}

      <FormControl>
        <FormLabel>Platforms</FormLabel>
        <Stack direction="row" spacing={2}>
          <FormControlLabel
            control={
              <Checkbox
                checked={platforms.facebook}
                onChange={(e) => setPlatforms((p) => ({ ...p, facebook: e.target.checked }))}
              />
            }
            label="Facebook"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={platforms.instagram}
                disabled={!igAvailable}
                onChange={(e) => setPlatforms((p) => ({ ...p, instagram: e.target.checked }))}
              />
            }
            label={igAvailable ? 'Instagram' : 'Instagram (not linked)'}
          />
        </Stack>
      </FormControl>

      <Box>
        <TextField
          label="Caption / Message"
          multiline
          minRows={4}
          maxRows={12}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          error={hasHardError}
          fullWidth
        />
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 0.5, px: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            Caption length
          </Typography>
          <Typography
            variant="caption"
            color={hasHardError ? 'error.main' : 'text.secondary'}
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {platforms.instagram
              ? `${content.length.toLocaleString()} / ${IG_CAPTION_MAX.toLocaleString()} characters · ${igHashtagCount}/${IG_HASHTAG_MAX} hashtags`
              : platforms.facebook
                ? `${content.length.toLocaleString()} characters (FB max ${FB_CAPTION_HARD_MAX.toLocaleString()})`
                : `${content.length.toLocaleString()} characters`}
          </Typography>
        </Stack>
        {captionIssues.map((issue, i) => (
          <Alert key={i} severity={issue.severity} sx={{ mt: 1 }}>
            {issue.text}
          </Alert>
        ))}
      </Box>

      {!onlyIg && (
        <TextField
          label="Link URL (Facebook only, optional)"
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
        />
      )}

      <MediaPicker clientId={clientId} value={media} onChange={setMedia} disabled={!clientId} />

      {previewCreative && (
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Preview (Facebook layout — Instagram will display similarly)
          </Typography>
          <FacebookPostPreview
            creative={previewCreative}
            pageName={selectedPage?.fb_page_name || 'Your Page'}
            subtitle="Just now"
          />
        </Box>
      )}

      <FormControl>
        <FormLabel>When</FormLabel>
        <RadioGroup row value={action} onChange={(e) => setAction(e.target.value)}>
          <FormControlLabel value="publish_now" control={<Radio />} label="Now" />
          <FormControlLabel value="schedule" control={<Radio />} label="Schedule" />
          <FormControlLabel value="draft" control={<Radio />} label="Save draft" />
        </RadioGroup>
      </FormControl>

      {action === 'schedule' && (
        <LocalizationProvider dateAdapter={AdapterDayjs}>
          <MobileDateTimePicker
            label="Scheduled for"
            value={scheduledFor}
            onChange={(v) => setScheduledFor(v)}
            minDateTime={dayjs().add(5, 'minute')}
            maxDateTime={dayjs().add(180, 'day')}
          />
        </LocalizationProvider>
      )}
    </FormDialog>
  );
}
