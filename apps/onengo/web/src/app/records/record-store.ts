import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { RecordView, RuntimeDefinitions } from '../core/models';
import { httpPeople } from '../core/people/http-people';
import { recordCrumb } from '../core/records/record/present';
import { RecordSession, type RecordSnapshot } from '../core/records/record/record-session';
import { resolveListSpec, type ListSpec } from '../core/records/spec';
import { Api } from '../services/api';
import { Files } from '../services/files';
import { ScreenMeta } from '../services/screen-meta';
import { Session } from '../services/session';
import { ListStore } from './list-store';
import type { Notice } from './notice';

/**
 * Angular wrapper around the record session for whichever screen shows the
 * open record. It follows the list state, exposes the session as a signal,
 * and puts saved records back into the list.
 */
@Injectable()
export class RecordStore {
  private readonly list = inject(ListStore);
  private readonly app = inject(Session);
  private readonly people = httpPeople(inject(Api));
  private readonly files = inject(Files);
  private specs = { defs: null as RuntimeDefinitions | null, byType: new Map<string, ListSpec | null>() };
  private detach: () => void = () => undefined;
  private readonly current = signal<RecordSession | null>(null);
  readonly snapshot = signal<RecordSnapshot | null>(null);
  /** Opening a record failed. */
  readonly failure = signal<Notice | null>(null);
  /** The last successful save, step, action, create, or decision; screens close their form on it. `open` is where an action leads. */
  readonly completed = signal<{ record: RecordView; created: boolean; count: number; open?: string } | null>(null);
  /** The open record as the breadcrumb's last item (number · title), once it has loaded. */
  readonly crumbLabel = computed(() => {
    const spec = this.list.spec();
    const r = this.snapshot();
    return spec && r?.record && !r.loading ? recordCrumb(spec, r.record) : null;
  });

  constructor() {
    effect(() => {
      const spec = this.list.spec();
      untracked(() => {
        this.detach();
        if (!spec) return this.current.set(null);
        const session = new RecordSession(
          this.list.gateway,
          spec,
          () => this.list.viewer(),
          {
            saved: (record, created, open) => {
              if (created) this.list.intents.controller.prependRow(record);
              else this.list.intents.controller.replaceRow(record);
              this.completed.update((c) => ({ record, created, count: (c?.count ?? 0) + 1, ...(open ? { open } : {}) }));
            },
            failed: (message) => {
              this.failure.set({ level: 'error', message });
              this.list.intents.close();
            },
          },
          { spec: (type) => this.specOf(type), people: this.people },
          this.files.uploader,
        );
        this.detach = session.subscribe((s) => this.snapshot.set(s));
        this.current.set(session);
        this.list.runAction = (record, action) => void session.runOn(record, action);
      });
    });
    effect(() => {
      const state = this.list.state();
      const session = this.current();
      if (!state || !session) return;
      untracked(() => void session.follow(state, state.id ? this.list.rows().items.find((r) => r.id === state.id) : undefined));
    });
    const meta = inject(ScreenMeta);
    effect(() => {
      const label = this.crumbLabel();
      untracked(() => meta.crumbLabels.set(label ? { record: label } : {}));
    });
    inject(DestroyRef).onDestroy(() => {
      this.detach();
      meta.clear();
    });
  }

  /** The record session; every record action of every screen goes through it. */
  get session(): RecordSession {
    return this.current()!;
  }

  /** Another record type's list spec, for pickers and related sections; null when the person cannot read it. */
  private specOf(type: string): ListSpec | null {
    const defs = this.app.defs();
    if (this.specs.defs !== defs) this.specs = { defs, byType: new Map() };
    if (!this.specs.byType.has(type)) {
      const t = this.app.recordType(type);
      const spec = t
        ? resolveListSpec(t, this.app.workflow(t.key), defs?.listViews?.[t.key], {
            workflows: this.app.workflows(t.key),
            actions: this.app.actions(t.key),
            startingLayout: defs?.listLayout,
          })
        : null;
      this.specs.byType.set(type, spec);
    }
    return this.specs.byType.get(type)!;
  }
}
