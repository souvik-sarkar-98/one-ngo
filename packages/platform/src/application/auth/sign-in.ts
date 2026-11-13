import type { IdentityService } from '../identity/identity-service.js';

/** What a person sends to sign in; `tenant` is the organisation's code. */
export interface SignInRequest {
  tenant: string;
  email: string;
  totpCode?: string;
  /** The client address, for the sign-in throttle. */
  ip?: string;
}

/** Signing a person in: by password, by the code mailed to them, or by finishing the second step of a provider sign-in. */
export class SignIn {
  constructor(private readonly identity: Pick<IdentityService, 'loginWithPassword' | 'loginWithEmailCode' | 'completeTwoStepTicket' | 'refresh'>) {}

  withPassword(request: SignInRequest & { password: string }) {
    return this.identity.loginWithPassword({
      tenantKey: request.tenant,
      email: request.email,
      password: request.password,
      totpCode: request.totpCode,
      ip: request.ip,
    });
  }

  withEmailCode(request: SignInRequest & { code: string }) {
    return this.identity.loginWithEmailCode({
      tenantKey: request.tenant,
      email: request.email,
      code: request.code,
      totpCode: request.totpCode,
      ip: request.ip,
    });
  }

  withTwoStepTicket(request: { ticket: string; totpCode: string }) {
    return this.identity.completeTwoStepTicket({ ticket: request.ticket, totpCode: request.totpCode });
  }

  /** A new token pair for a refresh token; the old one stops working. */
  refresh(refreshToken: string) {
    return this.identity.refresh(refreshToken);
  }
}
