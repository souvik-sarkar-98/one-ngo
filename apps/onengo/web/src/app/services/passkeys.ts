import { Injectable, inject } from '@angular/core';
import type { PasskeyResponse } from '../core/auth/passkey';
import { Api } from './api';

/** A passkey as the person sees it: its name and kind, never the key. */
export interface PasskeyInfo {
  id: string;
  name: string;
  deviceType: 'multiDevice' | 'singleDevice';
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Proof of the person for changes to sign-in, required once two-step is on. */
export interface PasskeyReauth {
  password?: string;
  totpCode?: string;
}

/** The signed-in person's own passkeys. */
@Injectable({ providedIn: 'root' })
export class Passkeys {
  private readonly api = inject(Api);

  list(): Promise<PasskeyInfo[]> {
    return this.api.get<PasskeyInfo[]>('/api/me/passkeys');
  }

  /** Starts saving a passkey on this device; resolves with the options to hand to the browser. */
  begin(reauth: PasskeyReauth = {}): Promise<{ challengeId: string; options: unknown }> {
    return this.api.post<{ challengeId: string; options: unknown }>('/api/me/passkeys/begin', reauth);
  }

  confirm(challengeId: string, response: PasskeyResponse, name?: string): Promise<PasskeyInfo> {
    return this.api.post<PasskeyInfo>('/api/me/passkeys/confirm', { challengeId, response, ...(name ? { name } : {}) });
  }

  rename(id: string, name: string): Promise<PasskeyInfo> {
    return this.api.patch<PasskeyInfo>(`/api/me/passkeys/${encodeURIComponent(id)}`, { name });
  }

  revoke(id: string, reauth: PasskeyReauth = {}): Promise<void> {
    return this.api.post<void>(`/api/me/passkeys/${encodeURIComponent(id)}/revoke`, reauth);
  }
}
