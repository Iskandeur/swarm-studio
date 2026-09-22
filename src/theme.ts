import { createTheme, type Theme } from '@mui/material/styles'

/**
 * Material 3-flavoured theme: one accent, soft surfaces, one radius scale, no chrome.
 * Both modes are first-class — the graph is read as often at night as in daylight.
 *
 * The palette is deliberately short: primary carries every action, `text.secondary` carries every
 * hint, and the agents' own hues (see `agentColor`) are the only other colours on the screen.
 */
export function buildTheme(mode: 'light' | 'dark'): Theme {
  const dark = mode === 'dark'
  return createTheme({
    palette: {
      mode,
      primary: { main: dark ? '#cfbcff' : '#6750a4' },
      secondary: { main: dark ? '#7fd1c1' : '#00695f' },
      error: { main: dark ? '#f2b8b5' : '#b3261e' },
      background: {
        default: dark ? '#131218' : '#f6f3fa',
        paper: dark ? '#1c1b22' : '#ffffff',
      },
      text: {
        primary: dark ? '#e6e1e9' : '#1d1b20',
        secondary: dark ? 'rgba(230,225,233,0.62)' : 'rgba(29,27,32,0.62)',
      },
      divider: dark ? 'rgba(255,255,255,0.10)' : 'rgba(29,27,32,0.10)',
    },
    shape: { borderRadius: 12 },
    spacing: 8,
    typography: {
      fontFamily: '"Roboto", system-ui, sans-serif',
      h5: { fontWeight: 600, letterSpacing: -0.2 },
      h6: { fontWeight: 500, letterSpacing: 0.1 },
      subtitle1: { fontWeight: 500 },
      subtitle2: { fontWeight: 500, letterSpacing: 0.2 },
      overline: { fontWeight: 600, letterSpacing: 0.8, fontSize: 11 },
      button: { textTransform: 'none', fontWeight: 500, letterSpacing: 0.1 },
      caption: { letterSpacing: 0.2 },
    },
    components: {
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: { root: { borderRadius: 999 }, sizeLarge: { paddingTop: 10, paddingBottom: 10 } },
      },
      MuiToggleButtonGroup: { styleOverrides: { root: { borderRadius: 999 } } },
      MuiToggleButton: { styleOverrides: { root: { borderRadius: 999, textTransform: 'none' } } },
      MuiTooltip: { defaultProps: { arrow: true } },
      MuiTextField: { defaultProps: { size: 'small' } },
      MuiSelect: { defaultProps: { size: 'small' } },
      MuiOutlinedInput: { styleOverrides: { root: { borderRadius: 10 } } },
      MuiChip: { styleOverrides: { root: { fontWeight: 500 } } },
      MuiMenu: { styleOverrides: { paper: { borderRadius: 12 } } },
      MuiPopover: { styleOverrides: { paper: { borderRadius: 16 } } },
      MuiDialog: { styleOverrides: { paper: { borderRadius: 20 } } },
      MuiAlert: { styleOverrides: { root: { borderRadius: 12 } } },
    },
  })
}

/**
 * Per-agent colour, derived from its hue so node, edge and transcript always agree.
 *
 * ⚠️ The lightness is not a taste decision. These colours carry the speaker's name in the
 * transcript, so they are text, so they owe 4.5:1 against the background. Light mode was at
 * 44% lightness and measured **2.53:1** on the green hue — decoration standing in for information.
 * `src/theme.test.ts` measures all eight hues in both modes; do not raise these without re-running it.
 */
export function agentColor(hue: number, mode: 'light' | 'dark'): string {
  return mode === 'dark' ? `hsl(${hue} 72% 72%)` : `hsl(${hue} 70% 29%)`
}

export function agentGlow(hue: number, alpha: number): string {
  return `hsl(${hue} 80% 62% / ${alpha})`
}
