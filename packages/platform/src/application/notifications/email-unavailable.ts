import { PlatformError } from '@onengo/kernel/errors';

/**
 * What a person sees when an email cannot be sent. The wording does not say
 * that email is unset, or name a connector, a server, or a configuration.
 */
export const CONTACT_ADMINISTRATOR = 'This could not be completed. Contact your administrator.';
export const CONTACT_ADMINISTRATOR_KEY = 'ui.common.contactAdministrator';

export function emailUnavailable(): PlatformError {
  return new PlatformError('rule_violation', CONTACT_ADMINISTRATOR, [], CONTACT_ADMINISTRATOR_KEY);
}
