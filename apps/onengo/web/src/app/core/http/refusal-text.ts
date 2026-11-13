import { currentTranslator, t } from '../i18n/i18n';

/**
 * What a refused request says. The server answers in English and may name the
 * screen-text key for that wording in `textKey`; where the app ships the key,
 * the reader sees the refusal in their own language instead.
 */
export function refusalText(error: { message?: string; textKey?: string }, fallback: string): string {
  if (error.textKey && currentTranslator().has(error.textKey)) return t(error.textKey);
  return error.message ?? fallback;
}
