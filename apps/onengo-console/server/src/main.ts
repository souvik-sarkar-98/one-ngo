import { join } from 'node:path';
import {
  PATHS, connectorHttpFromEnvironment, createLogger, createOperatorRuntime, encryptionKeysFromEnvironment,
  installationOidcSummaryFromEnvironment, openOperatorDatabase, smtpFromEnvironment,
} from '@onengo/platform/operator';
import { buildOperatorServer } from './http/server.js';
import { localWithoutIap, OperatorProvider } from './operators/provider.js';
import { OperatorDirectory } from './operators/directory.js';
import { OperatorStore, SecretBox } from './operators/security.js';
import { assertConsoleSettings, iapAudience } from './settings.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const key = (): Buffer => {
  const value = required('OPERATOR_ENCRYPTION_KEY');
  const decoded = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (decoded.length !== 32) throw new Error('OPERATOR_ENCRYPTION_KEY must be 32 bytes encoded as hex or base64.');
  return decoded;
};

assertConsoleSettings(process.env);
const logger = createLogger();
const local = localWithoutIap(process.env);
const audience = iapAudience(process.env, local);
const db = await openOperatorDatabase(process.env);
const encryptionKey = key();
const publicBaseUrl = required('OPERATOR_PUBLIC_BASE_URL').replace(/\/$/, '');
const connectorHttp = connectorHttpFromEnvironment(process.env);
// Organisation secrets the console writes (sign-in client secrets) are read by the main server, so they use
// its ENCRYPTION_KEY. OPERATOR_ENCRYPTION_KEY stays for the console's own sessions and sign-in state.
const runtime = await createOperatorRuntime(db, {
  tokenSecret: required('OPERATOR_INTERNAL_TOKEN_SECRET'),
  ...encryptionKeysFromEnvironment(process.env, required),
  logger, publicBaseUrl, paths: PATHS, connectorHttp,
  defaultEmailTransport: smtpFromEnvironment(process.env, required),
}, {
  sharedProviders: installationOidcSummaryFromEnvironment(process.env),
  http: connectorHttp,
});
const provider = new OperatorProvider({
  issuer: required('OPERATOR_OIDC_ISSUER'),
  clientId: required('OPERATOR_OIDC_CLIENT_ID'),
  clientSecret: process.env.OPERATOR_OIDC_CLIENT_SECRET,
  redirectUri: `${publicBaseUrl}/op/auth/callback`,
  audience: required('OPERATOR_OIDC_AUDIENCE'),
  mfaAcr: process.env.OPERATOR_OIDC_MFA_ACR,
});
await provider.check().catch(async (error: unknown) => {
  logger.log('CRITICAL', 'Start-up failed: the operator identity provider could not be reached or is misconfigured', {}, error);
  await runtime.close();
  process.exit(1);
});
const app = buildOperatorServer({
  store: new OperatorStore(db, new SecretBox(encryptionKey)),
  directory: new OperatorDirectory(db),
  provider, control: runtime.control,
  webRoot: process.env.OPERATOR_WEB_ROOT ?? join(process.cwd(), 'dist', 'web'),
  iapAudience: audience,
});
const close = async () => { await app.close(); await runtime.close(); };
process.once('SIGTERM', close);
process.once('SIGINT', close);
await app.listen({ host: local ? '127.0.0.1' : '0.0.0.0', port: Number(process.env.PORT ?? 8081) });
logger.log('INFO', 'console server listening', { port: Number(process.env.PORT ?? 8081) });
