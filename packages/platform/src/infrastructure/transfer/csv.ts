import { infrastructureValidationFailed as validationFailed } from '@onengo/kernel/errors';

/** A plain number such as -250.50, which a spreadsheet shows as it is. */
const PLAIN_NUMBER = /^-\d+(\.\d+)?$/;

/** A dialling code and number, such as +91 98765 43210: digits, spaces, brackets and dashes only, so nothing a spreadsheet can run. */
const DIALLING_CODE = /^\+\d[\d ()-]*\d$/;

/** The single quote {@link csvCell} writes before text a spreadsheet would run. */
const GUARDED = /^'[=+\-@\t\r]/;

/**
 * RFC 4180 rows from CSV text: quoted cells with doubled quotes and embedded
 * line breaks, CRLF or LF line ends, and an optional byte-order mark. A
 * trailing line break does not make an extra row. The single quote a
 * spreadsheet file carries before a formula-leading character is dropped, so
 * a file this codec wrote reads back as the values that went into it.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  const endCell = () => {
    row.push(GUARDED.test(cell) ? cell.slice(1) : cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      if (c === '\n') line++;
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === '') {
      quoted = true;
      i++;
    } else if (c === ',') {
      endCell();
      i++;
    } else if (c === '\r' || c === '\n') {
      endRow();
      line++;
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      cell += c;
      i++;
    }
  }
  if (quoted) throw validationFailed(`The file has a quoted value that is never closed (from line ${line}).`);
  if (cell !== '' || row.length) endRow();
  return rows;
}

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (starting
 * with = + - @, a tab or a carriage return) is prefixed with a single quote;
 * plain numbers such as -250.50 and phone numbers such as +91 98765 43210 are
 * left as they are.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) && !PLAIN_NUMBER.test(value) && !DIALLING_CODE.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One CSV line, CRLF-terminated. */
export function csvLine(cells: string[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/** The CSV codec the import and export use cases are given. */
export const csvCodec = { parseCsv, csvLine };
