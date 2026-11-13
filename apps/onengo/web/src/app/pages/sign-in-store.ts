import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import type { SignInOrganisation } from '../core/organisation/organisation';
import { ANOTHER_ORGANISATION, organisationCode, organisationSignInPath } from '../core/organisation/sign-in';
import { safeNext } from '@onengo/web-kit';
import { ApiError } from '../services/api';
import { Organisation } from '../services/organisation';
import { Session } from '../services/session';

/** Where the sign-in screen goes once the person is signed in, and the organisation its own page is for. */
@Injectable()
export class SignInStore {
  private readonly router = inject(Router);
  private readonly session = inject(Session);
  private readonly organisation = inject(Organisation);

  /** The address the person was sent away from, when it is inside the app; otherwise Home. */
  async continue(next: string | null): Promise<void> {
    await this.router.navigateByUrl(safeNext(next));
  }

  /**
   * The organisation an `/o/<code>/sign-in` page is for, or `not-found` for
   * an unknown or inactive code (the server answers both alike); other
   * failures are thrown.
   */
  async organisationFor(raw: string): Promise<SignInOrganisation | 'not-found'> {
    const code = organisationCode(raw);
    if (!code) return 'not-found';
    try {
      return await this.organisation.gateway.signInOrganisation(code);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return 'not-found';
      throw e;
    }
  }

  /**
   * The generic code form's "Continue": open the typed organisation's own
   * sign-in page. An empty or malformed code stays on the form; the page it
   * opens gives the same unavailable answer for an unknown or inactive code.
   */
  async openOrganisation(raw: string, next: string | null): Promise<void> {
    const code = organisationCode(raw);
    if (!code) return;
    await this.router.navigate([organisationSignInPath(code)], { queryParams: next ? { next } : {} });
  }

  /** "Use another organisation": forget the last one and open the generic sign-in with the organisation code field. */
  async useAnother(next: string | null): Promise<void> {
    this.session.forgetOrganisation();
    await this.router.navigate(['/sign-in'], { queryParams: { [ANOTHER_ORGANISATION]: '', ...(next ? { next } : {}) } });
  }
}
