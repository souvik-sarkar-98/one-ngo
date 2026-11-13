import type { Suggestion, SuggestionSource } from '../ui-logic/autocomplete';

/** Someone who can be chosen in a person field: an active member of the organisation. */
export interface PersonOption {
  id: string;
  name: string;
  email: string;
}

/** What the person picker needs from the server. The only implementation that talks HTTP is in http-people.ts. */
export interface PeopleGateway {
  /** Active members matching the text by name or email, a few at a time. */
  pick(q: string): Promise<PersonOption[]>;
}

export type MemberStatus = 'active' | 'invited' | 'suspended';
export type TwoStepState = 'on' | 'off' | 'required-not-set';

export interface RoleOption {
  key: string;
  label: string;
}

/**
 * One person in either list. The directory sends only name, email and roles;
 * administrators also get status, two-step state and dates.
 */
export interface PersonItem {
  userId: string;
  displayName: string;
  email: string;
  roles: string[];
  status?: MemberStatus;
  twoStep?: TwoStepState;
  joinedAt?: string;
  invitedAt?: string | null;
  lastSignedInAt?: string | null;
}

export interface PeoplePage {
  items: PersonItem[];
  total: number;
  roles: RoleOption[];
  /** Management only: matches of the search and role filter, by status. */
  counts?: Record<MemberStatus | 'all', number>;
}

export interface PeopleQuery {
  q?: string;
  role?: string[];
  status?: MemberStatus[];
  sort?: string;
  dir?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface AddPersonInput {
  email: string;
  displayName: string;
  roles: string[];
  invite: boolean;
}

/** The People screen's server calls; the only implementation that talks HTTP is in http-people.ts. */
export interface PeopleListGateway {
  directory(query: PeopleQuery): Promise<PeoplePage>;
  members(query: PeopleQuery): Promise<PeoplePage>;
  member(userId: string): Promise<PersonItem>;
  add(input: AddPersonInput): Promise<{ userId: string }>;
  invite(userId: string): Promise<void>;
  suspend(userId: string): Promise<PersonItem>;
  reactivate(userId: string): Promise<PersonItem>;
  setRoles(userId: string, roles: string[]): Promise<PersonItem>;
  addToRole(role: string, userIds: string[]): Promise<void>;
  removeFromRole(role: string, userId: string): Promise<void>;
}

/** Suggestions for a person field: name, with the email as the second line. People are never created from here. */
export function peopleSource(gateway: PeopleGateway): SuggestionSource {
  return {
    minLength: 0,
    search: async (text) => (await gateway.pick(text.trim())).map((p): Suggestion => ({ id: p.id, label: p.name, hint: p.email })),
  };
}
