import type { Actor } from './db.js';

// JSON columns only infrastructure code writes, typed through the column overrides in .kysely-codegenrc.json.
// Use index signatures, not Record<>: the generated file declares an interface named Record for the record table.

/** `job.input`, `job.state` and `job.result`: the object the job kind defines. */
export type JobData = { [key: string]: unknown };

/** `job.actor`: who started the job; its batches run as them. */
export type JobActor = Actor;

/** `outbox_event.payload`: the event envelope's payload object. */
export type OutboxPayload = { [key: string]: unknown };
