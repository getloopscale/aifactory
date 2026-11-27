import { defineTheme } from '@getloopscale/loopzero-ui'

/**
 * The LoopScale brand as the panel's theme: ink and paper in place of pure black and white, one brand colour
 * (a muted lime), and Hanken Grotesk with JetBrains Mono. The two fonts are served by the panel itself from
 * `public/fonts` (`globals.css` declares them), so the theme names no remote stylesheet.
 *
 * The lime on paper has no contrast as a mark or as text, so in light mode `primary` is the brand's dark
 * lime (`lime-text`), which reads as a dot, a bar and a filled button alike. Every status colour is the
 * brand's own for that mode.
 */
const INK = '#111415'
const BONE = '#E7E6E0'
const PAPER = '#FBFAF7'
const INK_ON_PAPER = '#16191A'

export const loopscale = defineTheme({
  name: 'loopscale',
  label: 'LoopScale',
  description: 'Ink, paper and one lime.',
  fonts: {
    display: '"Hanken Grotesk", ui-sans-serif, system-ui, "Segoe UI", sans-serif',
    body: '"Hanken Grotesk", ui-sans-serif, system-ui, "Segoe UI", sans-serif',
    mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
  },
  dark: {
    background: INK,
    foreground: BONE,
    card: '#181C1D',
    'card-foreground': BONE,
    popover: '#1D2223',
    'popover-foreground': BONE,
    primary: '#C4E34F',
    'primary-foreground': INK,
    secondary: '#232829',
    'secondary-foreground': BONE,
    accent: '#2A3032',
    'accent-foreground': BONE,
    muted: '#1F2425',
    'muted-foreground': '#9BA29F',
    border: '#2A3032',
    input: '#2A3032',
    ring: '#C4E34F',
    success: '#5DB98A',
    'success-foreground': INK,
    warning: '#E6C84F',
    'warning-foreground': INK,
    destructive: '#E8705F',
    'destructive-foreground': INK,
    info: '#7FA8D9',
    'info-foreground': INK,
  },
  light: {
    background: '#F4F3EF',
    foreground: INK_ON_PAPER,
    card: PAPER,
    'card-foreground': INK_ON_PAPER,
    popover: PAPER,
    'popover-foreground': INK_ON_PAPER,
    primary: '#556B00',
    'primary-foreground': PAPER,
    secondary: '#E9E7E0',
    'secondary-foreground': INK_ON_PAPER,
    accent: '#E3E1D9',
    'accent-foreground': INK_ON_PAPER,
    muted: '#ECEAE4',
    'muted-foreground': '#5A615F',
    border: '#DCDAD3',
    input: '#DCDAD3',
    ring: '#556B00',
    success: '#1F7A4F',
    'success-foreground': PAPER,
    warning: '#7A6200',
    'warning-foreground': PAPER,
    destructive: '#B3372A',
    'destructive-foreground': PAPER,
    info: '#2C5E99',
    'info-foreground': PAPER,
  },
  radius: { sm: '4px', md: '7px', lg: '10px', xl: '12px', DEFAULT: '7px' },
})

/** The themes the panel offers: only its own. */
export const THEMES = [loopscale]
