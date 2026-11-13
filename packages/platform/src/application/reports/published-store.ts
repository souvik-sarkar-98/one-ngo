import type { Tx } from '../../domain/ports/transaction.js';
import type { ReportColumn } from '../../runtime/definitions/types.js';
import type { ReportModel } from './model.js';

export type PublishedFormat = 'pdf' | 'excel';

/** The JSON a published report keeps: the data, and the layout used to print the page or build the workbook. */
export interface PublishedSnapshot {
  model: ReportModel;
  /** A PDF: the document template, the partials it names, and the page setup. */
  document?: {
    html: string;
    partials: Record<string, string>;
    pageSize: 'A4' | 'Letter';
    orientation: 'portrait' | 'landscape';
  };
  /** An Excel file: the report name and the sheets, so the workbook can be built again. */
  excel?: {
    label: string;
    sheets: { dataset: string; columns?: ReportColumn[] }[];
  };
}

export interface PublishedReportInsert {
  reportKey: string;
  title: string;
  params: Record<string, unknown>;
  format: PublishedFormat;
  model: PublishedSnapshot;
  createdBy: string;
}

export interface PublishedReportRow {
  id: string;
  reportKey: string;
  title: string;
  params: Record<string, unknown>;
  format: PublishedFormat;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
}

/** A report file kept when it was published, listed on its report's page. */
export interface PublishedReportStore {
  insert(tx: Tx, row: PublishedReportInsert): Promise<{ id: string }>;
  /** One report's files, newest first. The data JSON is left out of the list. */
  list(tx: Tx, reportKey: string): Promise<PublishedReportRow[]>;
  get(tx: Tx, id: string): Promise<(PublishedReportRow & { model: PublishedSnapshot }) | undefined>;
}
