import { DEFAULT_COLOURS, contrast, draftPairs, luminance, themePairs, type Contrast, type ThemeColours, type ThemePair } from '../builder/contrast';
import type { ThemeTokens } from '../models';

const COLOURS = ['brand', 'brandForeground', 'background', 'surface', 'text', 'muted', 'line'] as const;
const HEX = /^#[0-9A-Fa-f]{6}$/;
const RADIUS = /^[0-9]{1,2}px$/;
/** The stylesheet's corner radius, used when a theme leaves it unset. */
export const DEFAULT_RADIUS = '6px';

export const THEME_FIELDS = [...COLOURS, 'radius'] as const;
export type ThemeField = (typeof THEME_FIELDS)[number];
type ColourField = (typeof COLOURS)[number];

export const THEME_GROUPS = [
  { labelKey: 'ui.admin.theme.group.brand', fields: ['brand', 'brandForeground'] as const },
  { labelKey: 'ui.admin.theme.group.surfaces', fields: ['background', 'surface', 'line'] as const },
  { labelKey: 'ui.admin.theme.group.typography', fields: ['text', 'muted'] as const },
] as const;

/** Which token to focus when someone follows a contrast banner or Fix control. */
export const PAIR_FOCUS_FIELD: Record<string, ThemeField> = {
  brandForegroundOnBrand: 'brandForeground',
  textOnBackground: 'text',
  textOnSurface: 'text',
  mutedOnSurface: 'muted',
  brandOnSurface: 'brand',
};

const FIELD_PAIRS: Partial<Record<ColourField, readonly string[]>> = {
  brand: ['brandForegroundOnBrand'],
  brandForeground: ['brandForegroundOnBrand'],
  background: ['textOnBackground'],
  surface: ['textOnSurface', 'mutedOnSurface', 'brandOnSurface'],
  text: ['textOnBackground', 'textOnSurface'],
  muted: ['mutedOnSurface'],
};

export type ThemePalette = { id: string; labelKey: string; tokens: Record<ThemeField, string> };

export const THEME_PALETTES: ThemePalette[] = [
  {
    id: 'forest',
    labelKey: 'ui.admin.theme.palette.forest',
    tokens: {
      ...themeDraft(null),
      brand: '#0e7c66',
      brandForeground: '#ffffff',
      background: '#f4f9f6',
      text: '#12241c',
      muted: '#3d5c52',
    },
  },
];

/** The draft the form shows: published tokens, with each missing colour and the radius filled from the stylesheet. */
export function themeDraft(theme: Partial<Record<ThemeField, string>> | null | undefined): Record<ThemeField, string> {
  const next = {} as Record<ThemeField, string>;
  for (const key of COLOURS) {
    const value = theme?.[key]?.trim() ?? '';
    next[key] = value || DEFAULT_COLOURS[key];
  }
  const radius = theme?.radius?.trim() ?? '';
  next.radius = radius || DEFAULT_RADIUS;
  return next;
}

/** A `#rrggbb` for the colour control. An invalid draft keeps the stylesheet colour there instead of black. */
export function colourPicker(field: ThemeField, value: string): string {
  if (field === 'radius' || HEX.test(value)) return value;
  return DEFAULT_COLOURS[field as ColourField];
}

/** The organisation theme, with blank tokens left out so the stylesheet shows through. */
export function themeBody(tokens: Partial<Record<ThemeField, string>>): ThemeTokens {
  const out: ThemeTokens = { key: 'organisation' };
  for (const key of THEME_FIELDS) {
    const value = tokens[key]?.trim();
    if (value) out[key] = value;
  }
  return out;
}

/** Colour and radius tokens that are not in the form the theme accepts. */
export function themeIssues(body: ThemeTokens): ThemeField[] {
  const bad: ThemeField[] = [];
  for (const key of COLOURS) if (body[key] && !HEX.test(body[key])) bad.push(key);
  if (body.radius && !RADIUS.test(body.radius)) bad.push('radius');
  return bad;
}

/** Fields the form cannot publish: each colour and the radius must be present and valid. */
export function themeProblems(tokens: Partial<Record<ThemeField, string>>): ThemeField[] {
  const bad: ThemeField[] = [];
  for (const key of COLOURS) if (!HEX.test(tokens[key]?.trim() ?? '')) bad.push(key);
  if (!RADIUS.test(tokens.radius?.trim() ?? '')) bad.push('radius');
  return bad;
}

