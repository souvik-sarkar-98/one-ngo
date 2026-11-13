import { applyTheme } from '../core/theme';
import type { ThemeTokens } from '../core/models';

/**
 * Paints an organisation's published colours on a public page, the same way the sign-in page does.
 * Null restores the stylesheet defaults. Every public screen clears them when it leaves.
 */
export function paintPublic(theme: Partial<ThemeTokens> | null | undefined): void {
  applyTheme(theme ? { key: 'organisation', ...theme } : null);
}

/**
 * Look shared by the public screens. Colours, radii and fonts come only from the theme tokens in
 * styles.css, so an organisation's theme changes these pages the same way it changes the app.
 */
export const PUBLIC_STYLES = `
  :host { display: block; min-height: 100vh; background: var(--bg); color: var(--fg); font-family: var(--font); }
  .pub__band { background: var(--brand); color: var(--brand-fg); }
  .pub__band-in { max-width: 760px; margin: 0 auto; padding: 16px; }
  .pub__org { margin: 0; font-size: .78rem; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; opacity: .92; }
  .pub__main { max-width: 760px; margin: 0 auto; padding: 20px 16px 48px; }
  .pub__card { background: var(--card); border: 1px solid var(--card-border); border-radius: var(--card-radius); box-shadow: var(--panel-shadow); padding: 22px; }
  .pub__title { margin: 0 0 6px; font-size: var(--title-size); line-height: 1.3; color: var(--fg); }
  .pub__lede { margin: 0 0 16px; color: var(--muted); line-height: 1.5; }
  .pub__meta { margin: 0 0 14px; color: var(--muted); font-size: .82rem; }
  .pub__state { color: var(--muted); }
  .pub__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .pub__search { display: flex; gap: 8px; margin-bottom: 16px; }
  .pub__search input { flex: 1; min-width: 0; }
  .pub__ref { margin-bottom: 14px; }
  .pub__hits { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 6px; }
  .pub__hits .app-btn { display: block; width: 100%; text-align: start; }
  .pub__rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .pub__row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--card-radius); box-shadow: var(--card-shadow); }
  .pub__fields { min-width: 0; font-size: .88rem; }
  .pub__field { margin: 0 0 4px; overflow-wrap: anywhere; }
  .pub__field:last-child { margin-bottom: 0; }
  .pub__field-label { color: var(--muted); margin-inline-end: 4px; }
  .pub__dl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); margin: 0; }
  .pub__dl dt, .pub__dl dd { margin: 0; padding: 10px 0; border-bottom: 1px solid var(--divider); font-size: .88rem; }
  .pub__dl dt { color: var(--muted); font-weight: 600; padding-inline-end: 12px; }
  .pub__dl dd { color: var(--fg); overflow-wrap: anywhere; }
  .pub__foot { margin: 16px 0 0; color: var(--muted); font-size: .78rem; line-height: 1.5; }
  .pub__link { overflow-wrap: anywhere; font-weight: 600; color: var(--brand); }
  :host a:focus-visible, :host .app-btn:focus-visible { outline: var(--focus-ring); outline-offset: 2px; }
  @media (max-width: 560px) {
    .pub__card { padding: 16px; }
    .pub__search { flex-direction: column; }
    .pub__row { flex-direction: column; align-items: stretch; }
    .pub__dl { grid-template-columns: minmax(0, 1fr); }
    .pub__dl dt { padding-bottom: 0; border-bottom: 0; }
    .pub__dl dd { padding-top: 2px; }
  }
`;
