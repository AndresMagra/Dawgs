/**
 * Production entry. Refuses to start without the settings production needs,
 * and never seeds demo data.
 */

import { buildApp } from './app.js';
import { contextFromEnv } from './server.js';
import { startScheduler } from './scheduler.js';

const env = process.env;
const missing = ['DAWGS_DATABASE_URL', 'DAWGS_SECRET', 'DAWGS_PUBLIC_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_CLIENT_ID'].filter(
  (k) => !env[k],
);
if (missing.length) {
  console.error(`Refusing to start: set ${missing.join(', ')}`);
  process.exit(1);
}
if ((env.DAWGS_SECRET ?? '').length < 32) {
  console.error('Refusing to start: DAWGS_SECRET must be at least 32 characters');
  process.exit(1);
}
const ctx = await contextFromEnv(env);
const app = await buildApp(ctx, { logger: true, corsOrigins: (env.DAWGS_CORS_ORIGINS ?? env.DAWGS_PUBLIC_URL!).split(',') });
startScheduler(ctx);
await app.listen({ port: Number(env.PORT ?? 3001), host: '0.0.0.0' });
