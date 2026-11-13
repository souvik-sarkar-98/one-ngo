/** WCAG 2 contrast levels for normal text: AAA from 7, AA from 4.5, large text only from 3. */
export type ContrastLevel = 'AAA' | 'AA' | 'large' | 'fail';

export interface Contrast {
  ratio: number;
  level: ContrastLevel;
}

const HEX = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i;

function channels(hex: string): [number, number, number] | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** Relative luminance of a `#rrggbb` or `#rgb` colour, or null when it is not one. */
export function luminance(hex: string): number | null {
  const c = channels(hex);
  if (!c) return null;
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two colours, from 1 to 21, rounded down to one decimal so a pass is never overstated. */
export function contrast(foreground: string, background: string): Contrast | null {
  const a = luminance(foreground);
  const b = luminance(background);
  if (a === null || b === null) return null;
  const exact = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const ratio = Math.floor(exact * 10) / 10;
  return { ratio, level: exact >= 7 ? 'AAA' : exact >= 4.5 ? 'AA' : exact >= 3 ? 'large' : 'fail' };
}

export type ThemeColours = Partial<Record<'brand' | 'brandForeground' | 'background' | 'surface' | 'text' | 'muted' | 'line', unknown>>;

/** The stylesheet's colours, used for any token a theme leaves out. */
export const DEFAULT_COLOURS = {
  brand: '#1f5f8b',
  brandForeground: '#ffffff',
  background: '#f5f7fa',
  surface: '#ffffff',
  text: '#1d2733',
  muted: '#5b6878',
  line: '#d8dee6',
} as const;

export interface ThemePair {
  /** `<foreground>On<Background>`, e.g. `brandForegroundOnBrand`. */
  id: string;
  foreground: string;
  background: string;
  contrast: Contrast | null;
}

const PAIRS = [
  ['brandForeground', 'brand'],
  ['text', 'background'],
  ['text', 'surface'],
  ['muted', 'surface'],
  ['brand', 'surface'],
] as const;

function pair(theme: ThemeColours, colour: (key: keyof typeof DEFAULT_COLOURS) => string): ThemePair[] {
  return PAIRS.map(([fg, bg]) => ({
    id: `${fg}On${bg[0]!.toUpperCase()}${bg.slice(1)}`,
    foreground: colour(fg),
    background: colour(bg),
    contrast: contrast(colour(fg), colour(bg)),
  }));
}

/** The text-on-colour pairs the app draws, with the theme's colours or the defaults. */
export function themePairs(theme: ThemeColours): ThemePair[] {
  const colour = (k: keyof typeof DEFAULT_COLOURS) => (typeof theme[k] === 'string' && theme[k] ? (theme[k] as string) : DEFAULT_COLOURS[k]);
  return pair(theme, colour);
}

/** The same pairs from the draft alone. A blank or invalid colour is left as written, so contrast is not filled in from the stylesheet. */
export function draftPairs(theme: ThemeColours): ThemePair[] {
  const colour = (k: keyof typeof DEFAULT_COLOURS) => (typeof theme[k] === 'string' ? (theme[k] as string) : '');
  return pair(theme, colour);
}
