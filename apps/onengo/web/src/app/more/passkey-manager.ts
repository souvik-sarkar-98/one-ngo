import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { createPasskey, passkeysSupported } from '../core/auth/passkey';
import { t } from '../core/i18n/i18n';
import { ApiError } from '../services/api';
import { I18n, TranslatePipe } from '../services/i18n';
import { Passkeys, type PasskeyInfo } from '../services/passkeys';
import { MobileFormSheet } from '../ui/form-panel';
import { Btn } from '@onengo/web-kit';

/**
 * The person's passkeys, opened from the Preferences row: list, save on this
 * device, and remove. Changes ask for the password and authenticator code once two-step is on.
 */
@Component({
  selector: 'app-passkey-manager',
  imports: [Btn, TranslatePipe, MobileFormSheet],
  host: { '[class.passkeys--open]': 'open()' },
  styles: `
    :host {
      display: none;
    }
    :host(.passkeys--open) {
      display: contents;
    }
    .passkeys__lead {
      margin: 0 0 10px;
      font-size: 0.85rem;
    }
    .passkeys__list {
      margin: 0 0 12px;
      padding: 0;
      list-style: none;
    }
    .passkeys__row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 48px;
      padding: 8px 0;
      border-top: 1px solid var(--line);
    }
    .passkeys__name {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .passkeys__note {
      margin: 8px 0 0;
      font-size: 0.8rem;
    }
  `,
  template: `
    <app-mobile-form-sheet [open]="open()" [title]="'ui.passkeys.title' | t" [showDefaultFooter]="false" (dismissed)="closed.emit()">
      <p class="muted passkeys__lead">{{ 'ui.passkeys.hint' | t }}</p>
      @if (error()) { <div class="notice error" role="alert">{{ error() }}</div> }
      @if (info()) { <div class="notice info" role="status">{{ info() }}</div> }

      @if (loading()) {
        <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
      } @else if (!list().length) {
        <p class="muted">{{ 'ui.passkeys.none' | t }}</p>
      } @else {
        <ul class="passkeys__list">
          @for (p of list(); track p.id) {
            <li class="passkeys__row">
              <span class="passkeys__name">
                <strong>{{ p.name }}</strong>
                <span class="muted">{{ (p.deviceType === 'multiDevice' ? 'ui.passkeys.synced' : 'ui.passkeys.thisDevice') | t }}</span>
              </span>
              <button appBtn="link" type="button" [disabled]="busy()" (click)="remove(p)">{{ 'ui.passkeys.remove' | t }}</button>
            </li>
          }
        </ul>
      }

      @if (supported()) {
        <form (submit)="add($event)">
          <div class="field">
            <label for="passkey-name">{{ 'ui.passkeys.name' | t }}</label>
            <input id="passkey-name" name="passkeyName" maxlength="60" [value]="name()" [placeholder]="'ui.passkeys.namePlaceholder' | t" (input)="name.set(value($event))" />
          </div>
          @if (twoStep()) {
            <div class="field">
              <label for="passkey-password">{{ 'ui.auth.password' | t }}</label>
              <input id="passkey-password" name="passkeyPassword" type="password" autocomplete="current-password" [value]="password()" (input)="password.set(value($event))" required />
            </div>
            <div class="field">
              <label for="passkey-code">{{ 'ui.auth.totp' | t }}</label>
              <input id="passkey-code" name="passkeyCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" [value]="code()" (input)="code.set(value($event))" required />
            </div>
            <p class="muted passkeys__note">{{ 'ui.passkeys.reauthHint' | t }}</p>
          }
          <div class="acts">
            <button appBtn="primary" type="submit" [disabled]="busy()">{{ 'ui.passkeys.add' | t }}</button>
          </div>
        </form>
      } @else {
        <p class="muted passkeys__note">{{ 'ui.passkeys.unsupported' | t }}</p>
      }
    </app-mobile-form-sheet>
  `,
})
export class PasskeyManager implements OnInit {
  private readonly passkeys = inject(Passkeys);
  private readonly i18n = inject(I18n);

  /** Whether changes to sign-in need the password and an authenticator code. */
  readonly twoStep = input(false);
  /** The Preferences row opens this sheet. */
  readonly open = input(false);
  readonly closed = output<void>();

  readonly list = signal<PasskeyInfo[]>([]);
  readonly loading = signal(true);
  readonly supported = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly info = signal('');
  readonly name = signal('');
  readonly password = signal('');
  readonly code = signal('');
  /** Status on the Preferences row: nothing saved yet, or how many are saved. */
  readonly summary = computed(() => {
    const count = this.list().length;
    if (this.loading() || count === 0) return this.i18n.t('ui.passkeys.none');
    return this.i18n.t('ui.passkeys.saved', { count });
  });

  async ngOnInit(): Promise<void> {
    this.supported.set(await passkeysSupported());
    await this.load();
  }

  value(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  async add(e: Event): Promise<void> {
    e.preventDefault();
    await this.run(async () => {
      const begun = await this.passkeys.begin(this.reauth());
      const response = await createPasskey(begun.options);
      await this.passkeys.confirm(begun.challengeId, response, this.name().trim() || undefined);
      this.name.set('');
      this.info.set(t('ui.passkeys.added'));
      await this.load();
    });
  }

  async remove(p: PasskeyInfo): Promise<void> {
    await this.run(async () => {
      await this.passkeys.revoke(p.id, this.reauth());
      this.info.set(t('ui.passkeys.removed'));
      await this.load();
    });
  }

  private reauth() {
    return this.twoStep() ? { password: this.password(), totpCode: this.code().trim() } : {};
  }

  private async load(): Promise<void> {
    try {
      this.list.set(await this.passkeys.list());
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : t('ui.passkeys.failed'));
    } finally {
      this.loading.set(false);
    }
  }

  /** Runs one change; a cancelled browser prompt leaves things as they were. */
  private async run(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.info.set('');
    try {
      await action();
      this.password.set('');
      this.code.set('');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') return;
      this.error.set(err instanceof ApiError ? err.message : t('ui.passkeys.failed'));
    } finally {
      this.busy.set(false);
    }
  }
}
