import { useRef, useState } from 'react';
import { Stack, Box, Button, TextField, IconButton, Typography, Tooltip } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { uploadMedia } from 'api/social';
import { useToast } from 'contexts/ToastContext';
import { parseVimeoId } from 'utils/vimeo';

export default function MediaPicker({ clientId, value = [], onChange, disabled = false }) {
  const toast = useToast();
  const fileInputRef = useRef(null);
  const [vimeoInput, setVimeoInput] = useState('');
  const [uploading, setUploading] = useState(false);

  const handleFiles = async (files) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const next = [...value];
      for (const f of files) {
        const warning = f.size > 8 * 1024 * 1024 ? 'Large file — may slow Meta processing' : null;

        const previewUrl = URL.createObjectURL(f);
        const result = await uploadMedia(f, clientId);
        const aspectWarning = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const ratio = img.naturalWidth / img.naturalHeight;
            if (ratio < 0.8 || ratio > 1.91) {
              resolve('May be cropped on Instagram (4:5 to 1.91:1 recommended)');
            } else resolve(null);
          };
          img.onerror = () => resolve(null);
          img.src = previewUrl;
        });

        next.push({
          type: 'image',
          source: 'upload',
          file_upload_id: result.fileUploadId,
          _previewUrl: previewUrl,
          _warning: aspectWarning || warning || null
        });
      }
      onChange(next);
      toast.success(`Uploaded ${files.length} image${files.length === 1 ? '' : 's'}`);
    } catch (e) {
      toast.error(`Upload failed: ${e.response?.data?.error || e.message}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleAddVimeo = () => {
    const id = parseVimeoId(vimeoInput);
    if (!id) {
      toast.error('Could not parse Vimeo URL or ID');
      return;
    }
    if (value.some((m) => m.source === 'vimeo' && m.vimeo_id === id)) {
      toast.info('That Vimeo video is already in this post');
      return;
    }
    onChange([
      ...value,
      {
        type: 'video',
        source: 'vimeo',
        vimeo_id: id,
        _previewUrl: `https://vumbnail.com/${id}.jpg`,
        _warning: null
      }
    ]);
    setVimeoInput('');
    toast.success('Vimeo video added');
  };

  const removeAt = (i) => {
    const item = value[i];
    if (item?._previewUrl && item.source === 'upload') {
      URL.revokeObjectURL(item._previewUrl);
    }
    onChange(value.filter((_, idx) => idx !== i));
  };

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
        <Button variant="outlined" component="label" disabled={disabled || uploading}>
          {uploading ? 'Uploading…' : 'Add Images'}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png"
            multiple
            hidden
            onChange={(e) => handleFiles(Array.from(e.target.files || []))}
          />
        </Button>
        <Stack direction="row" spacing={1} sx={{ flex: 1 }}>
          <TextField
            size="small"
            label="Vimeo URL or ID"
            value={vimeoInput}
            onChange={(e) => setVimeoInput(e.target.value)}
            sx={{ flex: 1 }}
            disabled={disabled}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddVimeo();
              }
            }}
          />
          <Button variant="outlined" onClick={handleAddVimeo} disabled={disabled || !vimeoInput.trim()}>
            Add Video
          </Button>
        </Stack>
      </Stack>

      {value.length > 0 && (
        <Stack direction="row" flexWrap="wrap" gap={1}>
          {value.map((m, i) => (
            <Box
              key={(m.file_upload_id || m.vimeo_id || i) + '-' + i}
              sx={{
                position: 'relative',
                width: 100,
                height: 100,
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
                overflow: 'hidden',
                bgcolor: 'background.default'
              }}
            >
              {m._previewUrl ? (
                <Box
                  component="img"
                  src={m._previewUrl}
                  alt={m.source === 'vimeo' ? `Vimeo ${m.vimeo_id}` : 'Upload'}
                  sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <Stack alignItems="center" justifyContent="center" sx={{ width: '100%', height: '100%' }}>
                  <Typography variant="caption">{m.source === 'vimeo' ? 'Vimeo' : 'Image'}</Typography>
                </Stack>
              )}

              {m.source === 'vimeo' && (
                <Box
                  sx={{
                    position: 'absolute',
                    bottom: 4,
                    left: 4,
                    bgcolor: 'rgba(0,0,0,0.6)',
                    color: 'white',
                    px: 0.5,
                    py: 0.25,
                    borderRadius: 0.5,
                    fontSize: 11,
                    fontWeight: 600
                  }}
                >
                  VIMEO
                </Box>
              )}

              {m._warning && (
                <Tooltip title={m._warning}>
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 4,
                      left: 4,
                      bgcolor: 'warning.main',
                      color: 'warning.contrastText',
                      width: 20,
                      height: 20,
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    <WarningAmberIcon sx={{ fontSize: 14 }} />
                  </Box>
                </Tooltip>
              )}

              <IconButton
                size="small"
                onClick={() => removeAt(i)}
                disabled={disabled}
                sx={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  bgcolor: 'background.paper',
                  '&:hover': { bgcolor: 'background.paper' }
                }}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Box>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
