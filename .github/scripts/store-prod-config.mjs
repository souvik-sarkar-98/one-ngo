// Stores one service's production settings as a JSON secret in Google Secret Manager, for the bootstrap to read.
//
//   PROJECT, SECRET_ID, RUNTIME_SA       the project, the secret, and the service account that may read it
//   CONFIG_NAMES                         comma-separated setting names that must be set, e.g. TOKEN_SECRET,ENCRYPTION_KEY
//   CONFIG_OPTIONAL                      comma-separated names stored only when they are set
//   <each name>                          its value, passed in the environment from a GitHub secret
//
// Values are never printed and never put on a command line: the JSON goes to gcloud on stdin. Nothing is
// written when a required value is empty. The two newest versions are kept, so a bad write can be reverted.

import { spawn } from 'node:child_process';

const KEEP_VERSIONS = 2;
const SETTING_NAME = /^[A-Z][A-Z0-9_]*$/;

function list(name) {
  return (process.env[name] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function gcloud(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('gcloud', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`gcloud ${args.slice(0, 3).join(' ')} failed: ${stderr.trim().slice(0, 400)}`));
    });
    child.stdin.end(input);
  });
}

function buildConfig() {
  const config = {};
  for (const name of list('CONFIG_NAMES')) {
    const value = process.env[name];
    if (!value?.trim()) throw new Error(`${name} is empty. Nothing was written to Secret Manager.`);
    config[name] = value;
  }
  for (const name of list('CONFIG_OPTIONAL')) {
    const value = process.env[name];
    if (value?.trim()) config[name] = value;
  }
  for (const name of Object.keys(config)) {
    if (!SETTING_NAME.test(name)) throw new Error(`${name} is not a valid setting name.`);
  }
  return config;
}

async function ensureSecret(project, secretId) {
  try {
    await gcloud(['secrets', 'describe', secretId, '--project', project, '--format=value(name)']);
  } catch (error) {
    if (!/not.found/i.test(error.message)) throw error;
    await gcloud(['secrets', 'create', secretId, '--project', project, '--replication-policy=automatic', '--quiet']);
  }
}

async function main() {
  const project = process.env.PROJECT?.trim();
  const secretId = process.env.SECRET_ID?.trim();
  const runtimeServiceAccount = process.env.RUNTIME_SA?.trim();
  if (!project || !secretId || !runtimeServiceAccount) throw new Error('PROJECT, SECRET_ID and RUNTIME_SA must be set.');

  const config = buildConfig();
  const names = Object.keys(config);

  await ensureSecret(project, secretId);
  await gcloud(['secrets', 'versions', 'add', secretId, '--project', project, '--data-file=-'], JSON.stringify(config));
  await gcloud([
    'secrets', 'add-iam-policy-binding', secretId, '--project', project,
    `--member=serviceAccount:${runtimeServiceAccount}`, '--role=roles/secretmanager.secretAccessor', '--quiet',
  ]);

  // Newest first. Everything after the first KEEP_VERSIONS is destroyed.
  const enabled = (await gcloud([
    'secrets', 'versions', 'list', secretId, '--project', project,
    '--filter=state=ENABLED', '--sort-by=~createTime', '--format=value(name.basename())',
  ])).split('\n').map((line) => line.trim()).filter(Boolean);
  for (const version of enabled.slice(KEEP_VERSIONS)) {
    await gcloud(['secrets', 'versions', 'destroy', version, '--secret', secretId, '--project', project, '--quiet']);
  }

  console.log(`Stored ${secretId} with ${names.length} settings: ${names.join(', ')}. Kept ${Math.min(enabled.length, KEEP_VERSIONS)} version(s).`);
}

main().catch((error) => {
  console.error(`::error::${error.message}`);
  process.exit(1);
});
