/**
 * Organisation setting holding the named fixed recipients scripts may notify,
 * as `{ [name]: { label?, email?, phone? } }`. Only administrators change it.
 */
export const NAMED_RECIPIENTS_SETTING = 'notify.namedRecipients';

export interface NamedRecipient {
  label?: string;
  email?: string;
  phone?: string;
}
