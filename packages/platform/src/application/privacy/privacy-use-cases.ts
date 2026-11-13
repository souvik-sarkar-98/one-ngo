import type { RequestContext } from '../shared/http-api.js';
import type { ConsentInput, ErasureInput, PrivacyService } from './privacy-service.js';

/** Records that a person (a donor record or a member) granted or withdrew a purpose. Needs privacy:consent:record. */
export class RecordConsent {
  constructor(private readonly privacy: Pick<PrivacyService, 'recordConsent'>) {}

  run(ctx: RequestContext, input: ConsentInput) {
    return this.privacy.recordConsent(ctx, input);
  }
}

/** Erases a data subject by pseudonymisation. Needs privacy:erase; asking again answers with the first erasure. */
export class EraseSubject {
  constructor(private readonly privacy: Pick<PrivacyService, 'erase'>) {}

  async run(ctx: RequestContext, input: ErasureInput) {
    const erasure = await this.privacy.erase(ctx, input);
    return { erasure, created: !erasure.alreadyErased };
  }
}
