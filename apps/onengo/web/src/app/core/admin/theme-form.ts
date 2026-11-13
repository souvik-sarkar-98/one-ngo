import { DEFAULT_COLOURS, themePairs, type ThemeColours } from '../builder/contrast';
import type { ThemeTokens } from '../models';

const COLOURS = ['brand', 'brandForeground', 'background', 'surface', 'text', 'muted', 'line'] as const;
const HEX = /^#[0-9A-Fa-f]{6}$/;
const RADIUS = /^[0-9]{1,2}px$/;
/** The stylesheet's corner radius, used when a theme leaves it unset. */
export const DEFAULT_RADIUS = '6px';

export const THEME_FIELDS = [...COLOURS, 'radius'] as const;
export type ThemeField = (typeof THEME_FIELDS)[number];
type ColourField = (typeof COLOURS)[number];

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
