// App Engine's entry point. It loads the production settings from Secret Manager into the process environment,
// then loads the server, which reads those settings when it starts. Nothing secret is in app.yaml.
import { bootstrapSecrets } from '@onengo/kernel/secrets';

try {
  await bootstrapSecrets(process.env);
} catch (error) {
  const message = error instanceof Error ? error.message : 'settings could not be loaded';
  console.error(JSON.stringify({ severity: 'CRITICAL', message: `Start-up failed: ${message}` }));
  process.exit(1);
}

// A computed path keeps the bundler from inlining the server here; it is loaded as its own file.
await import(new URL('./server.js', import.meta.url).href);
