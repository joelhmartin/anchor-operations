import { Box, Button, Typography } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { BRAND_COLORS } from 'constants/brandColors';

const CTA_LABELS = {
  LEARN_MORE: 'Learn More',
  SIGN_UP: 'Sign Up',
  SHOP_NOW: 'Shop Now',
  BOOK_NOW: 'Book Now',
  CONTACT_US: 'Contact Us',
  GET_OFFER: 'Get Offer',
  GET_QUOTE: 'Get Quote',
  SUBSCRIBE: 'Subscribe',
  SEND_MESSAGE: 'Send Message',
  CALL_NOW: 'Call Now',
  APPLY_NOW: 'Apply Now',
  DOWNLOAD: 'Download',
  WATCH_MORE: 'Watch More',
  NO_BUTTON: null
};

function formatCTA(raw) {
  if (!raw) return null;
  return CTA_LABELS[raw] || raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Facebook feed-style post card.
 *
 * Used as the inline preview in the Social compose dialog AND as the
 * inner card of `MetaAdPreviewDialog` (which keeps the Sponsored framing
 * for paid creative).
 *
 * Props:
 *   creative: { imageUrl?, thumbnailUrl?, headline?, body?, callToAction?, isVideo?, linkUrl? }
 *   pageName?       — Page name in the header (default "Facebook Ad" for ads, but pass for organic)
 *   pageAvatarUrl?  — round image url; falls back to the white "f" on FB blue
 *   subtitle?       — small text under the page name (default "Sponsored")
 *   videoSrc?       — resolved playable video URL; when present on a video
 *                     creative, renders an inline <video> player instead of the
 *                     static poster + play badge
 */
export default function FacebookPostPreview({ creative, pageName, pageAvatarUrl, subtitle, videoSrc }) {
  if (!creative) return null;

  const { imageUrl, thumbnailUrl, headline, body, callToAction, isVideo, linkUrl } = creative;
  const imgSrc = imageUrl || thumbnailUrl;
  const ctaLabel = formatCTA(callToAction);
  const headerName = pageName || 'Facebook Ad';
  const headerSubtitle = subtitle || 'Sponsored';

  return (
    <Box sx={{ bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', borderRadius: 1.5, overflow: 'hidden', maxWidth: 480 }}>
      <Box sx={{ px: 2, pt: 2, pb: 1, display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Box
          sx={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            overflow: 'hidden',
            bgcolor: pageAvatarUrl ? 'grey.200' : BRAND_COLORS.facebook,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0
          }}
        >
          {pageAvatarUrl ? (
            <Box component="img" src={pageAvatarUrl} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <Typography sx={{ color: 'white', fontWeight: 700, fontSize: 18 }}>f</Typography>
          )}
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" fontWeight={600} sx={{ lineHeight: 1.3 }} noWrap>
            {headerName}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {headerSubtitle}
          </Typography>
        </Box>
      </Box>

      {body && (
        <Box sx={{ px: 2, pb: 1.5 }}>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
            {body}
          </Typography>
        </Box>
      )}

      {isVideo && videoSrc ? (
        <Box
          component="video"
          src={videoSrc}
          poster={imgSrc || undefined}
          controls
          playsInline
          sx={{ width: '100%', display: 'block', bgcolor: 'black', maxHeight: 520 }}
        />
      ) : (
        imgSrc && (
          <Box sx={{ position: 'relative' }}>
            <Box component="img" src={imgSrc} alt={headline || 'Post image'} sx={{ width: '100%', display: 'block' }} />
            {isVideo && (
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'rgba(0,0,0,0.25)'
                }}
              >
                <PlayArrowIcon sx={{ color: 'white', fontSize: 64 }} />
              </Box>
            )}
          </Box>
        )
      )}

      {(headline || ctaLabel || linkUrl) && (
        <Box
          sx={{
            px: 2,
            py: 1.5,
            bgcolor: 'grey.50',
            borderTop: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            {linkUrl && (
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {(() => {
                  try {
                    return new URL(linkUrl).hostname;
                  } catch {
                    return '';
                  }
                })()}
              </Typography>
            )}
            {headline && (
              <Typography variant="subtitle2" fontWeight={600} sx={{ lineHeight: 1.3 }} noWrap>
                {headline}
              </Typography>
            )}
          </Box>
          {ctaLabel && (
            <Button
              size="small"
              variant="contained"
              disableElevation
              sx={{
                textTransform: 'none',
                bgcolor: '#e4e6eb',
                color: '#050505',
                fontWeight: 600,
                fontSize: '0.8125rem',
                px: 2,
                flexShrink: 0,
                '&:hover': { bgcolor: '#d8dadf' }
              }}
            >
              {ctaLabel}
            </Button>
          )}
        </Box>
      )}

      <Box
        sx={{
          px: 2,
          py: 1,
          borderTop: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          justifyContent: 'space-around'
        }}
      >
        {['Like', 'Comment', 'Share'].map((action) => (
          <Typography key={action} variant="caption" color="text.secondary" fontWeight={600} sx={{ py: 0.5 }}>
            {action}
          </Typography>
        ))}
      </Box>
    </Box>
  );
}
