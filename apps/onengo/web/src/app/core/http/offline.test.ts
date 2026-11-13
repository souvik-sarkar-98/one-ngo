import { describe, expect, it } from 'vitest';
import { isOffline, sendWhenOnline } from './offline';

const offline = () => ({ code: 'offline', message: 'Cannot reach the server.' });

describe('a write that found no connection', () => {
  it('sends again when the connection returns, and answers with that send', async () => {
    const sent: number[] = [];
    let attempt = 0;
    const send = () => {
      sent.push(++attempt);
      return attempt === 1 ? Promise.reject(offline()) : Promise.resolve('saved');
    };
    await expect(sendWhenOnline(send, () => Promise.resolve(true))).resolves.toBe('saved');
    expect(sent).toEqual([1, 2]);
  });

  it('reports the offline refusal when the connection stays away', async () => {
    let attempts = 0;
    const send = () => {
      attempts++;
      return Promise.reject(offline());
    };
    await expect(sendWhenOnline(send, () => Promise.resolve(false))).rejects.toMatchObject({ code: 'offline' });
    expect(attempts).toBe(1);
  });

  it('reports the second refusal when the connection returns and the send fails again', async () => {
    let attempts = 0;
    const send = () => {
      attempts++;
      return Promise.reject(attempts === 1 ? offline() : { code: 'conflict', message: 'Someone else changed it.' });
    };
    await expect(sendWhenOnline(send, () => Promise.resolve(true))).rejects.toMatchObject({ code: 'conflict' });
    expect(attempts).toBe(2);
  });
});

describe('other refusals', () => {
  it('are passed on without waiting', async () => {
    let waited = false;
    const send = () => Promise.reject({ code: 'validation_failed', message: 'Enter an amount.' });
    await expect(
      sendWhenOnline(send, () => {
        waited = true;
        return Promise.resolve(true);
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(waited).toBe(false);
  });

  it('are told apart from an offline one', () => {
    expect(isOffline(offline())).toBe(true);
    expect(isOffline({ code: 'error' })).toBe(false);
    expect(isOffline(new Error('Cannot reach the server.'))).toBe(false);
    expect(isOffline(null)).toBe(false);
  });
});
