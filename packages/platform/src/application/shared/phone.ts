/** `+919876543210` from `+91 98765-43210`; null when it is not a phone number. */
export function normalisePhone(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).replace(/[\s\-().]/g, '');
  return /^\+?[1-9]\d{6,14}$/.test(s) ? s : null;
}
