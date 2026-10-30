/**
 * Texting owners from the desk, the text log, and replies coming back.
 */

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { businesses, owners, smsMessages, users } from '@dawgs/db';
import { ValidationError } from '@dawgs/core';
import { inbox, notifyInbound, reply, thread, unreadCount } from '../messaging.js';
import { leadReply } from '../leads.js';
import type { AppContext } from '../context.js';
import { requireStaff, sameBusiness } from '../auth.js';
import { parse } from '../util.js';
import { sendText } from '../texts.js';
import { toE164 } from '../sms.js';

export function registerTextRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/texts', async (req) => {
    const a = requireStaff(req);
    const rows = await ctx.db
      .select({ m: smsMessages, owner: owners.name })
      .from(smsMessages)
      .leftJoin(owners, eq(owners.id, smsMessages.ownerId))
      .where(eq(smsMessages.businessId, a.businessId))
      .orderBy(desc(smsMessages.createdAt))
      .limit(300);
    return rows.map((r) => ({ ...r.m, ownerName: r.owner }));
  });

  app.get('/texts/inbox', async (req) => inbox(ctx, requireStaff(req).businessId));
  app.get('/texts/unread', async (req) => ({ unread: await unreadCount(ctx, requireStaff(req).businessId) }));
  app.get('/texts/thread', async (req) => {
    const a = requireStaff(req);
    const q = parse(z.object({ ownerId: z.string().uuid().optional(), phone: z.string().max(20).optional() }), req.query);
    if (!q.ownerId && !q.phone) throw new ValidationError('ownerId or phone');
    return thread(ctx, a.businessId, { ...(q.ownerId ? { ownerId: q.ownerId } : {}), ...(q.phone ? { phone: q.phone } : {}) });
  });
  app.post('/texts/reply', async (req) => {
    const a = requireStaff(req);
    const b = parse(z.object({ ownerId: z.string().uuid().optional(), phone: z.string().max(20).optional(), body: z.string().min(1).max(600) }), req.body);
    return reply(ctx, { businessId: a.businessId, body: b.body, actor: a.name, ...(b.ownerId ? { ownerId: b.ownerId } : {}), ...(b.phone ? { phone: b.phone } : {}) });
  });

  app.post('/owners/:id/text', async (req) => {
    const a = requireStaff(req);
    const { id } = req.params as { id: string };
    const { body } = parse(z.object({ body: z.string().min(1).max(600) }), req.body);
    const [o] = await ctx.db.select().from(owners).where(eq(owners.id, id));
    sameBusiness(a, o, 'owner');
    return sendText(ctx, { businessId: a.businessId, ownerId: id, kind: 'manual', body, sentBy: a.name });
  });

  /**
   * Twilio posts replies here as a form. The daycare is found by the number
   * the text was sent TO, and the request is checked against that daycare's
   * own Twilio auth token before anything is stored.
   */
  app.post('/webhooks/twilio', { config: { public: true } }, async (req, reply) => {
    const p = (req.body ?? {}) as Record<string, string>;
    const to = p.To ?? '';
    const from = p.From ?? '';
    const [biz] = await ctx.db
      .select()
      .from(businesses)
      .where(or(eq(businesses.twilioFrom, to), eq(businesses.twilioFrom, p.MessagingServiceSid ?? '-')));
    if (!biz) return reply.code(404).send();
    const sms = await ctx.smsFor(biz.id);
    const url = `${req.protocol}://${req.headers.host}${req.url}`;
    if (!sms.verifyInbound(url, p, req.headers['x-twilio-signature'] as string | undefined)) return reply.code(403).send();
    const list = await ctx.db.select().from(owners).where(eq(owners.businessId, biz.id));
    const owner = list.find((o) => o.phone && toE164(o.phone) === from);
    const body = (p.Body ?? '').trim();
    await ctx.db.insert(smsMessages).values({
      businessId: biz.id,
      ownerId: owner?.id ?? null,
      direction: 'in',
      to: from,
      body,
      kind: 'inbound',
      status: 'received',
      providerId: p.MessageSid ?? null,
    });
    if (!owner) await leadReply(ctx, biz.id, from, body);
    else if (!/^(stop|stopall|unsubscribe|cancel|end|quit|start|unstop|yes)$/i.test(body)) {
      const managers = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.businessId, biz.id), eq(users.role, 'manager'), eq(users.active, true)));
      await notifyInbound(ctx, biz.id, owner.name, body, managers.map((m) => m.id));
    }
    if (owner && /^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(body)) {
      await ctx.db.update(owners).set({ smsOptIn: false }).where(and(eq(owners.id, owner.id)));
    }
    if (owner && /^(start|unstop|yes)$/i.test(body)) {
      await ctx.db.update(owners).set({ smsOptIn: true }).where(eq(owners.id, owner.id));
    }
    return reply.type('text/xml').send('<Response></Response>');
  });
}
