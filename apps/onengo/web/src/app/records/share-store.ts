import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { httpShares } from '../core/records/gateway/http-gateway';
import { ShareSession, type ShareSnapshot } from '../core/records/sharing/sharing';
import { Api } from '../services/api';
import { ListStore } from './list-store';

/**
 * Angular wrapper around the share session of the open record, for the share
 * panel. It follows the list's record type and open record, and closes the
 * panel through the list.
 */
@Injectable()
export class ShareStore {
  private readonly list = inject(ListStore);
  private readonly gateway = httpShares(inject(Api));
  private current: { type: string; session: ShareSession; detach: () => void } | null = null;
  readonly snapshot = signal<ShareSnapshot | null>(null);

  constructor() {
    effect(() => {
      const type = this.list.spec()?.type.key;
      const id = this.list.state()?.id;
      untracked(() => {
        if (!type) return;
        if (this.current?.type !== type) {
          this.current?.detach();
          const session = new ShareSession(this.gateway, type);
          this.current = { type, session, detach: session.subscribe((s) => this.snapshot.set(s)) };
        }
        if (id) void this.current.session.open(id);
        else this.current.session.close();
      });
    });
    inject(DestroyRef).onDestroy(() => this.current?.detach());
  }

  /** The share session; every share intent goes through it. */
  get session(): ShareSession {
    return this.current!.session;
  }

  /** Back to the record. */
  close(): void {
    this.list.intents.setPanel({ kind: 'view' });
  }
}
