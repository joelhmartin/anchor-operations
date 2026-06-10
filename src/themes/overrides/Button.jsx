// ==============================|| OVERRIDES - BUTTON ||============================== //

export default function Button() {
  return {
    MuiButton: {
      styleOverrides: {
        root: {
          // Base shared styling for all buttons
          textTransform: 'none',
          fontWeight: 600,
          borderRadius: 10,
          whiteSpace: 'nowrap'
        }
      }
    }
  };
}
