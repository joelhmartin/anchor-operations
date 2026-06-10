import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';

/**
 * LoadingButton — MUI Button with built-in loading state.
 *
 * When `loading` is true the button is disabled, shows a CircularProgress
 * spinner (replacing the startIcon if one was provided), and optionally
 * swaps the label to `loadingLabel`.
 *
 * @param {boolean}      loading        – Whether the button is in a loading state
 * @param {string}       [loadingLabel] – Text to show while loading (defaults to `children`)
 * @param {ReactElement} [startIcon]    – Icon shown before the label (replaced by spinner when loading)
 * @param {object}       rest           – All other MUI Button props forwarded through
 */
export default function LoadingButton({
  loading = false,
  loadingLabel,
  children,
  startIcon,
  disabled,
  ...rest
}) {
  const spinnerSize = rest.size === 'small' ? 14 : 16;

  return (
    <Button
      disabled={disabled || loading}
      startIcon={
        loading
          ? <CircularProgress size={spinnerSize} color="inherit" />
          : startIcon
      }
      {...rest}
    >
      {loading ? (loadingLabel || children) : children}
    </Button>
  );
}
