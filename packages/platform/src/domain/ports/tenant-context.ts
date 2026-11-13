import type { Actor } from '../../shared/actor.js';

export type { Actor };

export interface TenantContext {
  tenantId: string;
  actor: Actor;
  /** Automation chain depth of the change being made; 0 for people. */
  depth?: number;
  /** Key of the automation that caused this change, so it does not retrigger itself. */
  causedBy?: string;
  /** Automations do not react to the change (a quiet import). */
  quiet?: boolean;
  /**
   * Parent records whose rollups a save would recompute are collected here
   * instead; the caller recomputes each of them once afterwards (imports).
   */
  deferredRollups?: Set<string>;
}