import { t } from '../../i18n/i18n';
import type { RecordView } from '../../models';
import { PagedController, type PagedSnapshot } from '../../paging/paged-controller';
import type { RecordsGateway } from '../gateway/gateway';
import { queryBody } from './query';
import type { ListSpec } from '../spec';
import { queryKey, type ListState } from './url';

export type ListSnapshot = PagedSnapshot<RecordView>;

/** The records of one list, paged by the list state from the address bar. */
export class ListController extends PagedController<RecordView, ListState> {
  constructor(gateway: RecordsGateway, spec: ListSpec) {
    super({
      key: queryKey,
      show: (state) => state.show,
      load: (state, offset, limit) => gateway.query(spec.type.key, queryBody(spec, state, offset, limit)),
      id: (r) => r.id,
      get failure() {
        return t('ui.records.loadFailed');
      },
    });
  }
}
