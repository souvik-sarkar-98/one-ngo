import type { PrivacyService } from './privacy-service.js';
import type { EraseSubject, RecordConsent } from './privacy-use-cases.js';

/** One consent event: a purpose granted or withdrawn by a record (a donor) or a member. */
export type { ConsentInput } from './privacy-service.js';
/** Erases a data subject by pseudonymisation; asking again returns the first result. */
export type { ErasureInput } from './privacy-service.js';

/** Consent records and erasure of data subjects. */
export interface PrivacyApi {
  recordConsent: RecordConsent;
  eraseSubject: EraseSubject;
  consent: Pick<PrivacyService, 'consent'>;
}
