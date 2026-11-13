import type { RequestContext } from '../shared/http-api.js';
import type { ActionService } from './action-service.js';
import type { ReceiptPrintService } from './receipt-print.js';

/** Runs a record's configured action: the person's input and the version they saw. */
export class RunAction {
  constructor(private readonly actions: Pick<ActionService, 'run'>) {}

  run(ctx: RequestContext, type: string, recordId: string, key: string, body: Parameters<ActionService['run']>[4]) {
    return this.actions.run(ctx, type, recordId, key, body);
  }
}

/** A receipt as the print view shows it. */
export class PrintReceipt {
  constructor(private readonly printView: Pick<ReceiptPrintService, 'receipt'>) {}

  run(ctx: RequestContext, receiptId: string) {
    return this.printView.receipt(ctx, receiptId);
  }
}
