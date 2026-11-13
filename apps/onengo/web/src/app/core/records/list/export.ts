import type { RecordQueryBody } from '../../models';
import type { ExportOutcome, ImportExportGateway } from '../import/import-session';
import { queryBody } from './query';
import type { ListSpec } from '../spec';
import type { ListState } from './url';

/** The list's query without paging: same chip, search, filters and sort as the list shows. */
export function exportQuery(spec: ListSpec, state: ListState): RecordQueryBody {
  const query = queryBody(spec, state, 0, 0);
  delete query.limit;
  delete query.offset;
  return query;
}

/** A CSV of the current list, every field the person may read. */
export function exportList(gateway: ImportExportGateway, spec: ListSpec, state: ListState): Promise<ExportOutcome> {
  return gateway.exportList(spec.type.key, exportQuery(spec, state));
}

/** A CSV of chosen rows only, for the bulk bar's Export. */
export function exportSelected(gateway: ImportExportGateway, type: string, ids: readonly string[]): Promise<ExportOutcome> {
  return gateway.exportSelected(type, [...new Set(ids)]);
}
