/** Seeded Riverbank members. Password matches the functional test load; override with E2E_PASSWORD. */

export const org = process.env.E2E_ORG ?? 'riverbank';

export const password = process.env.E2E_PASSWORD ?? 'Password@01';

export const apiBase = process.env.API_BASE_URL ?? 'http://localhost:8080';

export const accounts = {
  admin: { email: 'asha@riverbank.example', name: 'Asha Menon' },
  finance: { email: 'finance@riverbank.example', name: 'Finance Member' },
  viewer: { email: 'viewer@riverbank.example', name: 'Viewer Member' },
  peopleAdmin: { email: 'people@riverbank.example', name: 'People Administrator' },
  rolesAdmin: { email: 'roles@riverbank.example', name: 'Roles Administrator' },
  config: { email: 'config@riverbank.example', name: 'Config Author' },
  directory: { email: 'directory@riverbank.example', name: 'Directory Member' },
  noAccess: { email: 'noaccess@riverbank.example', name: 'No Access Member' },
} as const;
