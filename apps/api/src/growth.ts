/**
 * Bringing clients back and bringing new ones in: campaigns to a group of
 * clients (text and/or email) with what came of them, and share-a-friend
 * referral links that reward the client who sent a new one.
 */

import { randomBytes } from 'node:crypto';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { NotFoundError, ValidationError, withPolicyDefaults } from '@dawgs/core';
import { bookings, campaigns, dogs, leads, memberships, owners, payments, visits } from '@dawgs/db';
import type { AppContext } from './context.js';
import { sendText } from './texts.js';
import { escapeHtml, looksLikeEmail } from './mail.js';
import { loadBusiness } from './ops.js';
import { grantCredits } from './credits.js';
import { audit } from './audit.js';

export const AUDIENCES = ['all', 'active', 'lapsed', 'boarding', 'members', 'no_visit_yet'] as const;
export type Audience = (typeof AUDIENCES)[number];
const DAY = 86_400_000;
/** A client who came in during the last 60 days is "active"; one who hasn't is "lapsed". */
const ACTIVE_DAYS = 60;
/** Bookings and payments this soon after a campaign count as its results. */
const RESULT_DAYS = 14;

export const campaignShape = z.object({
  name: z.string().min(1).max(80),
  audience: z.enum(AUDIENCES),
  channel: z.enum(['sms', 'email', 'both']),
  subject: z.string().max(120).nullable().optional(),
  body: z.string().min(1).max(1000),
});

export async function audienceOf(ctx: AppContext, businessId: string, audience: Audience) {
  const all = await ctx.db.select().from(owners).where(eq(owners.businessId, businessId));
  const lastVisit = new Map(
    (
      await ctx.db
        .select({ ownerId: dogs.ownerId, last: sql<Date>`max(${visits.checkedInAt})`, boarded: sql<number>`count(*) filter (where ${visits.service} = 'boarding')::int` })
        .from(visits)
        .innerJoin(dogs, eq(dogs.id, visits.dogId))
        .where(eq(visits.businessId, businessId))
        .groupBy(dogs.ownerId)
    ).map((r) => [r.ownerId, r]),
  );
  const members = new Set(
    (await ctx.db.select({ ownerId: memberships.ownerId }).from(memberships).where(and(eq(memberships.businessId, businessId), eq(memberships.status, 'active')))).map((m) => m.ownerId),
  );
  const cutoff = ctx.now() - ACTIVE_DAYS * DAY;
  return all.filter((o) => {
    const v = lastVisit.get(o.id);
    const last = v ? new Date(v.last).getTime() : null;
    if (audience === 'all') return true;
    if (audience === 'active') return last !== null && last >= cutoff;
    if (audience === 'lapsed') return last !== null && last < cutoff;
    if (audience === 'no_visit_yet') return last === null;
    if (audience === 'boarding') return (v?.boarded ?? 0) > 0;
    return members.has(o.id);
  });
}

export async function audiencePreview(ctx: AppContext, businessId: string, audience: Audience) {
  const list = await audienceOf(ctx, businessId, audience);
  const reachable = list.filter((o) => !o.marketingOptOut);
  return {
    count: reachable.length,
    optedOut: list.length - reachable.length,
    withPhone: reachable.filter((o) => o.phone && o.smsOptIn).length,
    withEmail: reachable.filter((o) => looksLikeEmail(o.email)).length,
    sample: reachable.slice(0, 5).map((o) => o.name),
  };
}

export async function sendCampaign(ctx: AppContext, args: { businessId: string; input: z.infer<typeof campaignShape>; actor: string }) {
  const b = await loadBusiness(ctx.db, args.businessId);
  const i = args.input;
  if (i.channel !== 'sms' && !i.subject?.trim()) throw new ValidationError('an email needs a subject');
  const list = (await audienceOf(ctx, args.businessId, i.audience)).filter((o) => !o.marketingOptOut);
  if (!list.length) throw new ValidationError('nobody in that group can be reached');
  let delivered = 0;
  let skipped = 0;
  for (const o of list) {
    let ok = false;
    if (i.channel !== 'email') {
      // Promotional texts must say how to opt out.
      const row = await sendText(ctx, { businessId: args.businessId, ownerId: o.id, kind: 'campaign', body: `${b.name}: ${i.body} Reply STOP to opt out.`, sentBy: args.actor });
      ok = row.status === 'sent' || ok;
    }
    if (i.channel !== 'sms' && looksLikeEmail(o.email)) {
      // CAN-SPAM: who it's from, a postal address, and a way to stop these.
      const footer = `${b.name}${b.address ? ` · ${b.address}` : ''}. You get this because you're a client. Reply "unsubscribe" and we'll stop sending these.`;
      try {
        await ctx.mail.send({
          to: o.email,
          subject: i.subject!.trim(),
          text: `${i.body}\n\n${footer}`,
          html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5;color:#27272a">${escapeHtml(i.body).replace(/\n/g, '<br>')}<p style="color:#71717a;font-size:12px;margin-top:24px">${escapeHtml(footer)}</p></div>`,
          fromName: b.name,
          replyTo: b.email,
        });
        ok = true;
      } catch {
        // counted as skipped below if nothing else went out
      }
    }
    if (ok) delivered++;
    else skipped++;
  }
  const [c] = await ctx.db
    .insert(campaigns)
    .values({ businessId: args.businessId, name: i.name, audience: i.audience, channel: i.channel, subject: i.subject ?? null, body: i.body, recipients: list.map((o) => o.id), delivered, skipped, sentBy: args.actor, sentAt: new Date(ctx.now()) })
    .returning();
  await audit(ctx.db, args.businessId, args.actor, 'campaign.send', `Campaign "${i.name}" to ${list.length} clients`);
  return c!;
}

