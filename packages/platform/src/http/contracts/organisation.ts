import { schemaOf } from './schema.js';

/** Changes only the parts sent; an empty text clears an optional contact field. The address is replaced whole. */
export interface OrganisationProfileRequest {
  contact?: { email?: string; phone?: string; website?: string };
  address?: { line1: string; line2?: string; city: string; state?: string; postalCode: string; country: string };
  /** e.g. Asia/Kolkata. */
  timezone?: string;
}

const optionalText = { type: 'string', nullable: true } as const;

export const organisationProfileRequest = schemaOf<OrganisationProfileRequest>({
  type: 'object',
  additionalProperties: false,
  properties: {
    contact: {
      type: 'object',
      nullable: true,
      required: [],
      additionalProperties: false,
      properties: { email: optionalText, phone: optionalText, website: optionalText },
    },
    address: {
      type: 'object',
      nullable: true,
      required: ['line1', 'city', 'postalCode', 'country'],
      additionalProperties: false,
      properties: {
        line1: { type: 'string' },
        line2: optionalText,
        city: { type: 'string' },
        state: optionalText,
        postalCode: { type: 'string' },
        country: { type: 'string' },
      },
    },
    timezone: optionalText,
  },
});

/** The authorised signatory's name and designation. */
export interface SignatoryRequest {
  name: string;
  designation: string;
}

export const signatoryRequest = schemaOf<SignatoryRequest>({
  type: 'object',
  required: ['name', 'designation'],
  additionalProperties: false,
  properties: { name: { type: 'string' }, designation: { type: 'string' } },
});

export interface RegistrationRequest {
  /** e.g. `trust`, `12a`, `80g`, `fcra`, `pan`. */
  type: string;
  number: string;
  issuingAuthority?: string;
  /** ISO dates. */
  issuedOn?: string;
  expiresOn?: string;
  notes?: string;
}

export const registrationRequest = schemaOf<RegistrationRequest>({
  type: 'object',
  required: ['type', 'number'],
  additionalProperties: false,
  properties: {
    type: { type: 'string' },
    number: { type: 'string' },
    issuingAuthority: optionalText,
    issuedOn: optionalText,
    expiresOn: optionalText,
    notes: optionalText,
  },
});