/** True when a pair is below AA, or is not a colour, so publishing asks for confirmation. */
export function themeNeedsConfirm(body: ThemeColours): boolean {
  return themePairs(body).some((pair) => !pair.contrast || pair.contrast.level === 'fail' || pair.contrast.level === 'large');
}

export function themeValuesEqual(a: Record<ThemeField, string>, b: Record<ThemeField, string>): boolean {
  return THEME_FIELDS.every((key) => a[key].trim() === b[key].trim());
}

/** Pairs that need attention while editing, in banner order. */
export function contrastAttention(pairs: ThemePair[]): ThemePair[] {
  return pairs.filter((pair) => !pair.contrast || pair.contrast.level === 'fail' || pair.contrast.level === 'large');
}

/** The strictest contrast result shown beside a colour token row. */
export function fieldContrastBadge(field: ThemeField, tokens: Record<ThemeField, string>): Contrast | null {
  if (field === 'radius' || field === 'line') return null;
  const ids = FIELD_PAIRS[field as ColourField];
  if (!ids?.length) return null;
  const byId = new Map(draftPairs(tokens).map((pair) => [pair.id, pair.contrast]));
  let worst: Contrast | null = null;
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) continue;
    if (!worst || c.ratio < worst.ratio) worst = c;
  }
  return worst;
}

function channelHex(n: number): string {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
}

function mixTowardBlack(hex: string, mix: number): string | null {
  if (!HEX.test(hex)) return null;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const scale = 1 - mix;
  return `#${channelHex(Math.round(r * scale))}${channelHex(Math.round(g * scale))}${channelHex(Math.round(b * scale))}`;
}

function mixTowardWhite(hex: string, mix: number): string | null {
  if (!HEX.test(hex)) return null;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const blend = (v: number) => Math.round(v + (255 - v) * mix);
  return `#${channelHex(blend(r))}${channelHex(blend(g))}${channelHex(blend(b))}`;
}

/** A foreground colour that reaches normal-text AA on the given background, when possible. */
export function suggestForegroundForBackground(foreground: string, background: string, minRatio = 4.5): { hex: string; ratio: number } | null {
  if (!HEX.test(foreground.trim()) || !HEX.test(background.trim())) return null;
  const towardBlack = (start: string) => {
    let candidate = start;
    for (let step = 0; step < 24; step++) {
      const c = contrast(candidate, background);
      if (c && c.ratio >= minRatio) return { hex: candidate, ratio: c.ratio };
      const next = mixTowardBlack(candidate, 0.08);
      if (!next || next === candidate) return null;
      candidate = next;
    }
    return null;
  };
  const towardWhite = (start: string) => {
    let candidate = start;
    for (let step = 0; step < 24; step++) {
      const c = contrast(candidate, background);
      if (c && c.ratio >= minRatio) return { hex: candidate, ratio: c.ratio };
      const next = mixTowardWhite(candidate, 0.08);
      if (!next || next === candidate) return null;
      candidate = next;
    }
    return null;
  };
  const start = foreground.trim();
  const bg = luminance(background);
  const preferDarken = bg === null || bg > 0.45;
  return (preferDarken ? towardBlack(start) : towardWhite(start)) ?? (preferDarken ? towardWhite(start) : towardBlack(start));
}

export type ThemeSuggestion = { pairId: string; field: ThemeField; hex: string; ratio: number };

/** A suggested token value when a contrast pair is below AA for body text. */
export function suggestForPair(pair: ThemePair): ThemeSuggestion | null {
  if (!pair.contrast || (pair.contrast.level !== 'fail' && pair.contrast.level !== 'large')) return null;
  const field = PAIR_FOCUS_FIELD[pair.id];
  if (!field) return null;
  const fix = suggestForegroundForBackground(pair.foreground, pair.background);
  if (!fix) return null;
  return { pairId: pair.id, field, hex: fix.hex, ratio: fix.ratio };
}

/** The first fix for a token field that still fails a contrast check. */
export function suggestForField(field: ThemeField, tokens: Record<ThemeField, string>): ThemeSuggestion | null {
  const ids = FIELD_PAIRS[field as ColourField];
  if (!ids?.length) return null;
  for (const pair of draftPairs(tokens)) {
    if (!ids.includes(pair.id)) continue;
    const fix = suggestForPair(pair);
    if (fix) return fix;
  }
  return null;
}
