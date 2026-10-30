/**
 * Demo entry: a full Dawgs with the demo daycare, for trying it out on a real
 * address. Payments are simulated (test cards only) and it refuses to start
 * with real Stripe keys, so a demo can never take money. Production is main.ts.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { addLocalDays, localDateKey } from '@dawgs/core';
import { bookings, dogs, kennels, users, visits, walkTypes, yards } from '@dawgs/db';
import { buildApp } from './app.js';
import { contextFromEnv } from './server.js';
import { startScheduler } from './scheduler.js';
import { seedDemo, DEMO_PASSWORD } from './seed.js';
import { checkIn, createBooking, loadBusiness } from './ops.js';
import { scheduleWalk } from './walks.js';
import type { AppContext } from './context.js';

const env = process.env;
if (env.STRIPE_SECRET_KEY) {
  console.error('Refusing to start the demo with real Stripe keys. Use main.js for production.');
  process.exit(1);
}

/** Give the board something to show today: dogs in, a boarder, arrivals and a walk. Runs once a day. */
async function demoDay(ctx: AppContext, businessId: string) {
  const b = await loadBusiness(ctx.db, businessId);
  const today = localDateKey(ctx.now(), b.timezone);
  const open = await ctx.db.select({ id: visits.id }).from(visits).where(and(eq(visits.businessId, businessId), isNull(visits.checkedOutAt)));
  const todays = await ctx.db.select({ id: bookings.id }).from(bookings).where(and(eq(bookings.businessId, businessId), eq(bookings.date, today)));
  if (open.length || todays.length) return;
  const all = await ctx.db.select().from(dogs).where(eq(dogs.businessId, businessId));
  const byName = (n: string) => all.find((d) => d.name === n)!;
  const ys = await ctx.db.select().from(yards).where(eq(yards.businessId, businessId));
  const ks = await ctx.db.select().from(kennels).where(eq(kennels.businessId, businessId));
  const actor = 'Demo';
  const safe = async (f: () => Promise<unknown>) => f().catch((e) => console.warn('demo:', (e as Error).message));
  await safe(() => checkIn(ctx, { businessId, actor, dogId: byName('Biscuit').id, service: 'daycare', plan: 'full', yardId: ys[0]?.id ?? null, pickupTime: '17:00' }));
  await safe(() => checkIn(ctx, { businessId, actor, dogId: byName('Mochi').id, service: 'daycare', plan: 'half', yardId: ys[1]?.id ?? null, pickupTime: '16:00' }));
  await safe(() => checkIn(ctx, { businessId, actor, dogId: byName('Bruno').id, service: 'boarding', kennelId: ks[0]?.id ?? null, departDate: addLocalDays(today, 2), play: true }));
  await safe(() => createBooking(ctx, { businessId, actor, source: 'staff', input: { dogId: byName('Olive').id, service: 'daycare', plan: 'full', date: today, pickupTime: '18:00' } }));
  await safe(() => createBooking(ctx, { businessId, actor: 'Dana (app)', source: 'owner', input: { dogId: byName('Biscuit').id, service: 'daycare', plan: 'full', date: addLocalDays(today, 1), pickupTime: '17:00' } }));
  const [wt] = await ctx.db.select().from(walkTypes).where(eq(walkTypes.businessId, businessId));
  const [walker] = await ctx.db.select().from(users).where(and(eq(users.businessId, businessId), eq(users.email, 'marco@happytails.test')));
  if (wt) await safe(() => scheduleWalk(ctx, { businessId, dogId: byName('Mochi').id, walkTypeId: wt.id, scheduledAt: ctx.now() + 2 * 3_600_000, walkerId: walker?.id ?? null, actor, byOwner: false }));
}

const ctx = await contextFromEnv(env);
const demo = await seedDemo(ctx.db, ctx.now());
await demoDay(ctx, demo.id);
setInterval(() => void demoDay(ctx, demo.id).catch(() => undefined), 3_600_000).unref();

const web = env.DAWGS_WEB_DIR;
const app = await buildApp(ctx, {
  logger: true,
  ...(web ? { apiPrefix: '/api', sites: [{ prefix: '', dir: `${web}/customer` }, { prefix: '/staff', dir: `${web}/staff` }] } : {}),
});
startScheduler(ctx);
const port = Number(env.PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });
console.log(`Dawgs demo on :${port}. Logins (password ${DEMO_PASSWORD}): priya@happytails.test (manager), marco@happytails.test (staff), dana@example.com (owner).`);
