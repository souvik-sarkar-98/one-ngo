import { Component, computed, inject } from '@angular/core';
import { t } from '../core/i18n/i18n';
import { recordTitle } from '../core/records/record/present';
import { initials, shareLine, shareName } from '../core/records/sharing/sharing';
import { SharePanel, type ShareRow } from '../ui/share-panel';
import { ListStore } from './list-store';
import { RecordStore } from './record-store';
import { ShareStore } from './share-store';

/** The record panel in share mode (`panel=share`): the open record's shares on ui/share-panel. */
@Component({
  selector: 'app-record-share',
  imports: [SharePanel],
  providers: [ShareStore],
  template: `
    @if (shares.snapshot(); as s) {
      <app-share-panel
        [title]="title()"
        [shares]="rows()"
        [loading]="s.loading"
        [busy]="s.busy"
        [source]="shares.session.source"
        [chosenText]="s.draft.chosen?.name ?? ''"
        [access]="s.draft.access"
        [expiresOn]="s.draft.expiresOn"
        [errors]="s.errors"
        [error]="s.error"
        [message]="s.message"
        [warning]="s.warning"
        (chosen)="shares.session.choose($event)"
        (accessChange)="shares.session.setAccess($event)"
        (expiresChange)="shares.session.setExpiry($event)"
        (submit)="shares.session.share()"
        (remove)="shares.session.remove($event)"
        (dismissed)="shares.close()" />
    }
  `,
})
export class RecordShare {
  private readonly list = inject(ListStore);
  private readonly rec = inject(RecordStore);
  readonly shares = inject(ShareStore);

  readonly title = computed(() => {
    const spec = this.list.spec();
    const record = this.rec.snapshot()?.record;
    return t('ui.share.title', { title: spec && record ? recordTitle(spec, record) : '' });
  });
  readonly rows = computed<ShareRow[]>(() =>
    (this.shares.snapshot()?.shares ?? []).map((s) => ({ id: s.id, initials: initials(s.name), name: shareName(s), line: shareLine(s) })),
  );
}
