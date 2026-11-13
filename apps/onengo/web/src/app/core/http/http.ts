/** What the HTTP gateways need from the app's HTTP client. Errors are passed through as the client raises them. */
export interface HttpLike {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, body?: unknown): Promise<T>;
  put<T>(url: string, body: unknown): Promise<T>;
  patch<T>(url: string, body: unknown): Promise<T>;
  delete<T>(url: string): Promise<T>;
}

/** A file the server sent, named as its download header says. */
export interface FileDownload {
  fileName: string;
  body: Blob;
}

/** Files both ways: a file sent as the whole request body, and answers that are either a file or JSON. */
export interface FileHttp extends HttpLike {
  upload<T>(url: string, file: Blob, fileName: string): Promise<T>;
  download(method: 'GET' | 'POST', url: string, body?: unknown): Promise<FileDownload | { json: unknown }>;
}

/** A response's bytes and headers, for files. */
export interface BinaryResponse {
  blob: Blob;
  header(name: string): string | null;
}

/** Raw bytes both ways, for the files gateway. Uploads report progress as a fraction from 0 to 1. */
export interface BinaryHttpLike {
  upload<T>(url: string, body: Blob, headers: Record<string, string>, progress?: (fraction: number) => void, signal?: AbortSignal): Promise<T>;
  bytes(url: string, method?: 'GET' | 'HEAD'): Promise<BinaryResponse>;
}
