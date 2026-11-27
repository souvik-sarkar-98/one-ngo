import { describe, expect, it } from 'vitest';
import type { PeopleGateway, PersonOption } from '../../../../../../apps/onengo/web/src/app/core/people/people';
import { peopleSource } from '../../../../../../apps/onengo/web/src/app/core/people/people';

const ravi: PersonOption = { id: 'u1', name: 'Ravi Kumar', email: 'ravi@x.org' };

/** A gateway that records what the picker asked for and answers with people. */
function recorder(people: PersonOption[]) {
  const asked: { q: string; options?: unknown }[] = [];
  const gateway: PeopleGateway = {
    pick: async (q, options) => {
      asked.push({ q, options });
      return people;
    },
  };
  return { gateway, asked };
}

describe('peopleSource for a person field', () => {
  it('searches by the typed text, active members only, when the field has no email to follow', async () => {
    const { gateway, asked } = recorder([ravi]);
    const suggestions = await peopleSource(gateway).search(' ravi ');
    expect(asked).toEqual([{ q: 'ravi', options: undefined }]);
    expect(suggestions).toEqual([{ id: 'u1', label: 'Ravi Kumar', hint: 'ravi@x.org', person: ravi }]);
  });

  it('shows only the person with the requester email, invited people included, and ignores the typed text', async () => {
    const { gateway, asked } = recorder([ravi]);
    let email = 'ravi@x.org';
    const source = peopleSource(gateway, () => email);
    const suggestions = await source.search('zzz');
    expect(asked).toEqual([{ q: '', options: { email: 'ravi@x.org', includeInvited: true } }]);
    expect(suggestions.map((s) => s.id)).toEqual(['u1']);
    // A blank email offers nobody and asks the server nothing.
    email = '  ';
    expect(await source.search('')).toEqual([]);
    expect(asked).toHaveLength(1);
  });
});
