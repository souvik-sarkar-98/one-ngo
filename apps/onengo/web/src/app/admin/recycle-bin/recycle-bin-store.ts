import { Injectable, computed, signal } from '@angular/core';
import { RecycleBinSession, type RecycleBinSnapshot } from '../../core/admin/recycle-bin';
import { AdminBase } from '../admin-store';
import { binColumns, binRow } from '../rows';

/** Administration › Recycle bin (`/admin/recycle-bin`): deleted records, searched on the server, restored after a confirmation. */
@Injectable()
export class RecycleBinStore extends AdminBase {
  readonly bin = new RecycleBinSession(this.gateway);
  readonly state = signal<RecycleBinSnapshot>(this.bin.state.value);
  readonly columns = computed(() => {
    this.i18n.locale();
    return binColumns();
  });
  readonly rows = computed(() => {
    this.i18n.locale();
    const now = new Date();
    return this.state().items.map((r) => binRow(r, now));
  });
  readonly hasMore = computed(() => this.state().items.length < this.state().total);

  constructor() {
    super();
    this.bin.state.subscribe((s) => this.state.set(s));
    void this.bin.load();
  }

  search(text: string): void {
    this.filterText.set(text);
    void this.bin.search(text);
  }

  rowAction(id: string, action: string): void {
    if (action === 'restore') this.bin.askRestore(id);
  }

  async confirmRestore(): Promise<void> {
    this.show(await this.bin.confirmRestore());
  }
}
