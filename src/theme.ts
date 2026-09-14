import { createTheme, type Theme } from '@mui/material/styles'

/**
 * Material 3-flavoured theme: one accent, soft surfaces, generous radii, no chrome.
 * Both modes are first-class — the graph is read as often at night as in daylight.
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
        default: dark ? '#131218' : '#fbf8fd',
        paper: dark ? '#1c1b22' : '#ffffff',
      },
      divider: dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.09)',
    },
    shape: { borderRadius: 14 },
    typography: {
      fontFamily: '"Roboto", system-ui, sans-serif',
      h6: { fontWeight: 500, letterSpacing: 0.1 },
      subtitle2: { fontWeight: 500, letterSpacing: 0.2 },
      button: { textTransform: 'none', fontWeight: 500, letterSpacing: 0.1 },
      caption: { letterSpacing: 0.3 },
    },
    components: {
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiTooltip: { defaultProps: { arrow: true } },
      MuiTextField: { defaultProps: { size: 'small' } },
      MuiSelect: { defaultProps: { size: 'small' } },
      MuiChip: { styleOverrides: { root: { fontWeight: 500 } } },
    },
  })
}

/** Per-agent colour, derived from its hue so node, edge and transcript always agree. */
export function agentColor(hue: number, mode: 'light' | 'dark'): string {
  return mode === 'dark' ? `hsl(${hue} 72% 72%)` : `hsl(${hue} 58% 44%)`
}

export function agentGlow(hue: number, alpha: number): string {
  return `hsl(${hue} 80% 62% / ${alpha})`
}
