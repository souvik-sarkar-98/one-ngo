import bn from '@onengo/product/locale/bn.json';
import en from '@onengo/product/locale/en.json';
import hi from '@onengo/product/locale/hi.json';
import mr from '@onengo/product/locale/mr.json';
import ta from '@onengo/product/locale/ta.json';
import te from '@onengo/product/locale/te.json';
import { LOCALES } from './i18n';

const OWN: Record<(typeof LOCALES)[number], { 'ui.locale.name'?: string }> = { en, hi, ta, te, bn, mr };

/** Each app language in its own script, as the language choice lists it. */
export const LANGUAGES: { code: string; name: string }[] = LOCALES.map((code) => ({ code, name: OWN[code]['ui.locale.name'] ?? code }));

export const languageName = (code: string): string => LANGUAGES.find((l) => l.code === code)?.name ?? code;
