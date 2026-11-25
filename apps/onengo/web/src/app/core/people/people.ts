import type { Suggestion, SuggestionSource } from '../ui-logic/autocomplete';

/** Someone who can be chosen in a person field: an active member of the organisation. */
export interface PersonOption {
  id: string;
  name: string;
  email: string;
  /** When they joined the organisation, ISO 8601. */
  joinedAt?: string;
}

/** Narrows the picker. `email` finds the one person with exactly that email; `includeInvited` also finds invited people. */
export interface PickOptions {
  email?: string;
  includeInvited?: boolean;
}

/** What the person picker needs from the server. The only implementation that talks HTTP is in http-people.ts. */
export interface PeopleGateway {
  /** Members matching the text by name or email, a few at a time; active members only unless `options.includeInvited`. */
  pick(q: string, options?: PickOptions): Promise<PersonOption[]>;
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

/** A person suggestion, carrying the person so a field that follows the account can be filled at once. */
export interface PersonSuggestion extends Suggestion {
  person: PersonOption;
}

/**
 * Suggestions for a person field: name, with the email as the second line. People are never created from here.
 * With `emailOf`, the suggestions are only the person whose email is that value (invited people included); none while it is blank.
 */
export function peopleSource(gateway: PeopleGateway, emailOf?: () => string): SuggestionSource {
  const suggest = (people: PersonOption[]) => people.map((p): PersonSuggestion => ({ id: p.id, label: p.name, hint: p.email, person: p }));
  return {
    minLength: 0,
    search: async (text) => {
      if (!emailOf) return suggest(await gateway.pick(text.trim()));
      const email = emailOf().trim();
      return email ? suggest(await gateway.pick('', { email, includeInvited: true })) : [];
    },
  };
}
