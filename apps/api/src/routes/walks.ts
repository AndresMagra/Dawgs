/**
 * Staff routes for walks: schedule, assign, run with GPS, finish.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { addLocalDays, dateKeyToInstant, localDateKey } from '@dawgs/core';
import { dogs, users, walks } from '@dawgs/db';
import type { AppContext } from '../context.js';
import { requireManager, requireStaff, sameBusiness } from '../auth.js';
import { dateKey, parse, uuid } from '../util.js';
import { addPoints, finishWalk, scheduleWalk, startWalk, walkTrack, walksBetween } from '../walks.js';
import { loadBusiness } from '../ops.js';
import { pushToUsers } from '../texts.js';

export const pointsShape = z.object({
  points: z
    .array(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        at: z.number().int(),
        accuracy: z.number().nullable().optional(),
      }),
    )
    .max(500),
});

export function registerWalkRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/walks', async (req) => {
    const a = requireStaff(req);
    const b = await loadBusiness(ctx.db, a.businessId);
    const q = parse(z.object({ from: dateKey.optional(), to: dateKey.optional(), mine: z.string().optional() }), req.query);
    const from = q.from ?? localDateKey(ctx.now(), b.timezone);
    const to = q.to ?? from;
    let list = await walksBetween(ctx, a.businessId, dateKeyToInstant(from, b.timezone), dateKeyToInstant(addLocalDays(to, 1), b.timezone));
    if (q.mine === '1') list = list.filter((w) => w.walkerId === a.userId);
    const dogRows = list.length ? await ctx.db.select().from(dogs).where(inArray(dogs.id, list.map((w) => w.dogId))) : [];
    const walkers = await ctx.db.select({ id: users.id, name: users.name }).from(users).where(eq(users.businessId, a.businessId));
    return list.map((w) => ({
      ...w,
      dog: dogRows.find((d) => d.id === w.dogId),
      walkerName: walkers.find((u) => u.id === w.walkerId)?.name ?? null,
    }));
  });

  app.post('/walks', async (req) => {
    const a = requireStaff(req);
    const b = parse(z.object({ dogId: uuid, walkTypeId: uuid, scheduledAt: z.number().int(), walkerId: uuid.nullable().optional() }), req.body);
    const w = await scheduleWalk(ctx, { ...b, businessId: a.businessId, actor: a.name, byOwner: false });
    if (b.walkerId) await pushToUsers(ctx, [b.walkerId], 'New walk assigned', 'Open Dawgs to see it.', { walkId: w.id });
    return w;
  });

  /** Assign or reassign a walker, and confirm an owner's request. */
  app.post('/walks/:id/assign', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const { walkerId } = parse(z.object({ walkerId: uuid }), req.body);
    const [w] = await ctx.db.select().from(walks).where(eq(walks.id, id));
    sameBusiness(a, w, 'walk');
    const [u] = await ctx.db.select().from(users).where(eq(users.id, walkerId));
    sameBusiness(a, u, 'walker');
    const [out] = await ctx.db
      .update(walks)
      .set({ walkerId, status: w!.status === 'requested' ? 'scheduled' : w!.status })
      .where(eq(walks.id, id))
      .returning();
    await pushToUsers(ctx, [walkerId], 'New walk assigned', 'Open Dawgs to see it.', { walkId: id });
    return out;
  });

  app.post('/walks/:id/cancel', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const [w] = await ctx.db.select().from(walks).where(eq(walks.id, id));
    sameBusiness(a, w, 'walk');
    await ctx.db.update(walks).set({ status: 'cancelled' }).where(and(eq(walks.id, id)));
    return { ok: true };
  });

  app.get('/walks/:id', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const [w] = await ctx.db.select().from(walks).where(eq(walks.id, id));
    sameBusiness(a, w, 'walk');
    return { walk: w, track: await walkTrack(ctx, id) };
  });

  app.post('/walks/:id/start', async (req) => startWalk(ctx, requireStaff(req), (req.params as { id: string }).id));

  app.post('/walks/:id/points', async (req) => {
    const a = requireStaff(req);
    const { points } = parse(pointsShape, req.body);
    return addPoints(ctx, a, (req.params as { id: string }).id, points);
  });

  app.post('/walks/:id/finish', async (req) => {
    const a = requireStaff(req);
    const b = parse(z.object({ pee: z.boolean().optional(), poop: z.boolean().optional(), report: z.string().max(1000).nullable().optional() }), req.body);
    return finishWalk(ctx, a, (req.params as { id: string }).id, b);
  });
}
