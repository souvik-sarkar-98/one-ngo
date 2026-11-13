import type { SignInTheme } from './organisation-service.js';

const BRAND = '#1f5f8b';
const BACKGROUND = '#f5f7fa';

/** The shared heart, used when the organisation has no logo the browser can install. */
const DEFAULT_ICONS = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  { src: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
];

/** Image types an organisation may store as its logo. */
const ICON_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
// Changes whenever the generated icon format changes, forcing Chromium to
// discard a previously generated fallback monogram for the same logo version.
const INSTALL_ICON_REVISION = 2;

/** What the install page knows about an organisation. Private profile fields stay out. */
export interface InstallManifestInput {
  code: string;
  displayName: string;
  theme: SignInTheme | null;
  /** The public logo, or null when the organisation has none. */
  logoUrl?: string | null;
  /** The stored image type. A type this app does not serve is ignored. */
  logoMime?: string | null;
}

/** A colour the browser can use, or the default when the stored token is blank or unsafe. */
function colour(value: string | undefined, fallback: string): string {
  const text = value?.trim() ?? '';
  if (!text || text.length > 32 || /[;"'<>]/.test(text)) return fallback;
  return text;
}

/** Home-screen labels are short. A long name falls back to the organisation code, then to a cut name. */
function shortName(name: string, code: string): string {
  if (name.length <= 12) return name;
  if (code.length <= 12) return code;
  return name.slice(0, 12);
}

const LOGO = /^\/api\/auth\/organisations\/([a-z0-9][a-z0-9-]{0,39})\/logo\?v=(\d+)$/;

/**
 * Square icons made from the logo. Chrome's install dialog ignores a wide
 * image and draws a letter instead, so the logo is fitted into a square PNG.
 */
function icons(logoUrl: string | null | undefined, logoMime: string | null | undefined): Record<string, string>[] {
  const match = LOGO.exec(logoUrl?.trim() ?? '');
  const type = logoMime?.trim().toLowerCase() ?? '';
  if (!match || !ICON_TYPES.has(type)) return DEFAULT_ICONS;
  const src = (size: number) => `/api/auth/organisations/${match[1]}/icon/${size}?v=${match[2]}&i=${INSTALL_ICON_REVISION}`;
  return [
    { src: src(192), sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: src(512), sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: src(512), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: src(180), sizes: '180x180', type: 'image/png' },
  ];
}

/**
 * The web app manifest for one organisation. `id` keeps each organisation a
 * separate installed app. `start_url` opens that organisation's sign-in page.
 * `scope` stays the whole site so the signed-in app remains in the same window.
 * Icon and start addresses are root-absolute because this document is served
 * from the API, not from the site root. The intended home-screen icon is the
 * organisation logo, or the shared heart when it has none. Windows Chrome
 * still installs a letter; that is a known bug (docs/design/ngo-app-ui-design.md).
 */
export function organisationManifest(org: InstallManifestInput): Record<string, unknown> {
  const name = org.displayName.trim() || org.code;
  return {
    name,
    short_name: shortName(name, org.code),
    id: `/o/${org.code}/`,
    start_url: `/o/${org.code}/sign-in`,
    scope: '/',
    display: 'standalone',
    theme_color: colour(org.theme?.brand, BRAND),
    background_color: colour(org.theme?.background, BACKGROUND),
    icons: icons(org.logoUrl, org.logoMime),
  };
}
