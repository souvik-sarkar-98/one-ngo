import { X509Certificate } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generate } from 'selfsigned';

export interface FixtureTls {
  /** Path of the local CA certificate; one-ngo trusts it through NODE_EXTRA_CA_CERTS. */
  caPath: string;
  ca: string;
  cert: string;
  key: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function readIfPresent(path: string): Promise<string | undefined> {
  return existsSync(path) ? readFile(path, 'utf8') : undefined;
}

function stillValid(pem: string, host: string): boolean {
  try {
    const cert = new X509Certificate(pem);
    return Date.parse(cert.validTo) - Date.now() > DAY_MS && cert.checkIP(host) !== undefined;
  } catch {
    return false;
  }
}

/**
 * A local CA and a server certificate for `host`, made on first start and kept under `dir`.
 * The server certificate is renewed when it is about to expire; the CA is kept, so trust set up once lasts.
 */
export async function fixtureTls(dir: string, host: string): Promise<FixtureTls> {
  await mkdir(dir, { recursive: true });
  const caPath = join(dir, 'ca.crt');
  const caKeyPath = join(dir, 'ca.key');
  const certPath = join(dir, 'server.crt');
  const keyPath = join(dir, 'server.key');

  let ca = await readIfPresent(caPath);
  let caKey = await readIfPresent(caKeyPath);
  if (!ca || !caKey) {
    const made = await generate([{ name: 'commonName', value: 'one-ngo service sandbox CA' }], {
      keySize: 2048,
      algorithm: 'sha256',
      notAfterDate: new Date(Date.now() + 10 * 365 * DAY_MS),
      extensions: [
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
      ],
    });
    ca = made.cert;
    caKey = made.private;
    await writeFile(caPath, ca);
    await writeFile(caKeyPath, caKey, { mode: 0o600 });
  }

  let cert = await readIfPresent(certPath);
  let key = await readIfPresent(keyPath);
  if (!cert || !key || !stillValid(cert, host)) {
    const made = await generate([{ name: 'commonName', value: host }], {
      keySize: 2048,
      algorithm: 'sha256',
      notAfterDate: new Date(Date.now() + 365 * DAY_MS),
      ca: { key: caKey, cert: ca },
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 7, ip: host }, { type: 2, value: 'localhost' }] },
      ],
    });
    cert = made.cert;
    key = made.private;
    await writeFile(certPath, cert);
    await writeFile(keyPath, key, { mode: 0o600 });
  }
  return { caPath, ca, cert, key };
}
