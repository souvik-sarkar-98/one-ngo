import { validationFailed } from '@onengo/kernel/errors';

/** Converts a rupee amount to whole paise, rejecting more than two decimals. */
export function toPaise(value: unknown, label = 'amount'): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw validationFailed(`${label} must be a number.`);
  const paise = Math.round(n * 100);
  if (Math.abs(paise - n * 100) > 1e-6) throw validationFailed(`${label} can have at most two decimal places.`);
  if (!Number.isSafeInteger(paise)) throw validationFailed(`${label} is too large.`);
  return paise;
}

export const paiseToDecimal = (paise: number): string => {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

export const isMoney = (value: unknown): boolean => {
  try {
    toPaise(value);
    return true;
  } catch {
    return false;
  }
};
