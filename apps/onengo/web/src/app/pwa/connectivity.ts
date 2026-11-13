import { Injectable, signal } from '@angular/core';

/** How long a save that found no connection waits for one. */
const WAIT = 60_000;

/** Whether the browser thinks it is online. Nothing is saved on the device, so saving waits for the connection. */
@Injectable({ providedIn: 'root' })
export class Connectivity {
  readonly online = signal(navigator.onLine);

  constructor() {
    addEventListener('online', () => this.online.set(true));
    addEventListener('offline', () => this.online.set(false));
  }

  /**
   * Waits after a request found no connection: true once the connection
   * returns, false when the browser was online all along (the server itself
   * could not be reached) or when it stays away.
   */
  reconnects(wait = WAIT): Promise<boolean> {
    if (this.online()) return Promise.resolve(false);
    return new Promise((resolve) => {
      const back = () => {
        clearTimeout(timer);
        removeEventListener('online', back);
        resolve(true);
      };
      const timer = setTimeout(() => {
        removeEventListener('online', back);
        resolve(false);
      }, wait);
      addEventListener('online', back);
    });
  }
}
