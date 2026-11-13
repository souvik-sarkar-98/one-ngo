import { fileNameFrom, type FileInfo, type FileUploader } from '../fields/files';
import type { BinaryHttpLike, BinaryResponse } from './http';

export type { BinaryHttpLike } from './http';

/** What the file controls need from the server. */
export interface FilesGateway extends FileUploader {
  /** Name, type and size, without the bytes. */
  info(id: string): Promise<FileInfo>;
  download(id: string): Promise<{ info: FileInfo; blob: Blob }>;
}

const one = (id: string) => `/api/files/${encodeURIComponent(id)}`;

function infoFrom(id: string, res: BinaryResponse, size?: number): FileInfo {
  return {
    id,
    name: fileNameFrom(res.header('content-disposition'), id),
    mime: (res.header('content-type') ?? 'application/octet-stream').split(';')[0]!.trim(),
    size: size ?? Number(res.header('content-length') ?? 0),
  };
}

/** The files API over HTTP: the file itself is the upload body, its name URI-encoded in `x-file-name`. */
export function httpFiles(http: BinaryHttpLike): FilesGateway {
  return {
    upload(file, name, target, progress, signal) {
      const query = target ? `?type=${encodeURIComponent(target.type)}&field=${encodeURIComponent(target.field)}` : '';
      const headers = { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(name) };
      return http.upload<FileInfo>(`/api/files${query}`, file, headers, progress, signal);
    },
    info: async (id) => infoFrom(id, await http.bytes(one(id), 'HEAD')),
    async download(id) {
      const res = await http.bytes(one(id));
      return { info: infoFrom(id, res, res.blob.size), blob: res.blob };
    },
  };
}
