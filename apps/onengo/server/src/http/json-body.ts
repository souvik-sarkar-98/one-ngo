/** A JSON request body as text: empty is `{}`, anything unparseable is a 400. */
export function parseJsonBody(text: string, done: (err: Error | null, body?: unknown) => void): void {
  if (!text.length) return done(null, {});
  try {
    done(null, JSON.parse(text));
  } catch {
    const err = new Error('Body is not valid JSON.') as Error & { statusCode: number };
    err.statusCode = 400;
    done(err, undefined);
  }
}

export function bodyText(body: string | Buffer): string {
  return typeof body === 'string' ? body : body.toString('utf8');
}
