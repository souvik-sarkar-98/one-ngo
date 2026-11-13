import type { HttpLike } from '../http/http';
import type { OrganisationBranding, OrganisationGateway, OrganisationView, Registration, SetupChecklist, SignInOrganisation } from './organisation';

const enc = encodeURIComponent;

/** The app's HTTP client, plus the bytes of an image that needs the sign-in. */
export interface OrganisationHttp extends HttpLike {
  blob(url: string): Promise<Blob>;
}

export function httpOrganisation(http: OrganisationHttp): OrganisationGateway {
  const registration = (id: string) => `/api/admin/organisation/registrations/${enc(id)}`;
  return {
    signInOrganisation: (code) => http.get<SignInOrganisation>(`/api/auth/organisations/${enc(code)}`),
    branding: () => http.get<OrganisationBranding>('/api/organisation'),
    view: () => http.get<OrganisationView>('/api/admin/organisation'),
    saveProfile: (change) => http.put<OrganisationView>('/api/admin/organisation/profile', change),
    saveLegalName: async (legalName) => {
      await http.put('/api/admin/settings', { legalName });
    },
    addRegistration: (body) => http.post<Registration>('/api/admin/organisation/registrations', body),
    updateRegistration: (id, body) => http.put<Registration>(registration(id), body),
    removeRegistration: (id) => http.delete<void>(registration(id)),
    setLogo: (file) => http.put<OrganisationView>('/api/admin/organisation/logo', file),
    removeLogo: () => http.delete<void>('/api/admin/organisation/logo'),
    saveSignatory: (body) => http.put<OrganisationView>('/api/admin/organisation/signatory', body),
    setSignature: (file) => http.put<OrganisationView>('/api/admin/organisation/signatory/image', file),
    removeSignatory: () => http.delete<void>('/api/admin/organisation/signatory'),
    setup: () => http.get<SetupChecklist>('/api/admin/organisation/setup'),
    confirmSetup: (step) => http.post<SetupChecklist>(`/api/admin/organisation/setup/${enc(step)}/confirm`),
    image: (url) => http.blob(url),
  };
}
