export type Environment = Record<string, string | undefined>;

export function requiredEnvironment(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function optionalInteger(env: Environment, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

export function optionalBoolean(env: Environment, name: string, fallback = false): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'no'].includes(raw)) return false;
  throw new Error(`${name} must be a boolean.`);
}
