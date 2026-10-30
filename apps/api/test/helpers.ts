import { createMemoryDatabase } from '@dawgs/db';
import { buildApp } from '../src/app.js';
import { MIGRATIONS_DIR, type AppContext } from '../src/context.js';
import { SimulatedGateway } from '../src/gateway.js';
import { ConsoleSms } from '../src/sms.js';
import { MemoryPush } from '../src/push.js';
import { tenantProviders } from '../src/tenants.js';
import { seedDemo, DEMO_PASSWORD } from '../src/seed.js';

/** A whole Dawgs on in-process Postgres, with a clock the test moves. */
export async function makeApp(startAt = Date.parse('2026-11-04T13:00:00Z')) {
  const database = await createMemoryDatabase({ migrationsDir: MIGRATIONS_DIR });
  const clock = { t: startAt };
  const sim = new SimulatedGateway();
  const sms = new ConsoleSms();
  const push = new MemoryPush();
  const ctx: AppContext = {
    db: database.db,
    ...tenantProviders({ db: database.db, connect: null, simulator: sim, consoleSms: sms, secret: 'test-secret-test-secret-test-secret' }),
    connect: null,
    secret: 'test-secret-test-secret-test-secret',
    push,
    now: () => clock.t,
    publicUrl: 'https://app.dawgs.test',
    ownerSignupOpen: true,
    daycareSignupOpen: true,
  };
  const business = await seedDemo(ctx.db, clock.t);
  const app = await buildApp(ctx);

  async function call<T = any>(method: string, url: string, token?: string | null, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as T) : (undefined as T) };
  }
  async function login(email: string) {
    const r = await call<{ token: string }>('POST', '/auth/login', null, { email, password: DEMO_PASSWORD });
    if (r.status !== 200) throw new Error(`login ${email}: ${JSON.stringify(r.body)}`);
    return r.body.token;
  }
  return { app, ctx, clock, sim, sms, push, business, call, login, close: () => database.close() };
}
