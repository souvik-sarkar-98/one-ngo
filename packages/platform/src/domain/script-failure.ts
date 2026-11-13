import { PlatformError } from '@onengo/kernel/errors';

/** A script failed or ran out of its limits; carries what it logged. */
export class ScriptFailure extends PlatformError {
  constructor(
    code: 'script_failed' | 'script_limit',
    message: string,
    readonly logs: string[] = [],
    readonly durationMs = 0,
  ) {
    super(code, message);
    this.name = 'ScriptFailure';
  }
}
