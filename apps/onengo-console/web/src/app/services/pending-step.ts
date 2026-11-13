import type { OperatorStepUpActionContract } from '@onengo/platform/contracts';

const KEY = 'onengo.operator.pending';

/** What the operator was doing when they left for a fresh two-factor check. */
export interface PendingStep {
  action: OperatorStepUpActionContract;
  target: string;
  payload: Record<string, string>;
}

export function savePending(value: PendingStep): void {
  sessionStorage.setItem(KEY, JSON.stringify(value));
}

export function readStored(): PendingStep | undefined {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return undefined;
  try { return JSON.parse(raw) as PendingStep; } catch { return undefined; }
}

export function readPending(action: OperatorStepUpActionContract, target: string): PendingStep | undefined {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as PendingStep;
    if (value.action !== action || value.target.toLocaleLowerCase() !== target.toLocaleLowerCase()) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function clearPending(): void {
  sessionStorage.removeItem(KEY);
}

/** The current page without a previous step-up id, so a new check returns to a clean address. */
export function returnPath(): string {
  const params = new URLSearchParams(location.search);
  params.delete('stepUpId');
  const query = params.toString();
  return location.pathname + (query ? `?${query}` : '');
}
