// Responsive font sizes use clamp(min, preferred, max) so text scales
// smoothly between small and large viewports without media-query
// breakpoints. Pattern: min = current size (preserves mobile layout),
// preferred = <base> + <vw component> so text grows with the viewport,
// max = a modest cap so large monitors get a bit more breathing room.
//
// Avatar sizes intentionally stay static — they're fixed square
// containers and a responsive font size would misalign their centers.

export default function Typography(fontFamily) {
  return {
    fontFamily,
    h6: {
      fontWeight: 500,
      fontSize: 'clamp(0.75rem, 0.6875rem + 0.3vw, 0.875rem)'
    },
    h5: {
      fontSize: 'clamp(0.875rem, 0.8125rem + 0.3vw, 1rem)',
      fontWeight: 500
    },
    h4: {
      fontSize: 'clamp(1rem, 0.9375rem + 0.3vw, 1.125rem)',
      fontWeight: 600
    },
    h3: {
      fontSize: 'clamp(1.25rem, 1.0625rem + 0.6vw, 1.5rem)',
      fontWeight: 600
    },
    h2: {
      fontSize: 'clamp(1.5rem, 1.25rem + 0.85vw, 1.875rem)',
      fontWeight: 700
    },
    h1: {
      fontSize: 'clamp(2.125rem, 1.75rem + 1.25vw, 2.625rem)',
      fontWeight: 700
    },
    subtitle1: {
      fontSize: 'clamp(0.875rem, 0.8125rem + 0.3vw, 1rem)',
      fontWeight: 500
    },
    subtitle2: {
      fontSize: 'clamp(0.75rem, 0.6875rem + 0.25vw, 0.875rem)',
      fontWeight: 400
    },
    caption: {
      fontSize: 'clamp(0.75rem, 0.6875rem + 0.25vw, 0.875rem)',
      fontWeight: 400
    },
    body1: {
      fontSize: 'clamp(0.875rem, 0.8125rem + 0.3vw, 1rem)',
      fontWeight: 400,
      lineHeight: '1.334em'
    },
    body2: {
      letterSpacing: '0em',
      fontWeight: 400,
      lineHeight: '1.5em'
    },
    button: {
      textTransform: 'capitalize'
    },
    commonAvatar: {
      cursor: 'pointer',
      borderRadius: '8px'
    },
    smallAvatar: {
      width: '22px',
      height: '22px',
      fontSize: '1rem'
    },
    mediumAvatar: {
      width: '34px',
      height: '34px',
      fontSize: '1.2rem'
    },
    largeAvatar: {
      width: '44px',
      height: '44px',
      fontSize: '1.5rem'
    }
  };
}
