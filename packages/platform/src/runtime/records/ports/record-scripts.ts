import type { EffectCheck, EffectPolicy, ScriptHook } from '../../scripts/types.js';

export interface BeforeSaveInput {
  code: string;
  record: Record<string, unknown>;
  previous: Record<string, unknown> | null;
  status: string | null;
  recordType: string;
  user: { id: string; roles: string[] };
  timeoutMs?: number;
  memoryMb?: number;
  /** The organisation the run is charged to; its runs share that organisation's worker and time budget. */
  tenantId?: string;
}

export interface ScriptRunInput extends BeforeSaveInput {
  hook: ScriptHook;
  /** Data the script declared, loaded by the host; read-only in the script. */
  inputs?: Record<string, unknown>;
  /** Extra read-only facts for the hook, such as the saved id and number after the write, or the workflow step asked for. */
  extra?: Record<string, unknown>;
  /** A Try it run: at most one at a time per organisation. */
  trial?: boolean;
  /** Output cap for this run. Report shaping allows more than a record script. */
  maxOutputBytes?: number;
}

export interface ScriptResult {
  record: Record<string, unknown>;
  logs: string[];
  durationMs: number;
}

export interface ScriptRunResult {
  /** The script's output as the effect validator takes it: `{ record?, effects }`. */
  output: { record?: Record<string, unknown>; effects: unknown[] };
  logs: string[];
  durationMs: number;
}

/** What the record engine needs to run scripts on a save; the script sandbox implements it and composition injects it. */
export interface RecordScripts {
  /** Runs a before-save script and returns the record it leaves; any proposed effects are ignored. */
  runBeforeSave(input: BeforeSaveInput): Promise<ScriptResult>;
  /** Runs a script on any hook; proposed effects come back unchecked. */
  run(input: ScriptRunInput): Promise<ScriptRunResult>;
  /** Checks a script's output against the effect schema and the declared policy. */
  checkEffects(output: unknown, policy: EffectPolicy): EffectCheck;
}
