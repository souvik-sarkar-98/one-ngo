import type { ReportService } from './report-service.js';

/** Reports a person may run, their preview and their Excel download. */
export interface ReportsApi {
  reports: ReportService;
}
