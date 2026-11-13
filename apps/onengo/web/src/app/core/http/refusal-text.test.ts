import { afterEach, describe, expect, it } from 'vitest';
import { ENGLISH, useMessages } from '../i18n/i18n';
import { refusalText } from './refusal-text';

afterEach(() => {
  useMessages('en', ENGLISH);
});

describe('what a refused request says', () => {
  it('shows the catalogue wording for a refusal the app ships text for', () => {
    useMessages('hi', { 'ui.records.receiptIdentityIncomplete': 'पहले संगठन की पहचान पूरी करें।' });
    expect(refusalText({ message: 'Add the organisation’s legal name…', textKey: 'ui.records.receiptIdentityIncomplete' }, 'fallback')).toBe(
      'पहले संगठन की पहचान पूरी करें।',
    );
  });

  it('shows the server message for a key the app has no text for, and the fallback for no message at all', () => {
    expect(refusalText({ message: 'This receipt is already void.', textKey: 'ui.nothing.shipped' }, 'fallback')).toBe('This receipt is already void.');
    expect(refusalText({ message: 'This receipt is already void.' }, 'fallback')).toBe('This receipt is already void.');
    expect(refusalText({}, 'fallback')).toBe('fallback');
  });
});
