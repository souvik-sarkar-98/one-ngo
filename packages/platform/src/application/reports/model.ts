/** Shown on every report, on the page and on the Excel cover. */
export const MANAGEMENT_REPORT = 'Management report';

/** One loaded dataset: rows for a list or for each bucket, and the total when there is one. */
export interface ReportDatasetView {
  label: string;
  rows: Record<string, unknown>[];
  total: number;
  value?: number;
}

/** One signatory printed on a report, in the order it is shown. */
export interface ReportSignatory {
  name: string;
  designation: string;
  /** The signature image kept with this report. Null when none was saved. */
  fileId: string | null;
}

/** The data a document template and a workbook both read. */
export interface ReportModel {
  org: { name: string };
  params: Record<string, unknown>;
  datasets: Record<string, ReportDatasetView>;
  calculations: Record<string, unknown>;
  generatedAt: string;
  /** The fixed management-report label. */
  label: string;
  /** The report's own name. */
  title: string;
  /** The ordered set printed on reports when this model was built. */
  signatories: ReportSignatory[];
}

/** A module registers one of these to shape a report in code. None are shipped. */
export interface ReportProvider {
  readonly key: string;
  shape(model: ReportModel): ReportModel | Promise<ReportModel>;
}

/** Providers registered by modules. Empty unless a module adds one. */
export class ReportProviders {
  private readonly providers = new Map<string, ReportProvider>();

  register(provider: ReportProvider): void {
    this.providers.set(provider.key, provider);
  }

  get(key: string): ReportProvider | undefined {
    return this.providers.get(key);
  }
}
