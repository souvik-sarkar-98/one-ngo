import type { Readable } from 'node:stream';

declare const OPEN_TRANSACTION: unique symbol;

export interface TransactionOptions {
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  readOnly?: boolean;
}

export interface Tx {
  readonly [OPEN_TRANSACTION]: true;
}

export interface TransactionManager {
  withTransaction<T>(fn: (tx: Tx) => Promise<T>, options?: TransactionOptions): Promise<T>;
}

export type Severity = 'DEBUG' | 'INFO' | 'NOTICE' | 'WARNING' | 'ERROR' | 'CRITICAL';
export type LogFields = Record<string, string | number | boolean | null | undefined>;
export interface Logger {
  log(severity: Severity, message: string, fields?: LogFields, error?: unknown): void;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** HTML alternative. Absent when the message is plain text. */
  html?: string;
}
export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

export interface FileStore {
  put(key: string, body: Readable, contentType?: string): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

/**
 * Which store an organisation's files go to. New uploads use `forTenant`; a stored file is always read and
 * deleted through `byRef` with the reference recorded when it was written, so changing an organisation's
 * store never strands the files it already has.
 */
export interface FileStoreResolver {
  forTenant(tenantId: string): Promise<{ ref: string; store: FileStore }>;
  /** Throws when no store has this reference. */
  byRef(ref: string): FileStore;
}

export interface AccessClaims {
  sub: string;
  tid: string;
  sid: string;
  typ: 'access';
  method?: string;
  assurance?: 'aal1' | 'aal2' | 'aal3';
  auth_time?: number;
  amr?: string[];
  acr?: string;
  iat: number;
  exp: number;
}
export interface TokenHasher {
  sha256(value: string): string;
  safeEqual(a: string, b: string): boolean;
  randomToken(bytes?: number): string;
}
export interface CredentialCrypto extends TokenHasher {
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, stored: string | null): Promise<boolean>;
  randomDigits(count: number): string;
  signAccessToken(claims: Omit<AccessClaims, 'iat' | 'exp'>, secret: string, ttlSeconds: number): Promise<string>;
  verifyAccessToken(token: string, secret: string): Promise<AccessClaims | null>;
  generateTotpSecret(): string;
  verifyTotp(secretBase32: string, code: string): boolean;
  totpStep(secretBase32: string, code: string): number | null;
  encryptSecret(plaintext: string): string;
  decryptSecret(stored: string): string;
}
export interface RequestLimiter {
  hit(key: string): boolean;
}
export interface PasswordBreachSource {
  breachCount(password: string): Promise<number | null>;
}
export interface CommonPasswordSource {
  lines(): string[];
}

export interface FieldIssue {
  path: string;
  message: string;
}

export interface ErrorsApi<E extends Error = Error> {
  asApplicationError(error: unknown): E;
}
export interface ShutdownHost {
  close(): Promise<void>;
}
