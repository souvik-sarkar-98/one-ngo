import { Injectable, inject } from '@angular/core';
import { isImage, type FileInfo, type UploadTarget } from '../core/fields/files';
import type { BinaryHttpLike, BinaryResponse } from '../core/http/http';
import { httpFiles } from '../core/http/http-files';
import { t } from '../core/i18n/i18n';
import type { Issue } from '../core/models';
import { Api, ApiError } from './api';

function parse(text: string): { code?: string; message?: string; issues?: Issue[] } {
  try {
    return JSON.parse(text) as { code?: string; message?: string; issues?: Issue[] };
  } catch {
    return {};
  }
}

const failure = (status: number, data: { code?: string; message?: string; issues?: Issue[] }) =>
  new ApiError(status, data.code ?? 'error', data.message ?? t('ui.common.somethingWentWrong'), data.issues ?? []);

/** Raw bytes over the app's session: XMLHttpRequest for uploads, because fetch cannot report upload progress. */
class Transport implements BinaryHttpLike {
  constructor(private readonly api: Api) {}

  async upload<T>(url: string, body: Blob, headers: Record<string, string>, progress?: (fraction: number) => void, signal?: AbortSignal, retried = false): Promise<T> {
    const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      for (const [k, v] of Object.entries({ ...headers, ...this.auth() })) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => progress?.(e.lengthComputable && e.total ? e.loaded / e.total : 0);
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
      xhr.onerror = () => reject(new ApiError(0, 'offline', t('ui.common.offline')));
      xhr.onabort = () => reject(new ApiError(0, 'aborted', t('ui.common.cancel')));
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(body);
    });
    const data = parse(res.text);
    if (await this.expired(res.status, data.message, retried)) return this.upload<T>(url, body, headers, progress, signal, true);
    if (res.status < 200 || res.status >= 300) throw failure(res.status, data);
    return data as T;
  }

  async bytes(url: string, method: 'GET' | 'HEAD' = 'GET', retried = false): Promise<BinaryResponse> {
    let res: Response;
    try {
      res = await fetch(url, { method, headers: this.auth(), credentials: 'same-origin' });
    } catch {
      throw new ApiError(0, 'offline', t('ui.common.offline'));
    }
    if (!res.ok) {
      const data = method === 'HEAD' ? parse('') : parse(await res.text().catch(() => ''));
      if (await this.expired(res.status, data.message, retried)) return this.bytes(url, method, true);
      throw failure(res.status, data);
    }
    const blob = method === 'HEAD' ? new Blob([]) : await res.blob();
    return { blob, header: (name) => res.headers.get(name) };
  }

  private auth(): Record<string, string> {
    return this.api.token ? { authorization: `Bearer ${this.api.token}` } : {};
  }

  /** The session ran out: refresh once and try again. A HEAD response has no message, so any refusal counts. */
  private async expired(status: number, message: string | undefined, retried: boolean): Promise<boolean> {
    return status === 403 && !retried && (message === undefined || /Sign in|session/i.test(message)) && (await this.api.refresh());
  }
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Files for the field controls: uploads with progress, names and sizes,
 * image previews, opening and downloading. Previews of images are data URLs
 * (the content security policy allows data: images, not blob: ones); PDFs open
 * in the browser's own viewer in a new tab, because the policy keeps frames
 * and objects to the app itself.
 */
@Injectable({ providedIn: 'root' })
export class Files {
  private readonly gateway = httpFiles(new Transport(inject(Api)));
  private readonly infos = new Map<string, Promise<FileInfo>>();
  private readonly images = new Map<string, Promise<string>>();

  /** The gateway's uploader, for the record session to send drawn signatures on save. */
  readonly uploader = this.gateway;

  async upload(file: Blob, name: string, target?: UploadTarget, progress?: (fraction: number) => void, signal?: AbortSignal): Promise<FileInfo> {
    const info = await this.gateway.upload(file, name, target, progress, signal);
    this.infos.set(info.id, Promise.resolve(info));
    return info;
  }

  info(id: string): Promise<FileInfo> {
    let p = this.infos.get(id);
    if (!p) {
      p = this.gateway.info(id);
      p.catch(() => this.infos.delete(id));
      this.infos.set(id, p);
    }
    return p;
  }

  /** An image file as a data URL for <img>; kept while the app runs. */
  image(id: string): Promise<string> {
    let p = this.images.get(id);
    if (!p) {
      p = this.gateway.download(id).then(({ info, blob }) => {
        if (!isImage(info)) throw new ApiError(415, 'not_image', t('ui.common.somethingWentWrong'));
        return dataUrl(blob);
      });
      p.catch(() => this.images.delete(id));
      this.images.set(id, p);
    }
    return p;
  }

  /** A local address for a file's bytes, to open in the browser's viewer; release it with `release`. */
  async objectUrl(id: string): Promise<string> {
    const { blob } = await this.gateway.download(id);
    return URL.createObjectURL(blob);
  }

  release(url: string): void {
    URL.revokeObjectURL(url);
  }

  /** Opens an address made by `objectUrl` in a new tab; call from the tap itself so it is not blocked. */
  open(url: string): void {
    window.open(url, '_blank');
  }

  async download(id: string): Promise<void> {
    const { info, blob } = await this.gateway.download(id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = info.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
