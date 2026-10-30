import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { NotFoundError } from '@dawgs/core';
import { owners } from '@dawgs/db';
import type { AppContext } from '../context.js';
import { requireOwner, requireStaff } from '../auth.js';
import { parse } from '../util.js';
import { addPerson, peopleFor, personShape, pickupList, removePerson, updatePerson } from '../authorized.js';

/** Authorized pickup people and co-owners: the desk manages them, and so do owners in their app. */
export function registerPickupRoutes(app: FastifyInstance, ctx: AppContext) {
  const ids = (req: { params: unknown }) => req.params as { id: string; personId: string };

  app.get('/owners/:id/people', async (req) => {
    const a = requireStaff(req);
    const { id } = ids(req);
    const { all } = parse(z.object({ all: z.string().optional() }), req.query);
    await assertOwner(a.businessId, id);
    return peopleFor(ctx, id, all === '1');
  });
  app.post('/owners/:id/people', async (req) => {
    const a = requireStaff(req);
    return addPerson(ctx, { businessId: a.businessId, ownerId: ids(req).id, input: parse(personShape, req.body), actor: a.name });
  });
  app.patch('/owners/:id/people/:personId', async (req) => {
    const a = requireStaff(req);
    const { id, personId } = ids(req);
    return updatePerson(ctx, { businessId: a.businessId, ownerId: id, personId, input: parse(personShape.partial(), req.body), actor: a.name });
  });
  app.delete('/owners/:id/people/:personId', async (req) => {
    const a = requireStaff(req);
    const { id, personId } = ids(req);
    return removePerson(ctx, { businessId: a.businessId, ownerId: id, personId, actor: a.name });
  });
  app.get('/visits/:id/pickup', async (req) => {
    const a = requireStaff(req);
    return pickupList(ctx, a.businessId, ids(req).id);
  });

  app.get('/me/people', async (req) => {
    const a = requireOwner(req);
    return peopleFor(ctx, a.ownerId);
  });
  app.post('/me/people', async (req) => {
    const a = requireOwner(req);
    return addPerson(ctx, { businessId: a.businessId, ownerId: a.ownerId, input: parse(personShape, req.body), actor: `${a.name} (owner app)` });
  });
  app.patch('/me/people/:personId', async (req) => {
    const a = requireOwner(req);
    return updatePerson(ctx, { businessId: a.businessId, ownerId: a.ownerId, personId: ids(req).personId, input: parse(personShape.partial(), req.body), actor: `${a.name} (owner app)` });
  });
  app.delete('/me/people/:personId', async (req) => {
    const a = requireOwner(req);
    return removePerson(ctx, { businessId: a.businessId, ownerId: a.ownerId, personId: ids(req).personId, actor: `${a.name} (owner app)` });
  });

  async function assertOwner(businessId: string, ownerId: string) {
    const [o] = await ctx.db.select({ b: owners.businessId }).from(owners).where(eq(owners.id, ownerId));
    if (!o || o.b !== businessId) throw new NotFoundError('owner');
  }
}
