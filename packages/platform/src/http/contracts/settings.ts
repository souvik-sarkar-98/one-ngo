import { schemaOf } from './schema.js';

/** Changes only the settings sent. */
export interface SettingsRequest {
  /** The display name. */
  name?: string;
  legalName?: string;
  defaultLanguage?: string;
  storageQuotaBytes?: number;
  apiRequestsPerMinute?: number;
  /** Exact http or https origins, at most 10, that may read this organisation's data feeds from a browser. */
  corsOrigins?: string[];
  /** 1 (January) to 12. */
  financialYearStartMonth?: number;
  /** Fixed recipients scripts may notify by name, such as the auditor; replaces the whole list. */
  namedRecipients?: Record<string, NamedRecipientRequest>;
  /** Key of an enabled HTTP connector in send mode, or null to send no email through a connector. */
  mailConnector?: string | null;
  /** The address that connector sends from. Required when a connector is chosen. */
  mailFrom?: string | null;
  /** Key of an enabled storage connector. New uploads go there. */
  fileStoreConnector?: string;
  /** The message template each sign-in email uses. Sent in full: a purpose sent as null, or left out, keeps the default wording. */
  emailTemplates?: SignInEmailTemplatesRequest;
}

export interface SignInEmailTemplatesRequest {
  sign_in_code?: string | null;
  password_reset?: string | null;
  invite?: string | null;
}

export interface NamedRecipientRequest {
  label?: string;
  email?: string;
  phone?: string;
}

const whole = { type: 'integer', nullable: true } as const;
const templateKey = { type: 'string', nullable: true } as const;

export const settingsRequest = schemaOf<SettingsRequest>({
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', nullable: true },
    legalName: { type: 'string', nullable: true },
    defaultLanguage: { type: 'string', nullable: true },
    storageQuotaBytes: whole,
    apiRequestsPerMinute: whole,
    corsOrigins: { type: 'array', nullable: true, maxItems: 10, items: { type: 'string' } },
    financialYearStartMonth: whole,
    mailConnector: { anyOf: [{ type: 'string' }, { type: 'null', nullable: true }], nullable: true },
    mailFrom: { anyOf: [{ type: 'string' }, { type: 'null', nullable: true }], nullable: true },
    fileStoreConnector: { type: 'string', nullable: true },
    emailTemplates: {
      type: 'object',
      nullable: true,
      additionalProperties: false,
      properties: { sign_in_code: templateKey, password_reset: templateKey, invite: templateKey },
    },
    namedRecipients: {
      type: 'object',
      nullable: true,
      maxProperties: 20,
      required: [],
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', nullable: true },
          email: { type: 'string', nullable: true },
          phone: { type: 'string', nullable: true },
        },
      },
    },
  },
});
