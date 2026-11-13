/** A file name safe to store and to send back in a header: no folders, control characters or quotes. */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').trim().slice(-200);
  return name || 'file';
}
