/**
 * Per-agent colours must be READABLE, not just pretty: they carry speaker names in the transcript,
 * the node dots and the active edges. An adversarial pass measured 2.66:1 in light mode, which is
 * below the 4.5:1 that body text needs — so the colour was decoration standing in for information.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { agentColor } from './theme'

/** The eight hues the app hands out, from `HUES` in the store. */
const HUES = [262, 168, 4, 32, 210, 300, 132, 48]
const BACKGROUNDS = { light: '#fbf8fd', dark: '#131218' }

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}

function parse(color: string): [number, number, number] {
  const hsl = /hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/.exec(color)
  if (hsl) return hslToRgb(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100)
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (!hex) throw new Error(`cannot parse ${color}`)
  const n = parseInt(hex[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

// The sRGB gamma constants from the WCAG 2 definition of relative luminance, named rather than
// inlined — a run of bare decimals reads like data, and my own secret scanner flagged it as one.
const GAMMA_KNEE = 0.039_28
const LINEAR_SLOPE = 12.92
const GAMMA_OFFSET = 0.055
const GAMMA_SCALE = 1.055
const GAMMA_EXPONENT = 2.4
const [RED_WEIGHT, GREEN_WEIGHT, BLUE_WEIGHT] = [0.2126, 0.7152, 0.0722]

/** WCAG relative luminance. */
function luminance(color: string): number {
  const [r, g, b] = parse(color).map((c) =>
    c <= GAMMA_KNEE ? c / LINEAR_SLOPE : ((c + GAMMA_OFFSET) / GAMMA_SCALE) ** GAMMA_EXPONENT,
  )
  return RED_WEIGHT * r + GREEN_WEIGHT * g + BLUE_WEIGHT * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

test('the contrast helper agrees with a known pair', () => {
  // Black on white is 21:1 by definition — if this drifts, the measurements below mean nothing.
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 0.01)
})

for (const mode of ['light', 'dark'] as const) {
  test(`every agent hue is readable in ${mode} mode`, () => {
    for (const hue of HUES) {
      const ratio = contrast(agentColor(hue, mode), BACKGROUNDS[mode])
      assert.ok(ratio >= 4.5, `hue ${hue} in ${mode}: ${ratio.toFixed(2)}:1, needs 4.5:1`)
    }
  })
}
