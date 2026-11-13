import { Injectable, signal } from '@angular/core';
import type {
  OperatorAccountContract, OperatorActionContract, OperatorActivityContract, OperatorCreateRequest, OperatorDisableRequest,
  OperatorGrantsRequest, OperatorLifecycleRequest, OperatorListContract, OperatorOnboardRequest, OperatorOnboardResult, OperatorOrganisationListContract,
  OperatorProviderCheckContract, OperatorProviderPolicyRequest, OperatorProviderRequest, OperatorRelinkRequest,
  OperatorSessionContract, OperatorSignInChange, OperatorSignInContract, OperatorSignInPolicyRequest, OperatorStatusContract,
  OperatorStepUpActionContract,
} from '@onengo/platform/contracts';
import { safeNext } from '@onengo/web-kit';

export class OperatorRequestError extends Error {
  constructor(message: string, readonly problems: string[] = []) { super(message); }
}

@Injectable({ providedIn: 'root' })
export class OperatorApi {
  readonly session = signal<OperatorSessionContract | null>(null);
  private async request<T>(path: string, init: RequestInit = {}, parse: 'json' | 'text' = 'json'): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set('content-type', 'application/json');
    if (init.method && init.method !== 'GET') {
      const csrf = this.session()?.csrfToken;
      if (csrf) headers.set('x-csrf-token', csrf);
    }
    const response = await fetch(`/op${path}`, { ...init, headers, credentials: 'same-origin' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ message: response.statusText })) as { message?: string; issues?: { message?: string }[] };
      const problems = (body.issues ?? []).flatMap((issue) => issue.message ? [issue.message] : []);
      throw new OperatorRequestError(body.message ?? `Request failed (${response.status}).`, problems);
    }
    if (response.status === 204) return undefined as T;
    return (parse === 'text' ? response.text() : response.json()) as Promise<T>;
  }
  async loadSession(): Promise<OperatorSessionContract> {
    const value = await this.request<OperatorSessionContract>('/auth/session');
    this.session.set(value);
    return value;
  }
  can(action: OperatorActionContract): boolean { return this.session()?.actions.includes(action) === true; }
  signIn(next = location.pathname): void { location.assign(`/op/auth/login?next=${encodeURIComponent(safeNext(next))}`); }
  async logout(): Promise<void> { await this.request('/auth/logout', { method: 'POST' }); this.session.set(null); location.assign('/sign-in'); }
  organisations(query: { q?: string; status?: string } = {}): Promise<OperatorOrganisationListContract> {
    const search = new URLSearchParams();
    if (query.q) search.set('q', query.q);
    if (query.status) search.set('status', query.status);
    const suffix = search.toString();
    return this.request(`/organisations${suffix ? `?${suffix}` : ''}`);
  }
  status(ref: { code?: string; requestId?: string }): Promise<OperatorStatusContract> {
    const query = new URLSearchParams(Object.entries(ref).filter((entry): entry is [string, string] => !!entry[1]));
    return this.request(`/organisations/status?${query}`);
  }
  onboard(body: OperatorOnboardRequest): Promise<OperatorOnboardResult> { return this.request('/organisations/onboard', { method: 'POST', body: JSON.stringify(body) }); }
  retry(requestId: string): Promise<unknown> { return this.request(`/organisations/${encodeURIComponent(requestId)}/retry`, { method: 'POST', body: '{}' }); }
  lifecycle(action: OperatorStepUpActionContract, code: string, body: OperatorLifecycleRequest): Promise<unknown> {
    return this.request(`/organisations/${encodeURIComponent(code)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
  }
  organisationSignIn(code: string): Promise<OperatorSignInContract> { return this.request(`/organisations/${encodeURIComponent(code)}/sign-in`); }
  saveSignInPolicy(code: string, body: OperatorSignInPolicyRequest): Promise<OperatorSignInContract> {
    return this.request(`/organisations/${encodeURIComponent(code)}/sign-in/policy`, { method: 'PUT', body: JSON.stringify(body) });
  }
  saveProvider(code: string, id: string, body: OperatorProviderRequest): Promise<OperatorSignInContract> {
    return this.request(this.providerPath(code, id), { method: 'PUT', body: JSON.stringify(body) });
  }
  removeProvider(code: string, id: string, body: OperatorSignInChange): Promise<OperatorSignInContract> {
    return this.request(this.providerPath(code, id), { method: 'DELETE', body: JSON.stringify(body) });
  }
  saveProviderPolicy(code: string, id: string, body: OperatorProviderPolicyRequest): Promise<OperatorSignInContract> {
    return this.request(`${this.providerPath(code, id)}/policy`, { method: 'PUT', body: JSON.stringify(body) });
  }
  testProvider(code: string, id: string): Promise<OperatorProviderCheckContract> {
    return this.request(`${this.providerPath(code, id)}/test`, { method: 'POST', body: '{}' });
  }
  private providerPath(code: string, id: string): string {
    return `/organisations/${encodeURIComponent(code)}/sign-in/providers/${encodeURIComponent(id)}`;
  }
  operators(query: { q?: string; status?: string } = {}): Promise<OperatorListContract> {
    const search = new URLSearchParams();
    if (query.q) search.set('q', query.q);
    if (query.status) search.set('status', query.status);
    const suffix = search.toString();
    return this.request(`/operators${suffix ? `?${suffix}` : ''}`);
  }
  operator(id: string): Promise<OperatorAccountContract> { return this.request(`/operators/${encodeURIComponent(id)}`); }
  createOperator(body: OperatorCreateRequest): Promise<OperatorAccountContract> {
    return this.request('/operators', { method: 'POST', body: JSON.stringify(body) });
  }
  saveGrants(id: string, body: OperatorGrantsRequest): Promise<OperatorAccountContract> {
    return this.request(`/operators/${encodeURIComponent(id)}/grants`, { method: 'PUT', body: JSON.stringify(body) });
  }
  relinkOperator(id: string, body: OperatorRelinkRequest): Promise<OperatorAccountContract> {
    return this.request(`/operators/${encodeURIComponent(id)}/login`, { method: 'PUT', body: JSON.stringify(body) });
  }
  disableOperator(id: string, body: OperatorDisableRequest): Promise<OperatorAccountContract> {
    return this.request(`/operators/${encodeURIComponent(id)}/disable`, { method: 'POST', body: JSON.stringify(body) });
  }
  activity(query: { q?: string; action?: string; from?: string; to?: string; limit?: number } = {}): Promise<OperatorActivityContract> {
    return this.request(`/audit?${activityQuery(query)}`);
  }
  activityCsv(query: { q?: string; action?: string; from?: string; to?: string } = {}): Promise<string> {
    return this.request(`/audit.csv?${activityQuery(query)}`, {}, 'text');
  }
  async stepUp(action: OperatorStepUpActionContract, target: string, returnPath: string): Promise<void> {
    const result = await this.request<{ redirect: string }>('/auth/step-up', { method: 'POST', body: JSON.stringify({ action, target, returnPath }) });
    location.assign(result.redirect);
  }
}

function activityQuery(query: { q?: string; action?: string; from?: string; to?: string; limit?: number }): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
}
