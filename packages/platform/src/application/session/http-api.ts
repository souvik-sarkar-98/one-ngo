import type { AppRuntime, Inbox, LocaleResolver, OwnIdentity, OwnRoles, PinBoard, TwoStepSetup } from './ports/session-ports.js';
import { can, type RequestContext } from '../shared/http-api.js';
import type { PasskeyService } from '../identity/passkey-service.js';

export type { PinInput } from '../identity/pin-service.js';

/** The signed-in person's own session: account, language, pins, two-step set-up and notifications. */
export interface SessionApi {
  identity: TwoStepSetup;
  /** The person's own passkeys: adding, naming and removing them. */
  passkeys: Pick<PasskeyService, 'registrationOptions' | 'register' | 'list' | 'rename' | 'revoke'>;
  runtime: AppRuntime;
  pins: PinBoard;
  notifications: Inbox;
  me: CurrentPerson;
}

/** Who the caller is: their account, language, roles, permissions and what the app may show them. */
export class CurrentPerson {
  constructor(
    private readonly identity: OwnIdentity,
    private readonly runtime: LocaleResolver,
    private readonly roles: OwnRoles,
  ) {}

  async of(ctx: RequestContext) {
    const profile = await this.identity.profile(ctx);
    return {
      ...profile,
      locale: await this.runtime.localeFor(ctx),
      roles: ctx.actor.roles,
      roleNames: await this.roles.namesOf(ctx, ctx.actor.roles),
      permissions: ctx.actor.permissions,
      capabilities: {
        configure: can(ctx.actor, 'config:read'),
        publish: can(ctx.actor, 'config:publish'),
        scripts: can(ctx.actor, 'config:script:publish'),
        money: can(ctx.actor, 'money:accounts:read'),
        peopleDirectory: can(ctx.actor, 'people:read'),
        people: can(ctx.actor, 'members:manage'),
        roles: can(ctx.actor, 'admin:roles'),
        connectors: can(ctx.actor, 'admin:connectors'),
        apiKeys: can(ctx.actor, 'admin:api-keys'),
        jobs: can(ctx.actor, 'admin:jobs'),
        audit: can(ctx.actor, 'admin:audit'),
        settings: can(ctx.actor, 'admin:settings'),
        migration: can(ctx.actor, 'data:migrate'),
        migrationBooks: can(ctx.actor, 'data:migrate:books'),
      },
    };
  }
}
