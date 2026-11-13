import { Injectable, inject } from '@angular/core';
import type { FileDownload, FileHttp } from '../core/http/http';
import { Api } from './api';

/** The name in a `content-disposition` header, preferring its UTF-8 form. */
function fileNameOf(header: string | null): string {
  const plain = /filename="([^"]*)"/i.exec(header ?? '')?.[1] ?? 'download.csv';
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header ?? '')?.[1];
  try {
    return utf8 ? decodeURIComponent(utf8) : plain;
  } catch {
    return plain;
  }
}

/** The app's HTTP client with files both ways; kept out of the first download, as only record lists use it. */
@Injectable({ providedIn: 'root' })
export class FileApi implements FileHttp {
  private readonly api = inject(Api);

  get<T>(url: string): Promise<T> {
    return this.api.get<T>(url);
  }
  post<T>(url: string, body?: unknown): Promise<T> {
    return this.api.post<T>(url, body);
  }
  put<T>(url: string, body: unknown): Promise<T> {
    return this.api.put<T>(url, body);
  }
  patch<T>(url: string, body: unknown): Promise<T> {
    return this.api.patch<T>(url, body);
  }
  delete<T>(url: string): Promise<T> {
    return this.api.delete<T>(url);
  }

  /** Sends a file as the whole request body, its name in `x-file-name`. */
  async upload<T>(url: string, file: Blob, fileName: string): Promise<T> {
    const res = await this.api.send('POST', url, file, { 'x-file-name': encodeURIComponent(fileName) });
    return (await res.json().catch(() => ({}))) as T;
  }

  /** A file the server sends back, or its JSON answer when it sends none (for example a background job). */
  async download(method: 'GET' | 'POST', url: string, body?: unknown): Promise<FileDownload | { json: unknown }> {
    const res = await this.api.send(method, url, body);
    if (/json/i.test(res.headers.get('content-type') ?? '')) return { json: await res.json().catch(() => ({})) };
    return { fileName: fileNameOf(res.headers.get('content-disposition')), body: await res.blob() };
  }
}
