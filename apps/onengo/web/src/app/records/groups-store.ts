import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { CollapsedGroups, recordsModel } from '../core/groups';
import { I18n } from '../services/i18n';
import { Session } from '../services/session';

/** The Records screen's state: the search text and the groups the person collapsed, kept on the device. */
@Injectable()
export class GroupsStore {
  private readonly router = inject(Router);
  private readonly session = inject(Session);
  private readonly i18n = inject(I18n);
  private readonly memory = new CollapsedGroups(localStorage, this.session.me()?.tenant.key ?? '');

  readonly query = signal('');
  private readonly collapsed = signal(this.memory.value);
  readonly model = computed(() => {
    this.i18n.locale();
    return recordsModel(this.session.defs(), this.query(), this.collapsed());
  });

  toggle(group: string): void {
    this.collapsed.set(this.memory.toggle(group));
  }

  open(link: string): void {
    void this.router.navigateByUrl(link);
  }
}
