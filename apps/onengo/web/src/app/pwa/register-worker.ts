import { isDevMode, type ApplicationRef } from '@angular/core';

/**
 * Registers the service worker in production builds once the app is stable,
 * or after 30 seconds. Done by hand rather than with `provideServiceWorker`,
 * which would put the worker client in the first download; the update prompt
 * brings that client in with the shell.
 */
export function registerWorker(app: ApplicationRef): void {
  if (isDevMode() || !('serviceWorker' in navigator)) return;
  void Promise.race([app.whenStable(), new Promise((done) => setTimeout(done, 30_000))]).then(() =>
    navigator.serviceWorker.register('ngsw-worker.js').catch((err) => console.error(err)),
  );
}
