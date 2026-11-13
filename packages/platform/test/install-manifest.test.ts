import { describe, expect, it } from 'vitest';
import { organisationManifest } from '../src/application/organisations/install-manifest.js';
import { signInTheme } from '../src/application/organisations/organisation-service.js';

describe('organisation install manifest', () => {
  it('opens the organisation sign-in page and keeps each organisation a separate app', () => {
    const manifest = organisationManifest({
      code: 'asha',
      displayName: 'Asha Trust',
      theme: { brand: '#112233', background: '#fafafa' },
    });
    expect(manifest).toMatchObject({
      name: 'Asha Trust',
      short_name: 'Asha Trust',
      id: '/o/asha/',
      start_url: '/o/asha/sign-in',
      scope: '/',
      theme_color: '#112233',
      background_color: '#fafafa',
    });
    const icons = manifest['icons'] as { src: string }[];
    expect(icons.every((icon) => icon.src.startsWith('/icons/'))).toBe(true);
  });

  it('uses the organisation logo as the home-screen icon', () => {
    const logoUrl = '/api/auth/organisations/asha/logo?v=3';
    const manifest = organisationManifest({
      code: 'asha',
      displayName: 'Asha Trust',
      theme: null,
      logoUrl,
      logoMime: 'image/png',
    });
    const icons = manifest['icons'] as { src: string; type: string; purpose?: string }[];
    expect(icons.map((icon) => icon.src)).toEqual([
      '/api/auth/organisations/asha/icon/192?v=3&i=2',
      '/api/auth/organisations/asha/icon/512?v=3&i=2',
      '/api/auth/organisations/asha/icon/512?v=3&i=2',
      '/api/auth/organisations/asha/icon/180?v=3&i=2',
    ]);
    expect(icons.map((icon) => icon.type)).toEqual(['image/png', 'image/png', 'image/png', 'image/png']);
    expect(icons.map((icon) => icon.purpose)).toEqual(['any', 'any', 'maskable', undefined]);
  });

  it('keeps the shared heart when the logo is missing or not one this app serves', () => {
    const heart = (logoUrl: string | null, logoMime: string | null) =>
      (organisationManifest({ code: 'asha', displayName: 'Asha Trust', theme: null, logoUrl, logoMime })['icons'] as { src: string }[]).map((icon) => icon.src);
    const shared = ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'];
    expect(heart(null, null)).toEqual(shared);
    expect(heart('/api/organisation/logo?v=1', 'image/png')).toEqual(shared);
    expect(heart('https://cdn.example/logo.png', 'image/png')).toEqual(shared);
    expect(heart('/api/auth/organisations/asha/logo?v=1', 'image/svg+xml')).toEqual(shared);
  });

  it('uses the organisation code when the display name is too long for a home screen', () => {
    const manifest = organisationManifest({
      code: 'asha',
      displayName: 'Asha Charitable Foundation',
      theme: null,
    });
    expect(manifest['short_name']).toBe('asha');
    expect(manifest['theme_color']).toBe('#1f5f8b');
  });

  it('ignores a colour token that could not be a colour', () => {
    const manifest = organisationManifest({
      code: 'asha',
      displayName: 'Asha Trust',
      theme: { brand: 'red; background: url(https://evil.example)' },
    });
    expect(manifest['theme_color']).toBe('#1f5f8b');
  });
});

describe('public theme colours', () => {
  it('keeps colour tokens and drops names and blank values', () => {
    expect(
      signInTheme({
        brand: '#112233',
        brandForeground: '#ffffff',
        background: '  ',
        label: 'Secret label',
        legalName: 'Asha Foundation Trust',
      }),
    ).toEqual({ brand: '#112233', brandForeground: '#ffffff' });
    expect(signInTheme(null)).toBeNull();
    expect(signInTheme({ label: 'Only a name' })).toBeNull();
  });
});
