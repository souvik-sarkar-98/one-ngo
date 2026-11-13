/** Whether a refusal says the request never reached the server. */
export function isOffline(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'offline';
}

/**
 * Sends a write again once the connection returns, so an edit saved while
 * offline completes by itself instead of asking for a second Save. Only the
 * request in hand waits: nothing is kept on the device.
 */
export async function sendWhenOnline<T>(send: () => Promise<T>, reconnects: () => Promise<boolean>): Promise<T> {
  try {
    return await send();
  } catch (e) {
    if (!isOffline(e) || !(await reconnects())) throw e;
    return send();
  }
}
