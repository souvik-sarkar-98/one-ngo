import { contracted, type AddMemberRequest, type MemberRolesRequest, type RoleMembersRequest } from '../contracts';
import type { HttpLike } from '../http/http';
import type { PeopleGateway, PeopleListGateway, PeoplePage, PeopleQuery, PersonItem, PersonOption } from './people';

/** The people API over HTTP, as far as the person picker needs it. */
export function httpPeople(http: HttpLike): PeopleGateway {
  return {
    pick: async (q) => (await http.get<{ items: PersonOption[] }>(`/api/people?pick=1&limit=8&q=${encodeURIComponent(q)}`)).items,
  };
}

function queryString(q: PeopleQuery): string {
  const p = new URLSearchParams();
  if (q.q) p.set('q', q.q);
  for (const r of q.role ?? []) p.append('role', r);
  for (const s of q.status ?? []) p.append('status', s);
  if (q.sort) p.set('sort', q.sort);
  if (q.dir) p.set('dir', q.dir);
  p.set('limit', String(q.limit));
  p.set('offset', String(q.offset));
  return p.toString();
}

const member = (id: string) => `/api/admin/people/${encodeURIComponent(id)}`;

/** The members routes with fixed contracts. */
export interface PeopleRoutes {
  'POST /api/admin/people': { body: AddMemberRequest; answer: { userId: string } };
  'PUT /api/admin/people/:userId/roles': { body: MemberRolesRequest; answer: PersonItem };
  'POST /api/admin/roles/:key/members': { body: RoleMembersRequest; answer: void };
}

/** The directory, the members list and what administrators do to people, over HTTP. */
export function httpPeopleList(http: HttpLike): PeopleListGateway {
  const send = contracted<PeopleRoutes>(http);
  return {
    directory: (q) => http.get<PeoplePage>(`/api/people?${queryString(q)}`),
    members: (q) => http.get<PeoplePage>(`/api/admin/people?${queryString(q)}`),
    member: (id) => http.get<PersonItem>(member(id)),
    add: (input) => send('POST /api/admin/people', input),
    invite: (id) => http.post<void>(`${member(id)}/invite`),
    suspend: (id) => http.post<PersonItem>(`${member(id)}/suspend`),
    reactivate: (id) => http.post<PersonItem>(`${member(id)}/reactivate`),
    setRoles: (userId, roles) => send('PUT /api/admin/people/:userId/roles', { userId }, { roles }),
    addToRole: async (key, userIds) => {
      await send('POST /api/admin/roles/:key/members', { key }, { userIds });
    },
    removeFromRole: (role, id) => http.delete<void>(`/api/admin/roles/${encodeURIComponent(role)}/members/${encodeURIComponent(id)}`),
  };
}
