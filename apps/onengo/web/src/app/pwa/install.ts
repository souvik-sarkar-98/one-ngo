import { signal } from '@angular/core';

/** What the install link should do on this device. */
export type InstallOffer = 'installed' | 'prompt' | 'ios' | 'browser';

export interface InstallState {
  installed: boolean;
  /** The browser has offered its install prompt. */
  prompt: boolean;
  ios: boolean;
}

/** Chooses the install link. An installed app hides it; a prompt installs; otherwise the page explains the browser's own steps. */
export function installOffer(state: InstallState): InstallOffer {
  if (state.installed) return 'installed';
  if (state.prompt) return 'prompt';
  if (state.ios) return 'ios';
  return 'browser';
}

/** iPhone, iPad, and iPadOS (which reports itself as a Mac with a touch screen). */
export function isIos(ua: string, platform = '', touchPoints = 0): boolean {
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  return platform === 'MacIntel' && touchPoints > 1;
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
let watching = false;

/** The install link reads this. It changes when the browser offers install, or the app is already running installed. */
export const installState = signal<InstallState>({ installed: false, prompt: false, ios: false });

function readState(): InstallState {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return { installed: standalone, prompt: deferred !== null, ios: isIos(navigator.userAgent, navigator.platform, navigator.maxTouchPoints) };
}

const DEFAULT_APPLE_TOUCH_ICON = '/icons/apple-touch-icon.png';

/** The apple-touch-icon address: the organisation logo, or the shared heart when it has none. */
export function appleTouchHref(logoUrl: string | null | undefined): string {
  const value = logoUrl?.trim() ?? '';
  if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) return value;
  return DEFAULT_APPLE_TOUCH_ICON;
}

/**
 * Safari reads this link, not the manifest, when adding the page to the home screen.
 * A null logo restores the shared heart.
 */
export function pointAppleTouchIcon(logoUrl: string | null | undefined): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'apple-touch-icon';
    document.head.append(link);
  }
  link.href = appleTouchHref(logoUrl);
}

/** The instructions to show when this browser has no install dialog. */
export function installHelp(offer: InstallOffer): 'ios' | 'browser' | null {
  return offer === 'ios' || offer === 'browser' ? offer : null;
}

/**
 * Opens the browser's install dialog when it has offered one.
 * Otherwise the caller shows that browser's own steps, still on this page.
 */
export async function beginInstall(): Promise<'ios' | 'browser' | null> {
  const offer = installOffer(installState());
  if (offer === 'prompt') {
    await promptInstall();
    return null;
  }
  return installHelp(offer);
}

/** Listens for the browser's install offer. Call once at startup, before the offer can fire. */
export function watchInstall(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  installState.set(readState());
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    installState.set(readState());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installState.set(readState());
  });
}

/** Shows the browser's install prompt when it has offered one. True when the person accepts. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  await event.prompt();
  const choice = await event.userChoice;
  deferred = null;
  installState.set(readState());
  return choice.outcome === 'accepted';
}
