/**
 * Development server: in-process Postgres on disk, the Stripe and Twilio
 * simulators unless keys are set, and the demo daycare on first boot.
 *
 *   node apps/api/dist/server.js
 *
 * Production uses main.ts, which never seeds.
 */

import { openDatabase } from '@dawgs/db';
import { buildApp } from './app.js';
import { MIGRATIONS_DIR, type AppContext } from './context.js';
import { SimulatedGateway } from './gateway.js';
import { ConsoleSms } from './sms.js';
import { ExpoPush } from './push.js';
import { StripeConnect, tenantProviders } from './tenants.js';
import { startScheduler } from './scheduler.js';
import { seedDemo, DEMO_PASSWORD } from './seed.js';

export async function contextFromEnv(env: NodeJS.ProcessEnv): Promise<AppContext> {
  const database = await openDatabase({
    migrationsDir: MIGRATIONS_DIR,
    url: env.DAWGS_DATABASE_URL,
    dataDir: env.DAWGS_DATA_DIR ?? '.data-dev',
  });
  const connect = env.STRIPE_SECRET_KEY
    ? new StripeConnect({
        secretKey: env.STRIPE_SECRET_KEY,
        publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
        connectClientId: env.STRIPE_CONNECT_CLIENT_ID ?? null,
      })
    : null;
  const secret = env.DAWGS_SECRET ?? null;
  const providers = tenantProviders({
    db: database.db,
    connect,
    simulator: new SimulatedGateway(),
    consoleSms: new ConsoleSms(),
    secret,
  });
  return {
    db: database.db,
    ...providers,
    connect,
    secret,
    push: new ExpoPush(env.EXPO_ACCESS_TOKEN),
    now: () => Date.now(),
    publicUrl: env.DAWGS_PUBLIC_URL ?? 'http://localhost:8081',
    ownerSignupOpen: env.DAWGS_OWNER_SIGNUP !== 'closed',
    daycareSignupOpen: env.DAWGS_DAYCARE_SIGNUP === 'open',
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const ctx = await contextFromEnv(process.env);
  const demo = await seedDemo(ctx.db, ctx.now());
  const app = await buildApp(ctx, { logger: true });
  startScheduler(ctx);
  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`Dawgs API on :${port}. Demo daycare "${demo.slug}": priya@happytails.test / ${DEMO_PASSWORD} (manager), dana@example.com (owner).`);
}
