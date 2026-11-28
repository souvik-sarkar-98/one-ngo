import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { matchesQuery, type MailSummary, type MailView } from './model';

/** Reads the sandbox's own `/inbox`, `/inbox/{id}` and `/mail/{id}`. */
@Injectable({ providedIn: 'root' })
export class InboxStore {
  private readonly http = inject(HttpClient);

  readonly messages = signal<MailSummary[]>([]);
  readonly loaded = signal(false);
  readonly problem = signal('');
  readonly query = signal('');
  readonly selectedId = signal<number | null>(null);
  readonly selected = signal<MailView | null>(null);
  readonly raw = signal('');

  readonly visible = computed(() => this.messages().filter((message) => matchesQuery(message, this.query())));

  /** Reloads the list. A selected message that is gone from the inbox is closed. */
  async refresh(): Promise<void> {
    try {
      const body = await firstValueFrom(this.http.get<{ messages: MailSummary[] }>('/inbox'));
      this.messages.set(body.messages);
      this.problem.set('');
      const id = this.selectedId();
      if (id !== null && !body.messages.some((message) => message.id === id)) this.close();
    } catch (error) {
      this.problem.set(`Could not load the inbox: ${describe(error)}`);
    } finally {
      this.loaded.set(true);
    }
  }

  async open(id: number): Promise<void> {
    this.selectedId.set(id);
    try {
      const [view, raw] = await Promise.all([
        firstValueFrom(this.http.get<MailView>(`/inbox/${id}`)),
        firstValueFrom(this.http.get(`/mail/${id}`, { responseType: 'text' })),
      ]);
      if (this.selectedId() !== id) return;
      this.selected.set(view);
      this.raw.set(raw);
      this.problem.set('');
    } catch (error) {
      if (this.selectedId() === id) this.problem.set(`Could not open message ${id}: ${describe(error)}`);
    }
  }

  close(): void {
    this.selectedId.set(null);
    this.selected.set(null);
    this.raw.set('');
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
