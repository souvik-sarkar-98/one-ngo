import { describe, expect, it } from 'vitest';
import { htmlDocument, idFromHash, matchesQuery, senderLine, senderName, type MailSummary } from '../../../../apps/service-sandbox/web/src/app/model';

const message: MailSummary = {
  id: 4,
  threadId: '4',
  at: '2026-11-28T09:00:00.000Z',
  from: 'ngo@example.org',
  fromName: 'Asha at NGO',
  to: ['donor@example.com'],
  cc: ['audit@example.com'],
  subject: 'Your receipt',
};

describe('inbox model', () => {
  it('searches sender, recipients and subject without regard to case', () => {
    expect(matchesQuery(message, '')).toBe(true);
    expect(matchesQuery(message, '  ')).toBe(true);
    expect(matchesQuery(message, 'RECEIPT')).toBe(true);
    expect(matchesQuery(message, 'asha')).toBe(true);
    expect(matchesQuery(message, 'donor@')).toBe(true);
    expect(matchesQuery(message, 'audit@')).toBe(true);
    expect(matchesQuery(message, 'invoice')).toBe(false);
  });

  it('labels the sender with the name when there is one', () => {
    expect(senderLine(message)).toBe('Asha at NGO <ngo@example.org>');
    expect(senderLine({ from: 'a@b.c', fromName: 'a@b.c' })).toBe('a@b.c');
    expect(senderName(message)).toBe('Asha at NGO');
    expect(senderName({ from: '', fromName: '' })).toBe('(unknown sender)');
  });

  it('reads a message id from the address fragment', () => {
    expect(idFromHash('#12')).toBe(12);
    expect(idFromHash('')).toBeNull();
    expect(idFromHash('#abc')).toBeNull();
    expect(idFromHash('#1x')).toBeNull();
  });

  it('wraps message HTML in a document that blocks scripts and requests', () => {
    const doc = htmlDocument('<p>Hello</p>');
    expect(doc).toContain("default-src 'none'");
    expect(doc.endsWith('<p>Hello</p>')).toBe(true);
  });
});
