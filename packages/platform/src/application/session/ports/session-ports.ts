import type { TenantContext } from '../../../domain/ports/tenant-context.js';
import type { RuntimeService } from '../../../runtime/definitions/runtime.js';
import type { TwoStepReauth } from '../../identity/identity-service.js';
import type { Pin, PinInput } from '../../identity/pin-service.js';
import type { InboxItem, InboxOptions } from '../../notifications/notification-service.js';

/** What the signed-in person's own routes ask of identity, language, pins and notifications. */

/** What the app is given to render: theme, list views, record types, workflows, actions and pages for this caller. */
export type RuntimeDefinitions = Awaited<ReturnType<RuntimeService['definitions']>>;

/** Two-step sign-in set-up. */
export interface TwoStepSetup {
  beginTwoStep(ctx: TenantContext, reauth?: TwoStepReauth): Promise<{ secret: string; otpauthUrl: string }>;
  confirmTwoStep(ctx: TenantContext, code: string): Promise<void>;
}

/** The caller's own identity. */
export interface OwnIdentity {
  profile(ctx: TenantContext): Promise<{ userId: string; displayName: string; email: string | null; twoStepEnabled: boolean; tenant: { id: string; key: string; name: string } }>;
}

/** The names of the caller's own roles, so their profile shows "Administrator", not `admin`. */
export interface OwnRoles {
  namesOf(ctx: TenantContext, keys: readonly string[]): Promise<string[]>;
}

/** What the app may show: definitions, messages and the language choice. */
export interface AppRuntime {
  definitions(ctx: TenantContext, requested?: string): Promise<RuntimeDefinitions>;
  messages(ctx: TenantContext, requested?: string): Promise<{ locale: string; messages: Record<string, string> }>;
  setLocale(ctx: TenantContext, locale: string): Promise<{ locale: string }>;
}

/** The language the caller sees. */
export interface LocaleResolver {
  localeFor(ctx: TenantContext, requested?: string): Promise<string>;
}

/** The caller's pins. */
export interface PinBoard {
  list(ctx: TenantContext): Promise<Pin[]>;
  add(ctx: TenantContext, input: PinInput): Promise<Pin>;
  reorder(ctx: TenantContext, ids: unknown): Promise<Pin[]>;
  rename(ctx: TenantContext, id: string, label: unknown): Promise<Pin>;
  remove(ctx: TenantContext, id: string): Promise<void>;
}

/** The caller's notification inbox. */
export interface Inbox {
  inboxPage(ctx: TenantContext, options?: InboxOptions): Promise<{ items: InboxItem[]; next: string | null }>;
  markAllRead(ctx: TenantContext): Promise<number>;
  markRead(ctx: TenantContext, id: string): Promise<void>;
}
