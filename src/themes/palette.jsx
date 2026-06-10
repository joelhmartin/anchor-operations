// project imports
import { extendPaletteWithChannels } from 'utils/colorUtils';

// assets
import defaultColor from 'assets/scss/_themes-vars.module.scss';

// ==============================|| DEFAULT THEME - PALETTE ||============================== //

export function buildPalette(presetColor) {
  let colors;
  switch (presetColor) {
    case 'default':
    default:
      colors = defaultColor;
  }

  const lightColors = {
    primary: {
      light: colors.primaryLight,
      main: colors.primaryMain,
      dark: colors.primaryDark,
      200: colors.primary200,
      800: colors.primary800
    },
    secondary: {
      light: colors.secondaryLight,
      main: colors.secondaryMain,
      dark: colors.secondaryDark,
      200: colors.secondary200,
      800: colors.secondary800
    },
    error: {
      light: colors.errorLight,
      main: colors.errorMain,
      dark: colors.errorDark
    },
    orange: {
      light: colors.orangeLight,
      main: colors.orangeMain,
      dark: colors.orangeDark
    },
    warning: {
      light: colors.warningLight,
      main: colors.warningMain,
      dark: colors.warningDark,
      contrastText: colors.grey700
    },
    success: {
      light: colors.successLight,
      200: colors.success200,
      main: colors.successMain,
      dark: colors.successDark
    },
    grey: {
      50: colors.grey50,
      100: colors.grey100,
      500: colors.grey500,
      600: colors.grey600,
      700: colors.grey700,
      900: colors.grey900
    },
    dark: {
      light: colors.darkTextPrimary,
      main: colors.darkLevel1,
      dark: colors.darkLevel2,
      800: colors.darkBackground,
      900: colors.darkPaper
    },
    text: {
      primary: colors.grey700,
      secondary: colors.grey500,
      dark: colors.grey900,
      hint: colors.grey100,
      heading: colors.grey900
    },
    divider: colors.grey200,
    background: {
      paper: colors.paper,
      default: colors.paper
    }
  };

  // Dark-mode palette: dark navy blues, not black. Greys are an inverted cool-blue
  // ramp: grey.50/100/200 become subtle elevations above the navy paper so existing
  // `bgcolor: 'grey.50'` panels still read as faint contrast, while grey.700/900
  // become near-white with a slight blue tint for emphasis text.
  const DARK_BG = '#0f1a2d';
  const DARK_PAPER = '#172238';

  const darkGrey = {
    50: '#1f2d46',
    100: '#273855',
    200: '#33466a',
    300: '#4a5f86',
    500: '#8a9cbc',
    600: '#a9b9d3',
    700: '#d0dbeb',
    900: '#f3f6fc'
  };

  const darkColors = {
    primary: {
      light: colors.darkPrimaryLight,
      main: colors.darkPrimaryMain,
      dark: colors.darkPrimaryDark,
      200: colors.darkPrimary200,
      800: colors.darkPrimary800,
      contrastText: '#ffffff'
    },
    secondary: {
      light: colors.darkSecondaryLight,
      main: colors.darkPrimaryMain,
      dark: colors.darkSecondaryDark,
      200: colors.darkSecondary200,
      800: colors.darkSecondary800,
      contrastText: '#ffffff'
    },
    error: {
      light: colors.errorLight,
      main: colors.errorMain,
      dark: colors.errorDark,
      contrastText: '#ffffff'
    },
    orange: {
      light: colors.orangeLight,
      main: colors.orangeMain,
      dark: colors.orangeDark
    },
    warning: {
      light: colors.warningLight,
      main: colors.warningMain,
      dark: colors.warningDark,
      // warningMain is pale yellow in both modes, so contrast text stays dark.
      contrastText: colors.grey700
    },
    success: {
      light: colors.successLight,
      200: colors.success200,
      main: colors.successMain,
      dark: colors.successDark,
      contrastText: '#ffffff'
    },
    grey: darkGrey,
    dark: {
      light: darkGrey[700],
      main: darkGrey[50],
      dark: DARK_PAPER,
      800: DARK_BG,
      900: DARK_PAPER
    },
    text: {
      primary: '#ffffff',
      secondary: darkGrey[700],
      dark: '#ffffff',
      hint: 'rgba(169, 185, 211, 0.18)',
      heading: '#ffffff'
    },
    divider: 'rgba(169, 185, 211, 0.16)',
    background: {
      paper: DARK_PAPER,
      default: DARK_BG
    },
    action: {
      hover: 'rgba(169, 185, 211, 0.08)',
      selected: 'rgba(169, 185, 211, 0.14)'
    }
  };

  const commonColor = { common: { black: colors.darkPaper, white: '#fff' } };

  const extendedLight = extendPaletteWithChannels(lightColors);
  const extendedDark = extendPaletteWithChannels(darkColors);
  const extendedCommon = extendPaletteWithChannels(commonColor);

  return {
    light: {
      mode: 'light',
      ...extendedCommon,
      ...extendedLight
    },
    dark: {
      mode: 'dark',
      ...extendedCommon,
      ...extendedDark
    }
  };
}
