import { Injectable, inject, signal } from '@angular/core';
import { Location } from '@angular/common';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { t } from '../core/i18n/i18n';
import { browserTitle } from '../core/organisation/organisation';
import { asGatewayError } from '../core/records/gateway/gateway';
import { httpGateway } from '../core/records/gateway/http-gateway';
import { canPublishReceiptLink, receiptPage, type ReceiptPage } from '../core/records/print/print';
import { Api } from '../services/api';
import { Organisation } from '../services/organisation';
import { Session } from '../services/session';

/** Loads a receipt for the print view, with the logo its issuer kept, and takes the person back from it. */
@Injectable()
export class PrintStore {
  private readonly gateway = httpGateway(inject(Api));
  private readonly organisation = inject(Organisation);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly title = inject(Title);
  readonly page = signal<ReceiptPage | null>(null);
  /** The issuer's logo as a data URL; the receipt prints without it when it cannot load. */
  readonly logo = signal<string | null>(null);
  /** The kept signature as a data URL. */
  readonly signature = signal<string | null>(null);
  /** The public path, when this receipt has a live link. */
  readonly link = signal<string | null>(null);
  readonly linkBusy = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  private receiptId = '';

  async load(receiptId: string): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.logo.set(null);
    this.signature.set(null);
    this.link.set(null);
    this.receiptId = receiptId;
    try {
      const p = await this.gateway.printReceipt(receiptId);
      const page = receiptPage(p, this.session.recordType(p.record.type));
      this.page.set(page);
      this.link.set(p.publicLink ?? null);
      this.title.setTitle(browserTitle(page.number));
      if (page.issuer.logoUrl) this.logo.set(await this.organisation.image(page.issuer.logoUrl).catch(() => null));
      if (p.issuer?.signatoryImageUrl) this.signature.set(await this.organisation.image(p.issuer.signatoryImageUrl).catch(() => null));
    } catch (e) {
      this.page.set(null);
      this.error.set(asGatewayError(e, t('ui.print.loadFailed')).message);
    } finally {
      this.loading.set(false);
    }
  }

  async createLink(): Promise<string> {
    this.linkBusy.set(true);
    try {
      const { path } = await this.gateway.createReceiptLink(this.receiptId);
      this.link.set(path);
      return path;
    } finally {
      this.linkBusy.set(false);
    }
  }

  async revokeLink(): Promise<void> {
    this.linkBusy.set(true);
    try {
      await this.gateway.revokeReceiptLink(this.receiptId);
      this.link.set(null);
    } finally {
      this.linkBusy.set(false);
    }
  }

  /** Copy and revoke stay hidden unless this person may print the receipt. */
  canManageLink(): boolean {
    const type = this.page()?.record.type;
    return !!type && canPublishReceiptLink(this.session.actions(type));
  }

  /** Back to where the person came from, or to the receipt's record when the view was opened on its own. */
  back(): void {
    const previous = (history.state as { navigationId?: number } | null)?.navigationId ?? 1;
    const record = this.page()?.record;
    if (previous > 1 || !record) this.location.back();
    else void this.router.navigate(['/records', record.type], { queryParams: { id: record.id } });
  }
}
