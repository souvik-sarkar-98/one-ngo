/** The organisation's name, or undefined when it does not exist. */
export type OrganisationName = (tenantId: string) => Promise<string | undefined>;
