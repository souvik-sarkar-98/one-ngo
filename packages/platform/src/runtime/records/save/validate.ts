import { validationFailed } from '@onengo/kernel/errors';
import type { Tx } from '../../../domain/ports/transaction.js';
import { personFieldIssues } from '../person-fields.js';
import { validateRecordData } from '../validator.js';
import type { SaveContext } from './context.js';

/** Field types, required fields and person fields. */
export async function validate(tx: Tx, s: SaveContext): Promise<void> {
  const validation = validateRecordData(s.type, s.loaded.type.version, s.data, s.requiredFields, s.hidden);
  if (validation.length) throw validationFailed('Some fields are not valid.', validation);
  const people = await personFieldIssues(s.services.people, tx, s.type, s.data, s.previous);
  if (people.length) throw validationFailed('Some fields are not valid.', people);
}
