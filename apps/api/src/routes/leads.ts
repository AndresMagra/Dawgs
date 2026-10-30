import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businesses, users } from '@dawgs/db';
import { and, eq, ne } from 'drizzle-orm';
import { ValidationError } from '@dawgs/core';
import type { AppContext } from '../context.js';
import { requireStaff } from '../auth.js';
import { parse } from '../util.js';
import { addActivity, convertLead, createLead, inquiryAllowed, leadDetail, leadShape, listLeads, messageLead, publicInquiry, STAGES, updateLead } from '../leads.js';

/** Prospective clients: the desk's pipeline, and the inquiry form on the daycare's website. */
export function registerLeadRoutes(app: FastifyInstance, ctx: AppContext) {
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get('/leads', async (req) => {
    const a = requireStaff(req);
    const { all } = parse(z.object({ all: z.string().optional() }), req.query);
    const [list, staff] = await Promise.all([
      listLeads(ctx, a.businessId, all === '1'),
      ctx.db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.businessId, a.businessId), ne(users.role, 'owner'), eq(users.active, true))),
    ]);
    const [b] = await ctx.db.select({ slug: businesses.slug }).from(businesses).where(eq(businesses.id, a.businessId));
    return { leads: list, staff, inquiryUrl: ctx.publicUrl ? `${ctx.publicUrl.replace(/\/$/, '')}/inquire/${b!.slug}` : null };
  });
  app.get('/leads/:id', async (req) => leadDetail(ctx, requireStaff(req).businessId, id(req)));
  app.post('/leads', async (req) => {
    const a = requireStaff(req);
    return createLead(ctx, { businessId: a.businessId, input: parse(leadShape, req.body), actor: a.name });
  });
  app.patch('/leads/:id', async (req) => {
    const a = requireStaff(req);
    const input = parse(leadShape.partial().extend({ stage: z.enum(STAGES).optional(), lostReason: z.string().max(300).nullable().optional() }), req.body);
    return updateLead(ctx, { businessId: a.businessId, leadId: id(req), input, actor: a.name });
  });
  app.post('/leads/:id/activities', async (req) => {
    const a = requireStaff(req);
    const b = parse(z.object({ kind: z.enum(['note', 'call', 'tour']), body: z.string().min(1).max(2000) }), req.body);
    return addActivity(ctx, { businessId: a.businessId, leadId: id(req), ...b, actor: a.name });
  });
  app.post('/leads/:id/message', async (req) => {
    const a = requireStaff(req);
    const b = parse(z.object({ channel: z.enum(['sms', 'email']), body: z.string().min(1).max(1600), subject: z.string().max(150).nullable().optional() }), req.body);
    return messageLead(ctx, { businessId: a.businessId, leadId: id(req), ...b, actor: a.name });
  });
  app.post('/leads/:id/convert', async (req) => {
    const a = requireStaff(req);
    return convertLead(ctx, { businessId: a.businessId, leadId: id(req), actor: a.name });
  });

  app.post('/public/daycares/:slug/inquiry', { config: { public: true }, bodyLimit: 20_000 }, async (req) => {
    const { slug } = req.params as { slug: string };
    const b = parse(leadShape.omit({ followUpOn: true, assignedTo: true, source: true }).extend({ website: z.string().optional(), ref: z.string().max(20).optional() }), req.body);
    // Bots fill every field; people never see this one.
    if (b.website) return { ok: true };
    if (!inquiryAllowed(`${req.ip}:${slug}`, ctx.now())) throw new ValidationError('too many messages; please call us instead');
    const { website: _honeypot, ref, ...input } = b;
    return publicInquiry(ctx, slug, input, ref);
  });
}
