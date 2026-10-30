import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localDateKey } from '@dawgs/core';
import type { AppContext } from '../context.js';
import { requireManager, requireOwner, requireStaff } from '../auth.js';
import { dateKey, parse } from '../util.js';
import { loadBusiness } from '../ops.js';
import { AUDIENCES, audiencePreview, campaignResults, campaignShape, referralFor, sendCampaign } from '../growth.js';
import { checklistShape, checklistsFor, saveChecklist, tick } from '../checklists.js';

/** Campaigns and referrals (bringing clients in) and the daily checklists (running the place). */
export function registerGrowthRoutes(app: FastifyInstance, ctx: AppContext) {
  const id = (req: { params: unknown }) => parse(z.object({ id: z.string().uuid() }), req.params).id;

  app.get('/campaigns', async (req) => {
    const a = requireManager(req);
    return campaignResults(ctx, a.businessId);
  });
  app.get('/campaigns/audience', async (req) => {
    const a = requireManager(req);
    const { audience } = parse(z.object({ audience: z.enum(AUDIENCES) }), req.query);
    return audiencePreview(ctx, a.businessId, audience);
  });
  app.post('/campaigns', async (req) => {
    const a = requireManager(req);
    return sendCampaign(ctx, { businessId: a.businessId, input: parse(campaignShape, req.body), actor: a.name });
  });

  app.get('/me/referral', async (req) => {
    const a = requireOwner(req);
    return referralFor(ctx, a.businessId, a.ownerId);
  });

  const today = async (businessId: string, q: unknown) => {
    const { date } = parse(z.object({ date: dateKey.optional() }), q);
    return date ?? localDateKey(ctx.now(), (await loadBusiness(ctx.db, businessId)).timezone);
  };
  app.get('/checklists', async (req) => {
    const a = requireStaff(req);
    const all = parse(z.object({ all: z.literal('1').optional() }).passthrough(), req.query).all === '1' && a.role === 'manager';
    return checklistsFor(ctx, a.businessId, await today(a.businessId, req.query), all);
  });
  app.post('/checklists', async (req) => {
    const a = requireManager(req);
    return saveChecklist(ctx, a.businessId, parse(checklistShape, req.body));
  });
  app.patch('/checklists/:id', async (req) => {
    const a = requireManager(req);
    return saveChecklist(ctx, a.businessId, parse(checklistShape, req.body), id(req));
  });
  app.post('/checklists/:id/check', async (req) => {
    const a = requireStaff(req);
    const b = parse(z.object({ item: z.string().min(1).max(120), done: z.boolean(), date: dateKey.optional() }), req.body);
    const date = b.date ?? (await today(a.businessId, {}));
    return tick(ctx, { businessId: a.businessId, id: id(req), date, item: b.item, done: b.done, by: a.name });
  });
}
