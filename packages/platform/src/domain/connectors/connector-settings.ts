/** Organisation settings that name the email connector and the address it sends from. */
export const MAIL_CONNECTOR_SETTING = 'mail.connector';
export const MAIL_FROM_SETTING = 'mail.from';
/** The storage connector every new upload is written to. */
export const FILE_STORE_SETTING = 'files.storeConnector';

/** The setting keys a connector store reads the mail and file store choices from. */
export const CONNECTOR_SETTINGS = { mailConnector: MAIL_CONNECTOR_SETTING, mailFrom: MAIL_FROM_SETTING, fileStore: FILE_STORE_SETTING } as const;
