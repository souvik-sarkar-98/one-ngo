/** CSV text in and out; the RFC 4180 implementation is infrastructure (transfer). */
export interface CsvCodec {
  parseCsv(text: string): string[][];
  /** One CSV line, CRLF-terminated. */
  csvLine(cells: string[]): string;
}
