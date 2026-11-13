import type { ThemeTokens } from './models';

const VARS: Record<keyof Omit<ThemeTokens, 'key' | 'label'>, string> = {
  brand: '--brand',
  brandForeground: '--brand-fg',
  background: '--bg',
  surface: '--card',
  text: '--fg',
  muted: '--muted',
  line: '--line',
  radius: '--radius',
};

/** Applies a published theme. Missing tokens fall back to the stylesheet. */
export function applyTheme(theme: ThemeTokens | null): void {
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(VARS) as [keyof typeof VARS, string][]) {
    const value = theme?.[key];
    if (value) root.style.setProperty(cssVar, value);
    else root.style.removeProperty(cssVar);
  }
}
