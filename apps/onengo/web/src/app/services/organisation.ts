import { Injectable, inject, signal } from '@angular/core';
import { httpOrganisation, type OrganisationHttp } from '../core/organisation/http-organisation';
import type { OrganisationBranding, OrganisationGateway } from '../core/organisation/organisation';
import { organisationLogo } from '../core/shell/shell';
import { Api } from './api';

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * The organisation's gateway over the app's session, and the display name and
 * logo the shell shows. Logos that need the sign-in become data URLs, as the
 * content security policy allows data: images and the access token cannot
 * travel with an <img>.
 */
@Injectable({ providedIn: 'root' })
export class Organisation {
  private readonly api = inject(Api);
  private readonly http: OrganisationHttp = {
    get: (url) => this.api.get(url),
    post: (url, body) => this.api.post(url, body),
    put: (url, body) => this.api.put(url, body),
    patch: (url, body) => this.api.patch(url, body),
    delete: (url) => this.api.delete(url),
    blob: async (url) => (await this.api.send('GET', url)).blob(),
  };
  readonly gateway: OrganisationGateway = httpOrganisation(this.http);
  readonly branding = signal<OrganisationBranding | null>(null);
  readonly logo = signal<string | null>(null);
  private seq = 0;

  /** Reloads the shell's display name and logo; keeps what it had when that fails. */
  async refresh(): Promise<void> {
    const id = ++this.seq;
    try {
      const b = await this.gateway.branding();
      const src = organisationLogo(b.logoUrl);
      const logo = src ? await this.image(src).catch(() => null) : null;
      if (id !== this.seq) return;
      this.branding.set(b);
      this.logo.set(logo);
    } catch {
      // The shell falls back to the name it was signed in with.
    }
  }

  clear(): void {
    this.seq++;
    this.branding.set(null);
    this.logo.set(null);
  }

  /** A same-origin image that needs the sign-in, as a data URL for <img>. */
  async image(url: string): Promise<string> {
    return dataUrl(await this.gateway.image(url));
  }
}
