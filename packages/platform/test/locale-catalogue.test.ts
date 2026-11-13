import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MessageCatalogue } from '../src/runtime/definitions/messages.js';
import { LOCALE_DIR } from '../src/platform.js';

/** The message catalogue ships in `locale/`, one copy for the server and the web app. */
describe('shipped message catalogue', () => {
  it('has a locale folder the platform reads by default', () => {
    expect(existsSync(LOCALE_DIR)).toBe(true);
    expect(LOCALE_DIR.replaceAll('\\', '/')).toMatch(/\/locale$/);
  });

  it('resolves an English message', () => {
    const en = new MessageCatalogue(LOCALE_DIR).messages('en');
    expect(en['ui.locale.name']).toBe('English');
    expect(en['ui.common.cancel']).toBe('Cancel');
    expect(Object.keys(en).length).toBeGreaterThan(500);
  });

  it('merges the area files into the locale and falls back to English', () => {
    const catalogue = new MessageCatalogue(LOCALE_DIR);
    const en = catalogue.messages('en');
    expect(Object.keys(en).some((k) => k.startsWith('ui.admin.'))).toBe(true);
    expect(Object.keys(en).some((k) => k.startsWith('ui.builder.'))).toBe(true);
    const hi = catalogue.messages('hi');
    expect(hi['ui.locale.name']).toBe('हिन्दी');
    expect(hi['ui.common.cancel']).toBe('रद्द करें');
    const partial = new MessageCatalogue(undefined, { en: { 'ui.common.cancel': 'Cancel' }, hi: { 'ui.locale.name': 'हिन्दी' } });
    expect(partial.messages('hi')['ui.common.cancel']).toBe('Cancel');
  });
});
