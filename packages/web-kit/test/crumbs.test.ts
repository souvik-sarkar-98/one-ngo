import { describe, expect, it } from 'vitest';
import { directoryTrail } from '../src/logic/crumbs';

describe('directory breadcrumb', () => {
  const admin = { label: 'Administration', href: '/admin' };

  it('is the destination alone on its home', () => {
    expect(directoryTrail({ label: 'Administration' }, null, [])).toEqual([{ label: 'Administration' }]);
  });

  it('inserts the group and shortens a page that repeats it', () => {
    expect(directoryTrail(admin, { label: 'Organisation', href: '/admin#admin-organisation' }, [{ label: 'Organisation profile' }])).toEqual([
      { label: 'Administration', href: '/admin' },
      { label: 'Organisation', href: '/admin#admin-organisation' },
      { label: 'Profile' },
    ]);
  });

  it('keeps a page that does not repeat the group', () => {
    expect(directoryTrail(admin, { label: 'Organisation', href: '/admin#admin-organisation' }, [{ label: 'Registrations' }]).map((c) => c.label)).toEqual([
      'Administration',
      'Organisation',
      'Registrations',
    ]);
  });

  it('does not repeat a page that has the same name as its group', () => {
    expect(directoryTrail(admin, { label: 'People', href: '/admin#admin-people' }, [{ label: 'People', href: '/admin/people' }, { label: 'Ravi Kumar' }])).toEqual([
      { label: 'Administration', href: '/admin' },
      { label: 'People', href: '/admin/people' },
      { label: 'Ravi Kumar' },
    ]);
  });

  it('links every step except the last', () => {
    const trail = directoryTrail(
      { label: 'Builder', href: '/builder' },
      { label: 'Data', href: '/builder#builder-data' },
      [
        { label: 'Record types', href: '/builder?kind=recordType' },
        { label: 'Donation', href: '/builder/recordType/donation' },
        { label: 'Field: Donor name' },
      ],
    );
    expect(trail.map((c) => c.label)).toEqual(['Builder', 'Data', 'Record types', 'Donation', 'Field: Donor name']);
    expect(trail.at(-1)?.href).toBeUndefined();
    expect(trail[2]).toEqual({ label: 'Record types', href: '/builder?kind=recordType' });
  });
});