/** Each campaign with what followed: bookings and money from its recipients in the next two weeks. */
export async function campaignResults(ctx: AppContext, businessId: string) {
  const list = await ctx.db.select().from(campaigns).where(eq(campaigns.businessId, businessId)).orderBy(desc(campaigns.sentAt)).limit(50);
  const out = [];
  for (const c of list) {
    const end = new Date(c.sentAt.getTime() + RESULT_DAYS * DAY);
    const ids = c.recipients.length ? c.recipients : ['00000000-0000-0000-0000-000000000000'];
    const [bk] = await ctx.db
      .select({ n: sql<number>`count(*)::int`, clients: sql<number>`count(distinct ${dogs.ownerId})::int` })
      .from(bookings)
      .innerJoin(dogs, eq(dogs.id, bookings.dogId))
      .where(and(eq(bookings.businessId, businessId), inArray(dogs.ownerId, ids), gte(bookings.createdAt, c.sentAt), sql`${bookings.createdAt} < ${end}`));
    const [pay] = await ctx.db
      .select({ cents: sql<number>`coalesce(sum(${payments.amountCents} - ${payments.refundedCents}), 0)::int` })
      .from(payments)
      .where(and(eq(payments.businessId, businessId), eq(payments.status, 'succeeded'), inArray(payments.ownerId, ids), gte(payments.createdAt, c.sentAt), sql`${payments.createdAt} < ${end}`));
    out.push({ ...c, recipients: c.recipients.length, results: { bookings: bk?.n ?? 0, clientsWhoBooked: bk?.clients ?? 0, revenueCents: pay?.cents ?? 0 } });
  }
  return out;
}

// ─── Referrals ───────────────────────────────────────────────────────────────

export async function referralFor(ctx: AppContext, businessId: string, ownerId: string) {
  const b = await loadBusiness(ctx.db, businessId);
  const [o] = await ctx.db.select().from(owners).where(eq(owners.id, ownerId));
  if (!o || o.businessId !== businessId) throw new NotFoundError('client');
  let code = o.referralCode;
  if (!code) {
    // Short, unambiguous, and unguessable enough that one client can't claim another's referrals.
    code = randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8).toUpperCase();
    await ctx.db.update(owners).set({ referralCode: code }).where(eq(owners.id, o.id));
  }
  const sent = await ctx.db.select({ ownerId: leads.ownerId, stage: leads.stage }).from(leads).where(eq(leads.referredBy, o.id));
  const policies = withPolicyDefaults(b.policies);
  return {
    code,
    url: ctx.publicUrl ? `${ctx.publicUrl.replace(/\/$/, '')}/inquire/${b.slug}?ref=${code}` : null,
    referred: sent.length,
    joined: sent.filter((s) => s.ownerId).length,
    rewardCredits: policies.referralRewardCredits,
  };
}

export async function ownerByReferralCode(ctx: AppContext, businessId: string, code: string) {
  const [o] = await ctx.db.select({ id: owners.id }).from(owners).where(and(eq(owners.businessId, businessId), eq(owners.referralCode, code.toUpperCase())));
  return o?.id ?? null;
}

/** When a referred lead becomes a client, the client who sent them gets the daycare's reward. */
export async function rewardReferral(ctx: AppContext, businessId: string, referrerId: string, newClient: string) {
  const b = await loadBusiness(ctx.db, businessId);
  const n = withPolicyDefaults(b.policies).referralRewardCredits;
  if (!n) return null;
  const [dog] = await ctx.db
    .select()
    .from(dogs)
    .where(and(eq(dogs.ownerId, referrerId), eq(dogs.active, true)))
    .orderBy(dogs.createdAt)
    .limit(1);
  if (!dog) return null;
  const g = await grantCredits(ctx.db, { businessId, dogId: dog.id, credits: { daycare: n }, note: `Thanks for referring ${newClient}` });
  await audit(ctx.db, businessId, 'Referrals', 'referral.reward', `${n} daycare credit(s) to ${dog.name}'s family for referring ${newClient}`);
  return g;
}
