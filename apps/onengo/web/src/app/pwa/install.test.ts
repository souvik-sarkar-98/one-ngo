import { describe, expect, it } from 'vitest';
import { appleTouchHref, beginInstall, installHelp, installOffer, installState, isIos } from './install';

describe('install link', () => {
  it('hides the link once the app is installed', () => {
    expect(installOffer({ installed: true, prompt: true, ios: true })).toBe('installed');
  });

  it('uses the browser prompt when the browser offers one', () => {
    expect(installOffer({ installed: false, prompt: true, ios: false })).toBe('prompt');
  });

  it('explains Add to Home Screen on iPhone when there is no prompt', () => {
    expect(installOffer({ installed: false, prompt: false, ios: true })).toBe('ios');
  });

  it('explains the browser menu otherwise', () => {
    expect(installOffer({ installed: false, prompt: false, ios: false })).toBe('browser');
  });
});

describe('install on this page', () => {
  it('explains the browser steps when there is no install dialog', () => {
    expect(installHelp('ios')).toBe('ios');
    expect(installHelp('browser')).toBe('browser');
    expect(installHelp('prompt')).toBeNull();
    expect(installHelp('installed')).toBeNull();
  });

  it('returns those steps from the click, and does not navigate', async () => {
    installState.set({ installed: false, prompt: false, ios: true });
    expect(await beginInstall()).toBe('ios');
    installState.set({ installed: false, prompt: false, ios: false });
    expect(await beginInstall()).toBe('browser');
    installState.set({ installed: true, prompt: false, ios: false });
    expect(await beginInstall()).toBeNull();
  });
});

describe('home-screen icon', () => {
  it('uses the organisation logo, and the shared heart when there is none', () => {
    expect(appleTouchHref('/api/auth/organisations/asha/logo?v=3')).toBe('/api/auth/organisations/asha/logo?v=3');
    expect(appleTouchHref(null)).toBe('/icons/apple-touch-icon.png');
    expect(appleTouchHref('  ')).toBe('/icons/apple-touch-icon.png');
    expect(appleTouchHref('https://cdn.example/logo.png')).toBe('/icons/apple-touch-icon.png');
    expect(appleTouchHref('//cdn.example/logo.png')).toBe('/icons/apple-touch-icon.png');
  });
});

describe('iPhone and iPad', () => {
  it('recognises an iPhone, an iPad, and an iPad that reports itself as a Mac', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true);
    expect(isIos('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 0)).toBe(false);
  });
});
