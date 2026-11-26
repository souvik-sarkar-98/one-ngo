/** A cell of a CSV the person will open in a spreadsheet. */
export type CsvCell = string | number | null | undefined;

const AMOUNT = /^-?\d+(\.\d+)?$/;

/**
 * One CSV cell. Text a spreadsheet would run as a formula (starting with `=`, `+`, `-` or `@`) is made plain
 * by a leading apostrophe; amounts, which may start with `-`, are left alone.
 */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@]/.test(s) && !AMOUNT.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows as CSV text with a byte-order mark, so a spreadsheet reads ₹ and names in any script correctly. */
export function csvOf(rows: CsvCell[][]): string {
  return `\uFEFF${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
