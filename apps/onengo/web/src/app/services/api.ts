import { Injectable, inject } from '@angular/core';
import { REFRESH_URL, isAuthUrl } from '../core/auth/http-auth';
import type { ErrorResponse, TokenResponse } from '../core/contracts';
import type { HttpLike } from '../core/http/http';
import { sendWhenOnline } from '../core/http/offline';
import { refusalText } from '../core/http/refusal-text';
import { t } from '../core/i18n/i18n';
import type { Issue } from '../core/models';
import { Connectivity } from '../pwa/connectivity';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: Issue[] = [],
  ) {
    super(message);
  }
}

function tokenExpiry(token: string): number {
  try {
    const body = token.split('.')[1] ?? '';
    const json = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return (json.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

/**
 * Thin fetch wrapper used by the HTTP gateways. The access token lives only in
 * memory; the refresh token is an HttpOnly cookie the browser sends to the
 * refresh address.
 */
@Injectable({ providedIn: 'root' })
export class Api implements HttpLike {
  /** Read by the files transport, which sends raw bytes outside `request`; change it only through `setToken`. */
  token: string | null = null;
  private readonly connectivity = inject(Connectivity);
  private refreshing: Promise<boolean> | null = null;
  private readonly writeListeners = new Set<(method: string, url: string) => void>();

  /** Calls `listener` after every successful request that is not a GET. */
  onWrite(listener: (method: string, url: string) => void): () => void {
    this.writeListeners.add(listener);
    return () => this.writeListeners.delete(listener);
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  get hasToken(): boolean {
    return !!this.token;
  }

  /** Gets a fresh access token from the refresh cookie. Concurrent callers share one request. */
  refresh(): Promise<boolean> {
    this.refreshing ??= fetch(REFRESH_URL, { method: 'POST', credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) {
          this.token = null;
          return false;
        }
        this.token = ((await res.json()) as TokenResponse).accessToken;
        return true;
      })
      .catch(() => false)
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  get<T>(url: string): Promise<T> {
    return this.request<T>('GET', url);
  }
  post<T>(url: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', url, body ?? {});
  }
  put<T>(url: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', url, body);
  }
  patch<T>(url: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', url, body);
  }
  delete<T>(url: string): Promise<T> {
    return this.request<T>('DELETE', url);
  }

  async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.send(method, url, body);
    if (res.status === 204) return undefined as T;
    return (await res.json().catch(() => ({}))) as T;
  }

  /** The response itself, for answers that are not JSON; a Blob body is sent as it is. Failures are thrown as ApiError. */
  async send(method: string, url: string, body?: unknown, extra: Record<string, string> = {}, retried = false): Promise<Response> {
    const isAuth = isAuthUrl(url);
    if (!isAuth && this.token && tokenExpiry(this.token) - Date.now() < 30_000) await this.refresh();
    const file = body instanceof Blob;
    const headers: Record<string, string> = { ...extra };
    if (body !== undefined) headers['content-type'] = file ? body.type || 'application/octet-stream' : 'application/json';
    if (this.token && !isAuth) headers['authorization'] = `Bearer ${this.token}`;
    const attempt = async (): Promise<Response> => {
      try {
        return await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : file ? body : JSON.stringify(body),
          credentials: 'same-origin',
        });
      } catch {
        throw new ApiError(0, 'offline', t('ui.common.offline'));
      }
    };
    const res = method === 'GET' ? await attempt() : await sendWhenOnline(attempt, () => this.connectivity.reconnects());
    if (res.ok) {
      if (method !== 'GET') this.writeListeners.forEach((l) => l(method, url));
      return res;
    }
    const data = (await res.json().catch(() => ({}))) as Partial<ErrorResponse>;
    if (res.status === 403 && !retried && !isAuth && /Sign in|session/i.test(data.message ?? '')) {
      if (await this.refresh()) return this.send(method, url, body, extra, true);
    }
    throw new ApiError(res.status, data.code ?? 'error', refusalText(data, t('ui.common.somethingWentWrong')), data.issues ?? []);
  }
}
