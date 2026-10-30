/**
 * Conversations with clients by text, report cards sent in bulk, and the
 * automatic friendly texts: a review request after a visit and a birthday
 * message. Every text still goes through `sendText`, so STOP is honoured.
 */

import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { NotFoundError, ValidationError, addLocalDays, dateKeyToInstant, localDateKey, withPolicyDefaults } from '@dawgs/core';
import { businesses, dogs, leads, owners, smsMessages, visitNotes, visits } from '@dawgs/db';
import type { AppContext } from './context.js';
import { pushToOwner, pushToUsers, sendText } from './texts.js';
import { toE164 } from './sms.js';
import { messageLead, optedOut } from './leads.js';
import { loadBusiness } from './ops.js';

type Sms = typeof smsMessages.$inferSelect;

/** One row per person: a client, a lead, or a number we don't know. */
export async function inbox(ctx: AppContext, businessId: string) {
  const rows = await ctx.db
    .select({ m: smsMessages, owner: owners.name })
    .from(smsMessages)
    .leftJoin(owners, eq(owners.id, smsMessages.ownerId))
    .where(eq(smsMessages.businessId, businessId))
    .orderBy(desc(smsMessages.createdAt))
    .limit(2000);
  const leadRows = await ctx.db.select({ id: leads.id, name: leads.name, phone: leads.phone }).from(leads).where(eq(leads.businessId, businessId));
  const leadByPhone = new Map(leadRows.filter((l) => l.phone).map((l) => [toE164(l.phone!) ?? l.phone!, l]));
  const threads = new Map<string, { key: string; ownerId: string | null; phone: string | null; leadId: string | null; name: string; last: Sms; unread: number }>();
  for (const { m, owner } of rows) {
    const key = m.ownerId ? `o:${m.ownerId}` : `p:${m.to}`;
    let t = threads.get(key);
    if (!t) {
      const lead = m.ownerId ? undefined : leadByPhone.get(m.to);
      t = { key, ownerId: m.ownerId, phone: m.ownerId ? null : m.to, leadId: lead?.id ?? null, name: owner ?? lead?.name ?? m.to, last: m, unread: 0 };
      threads.set(key, t);
    }
    if (m.direction === 'in' && !m.readAt) t.unread++;
  }
  return [...threads.values()];
}

export async function thread(ctx: AppContext, businessId: string, who: { ownerId?: string; phone?: string }) {
  if (who.ownerId) {
    const [o] = await ctx.db.select().from(owners).where(eq(owners.id, who.ownerId));
    if (!o || o.businessId !== businessId) throw new NotFoundError('client');
  }
  const where = and(eq(smsMessages.businessId, businessId), who.ownerId ? eq(smsMessages.ownerId, who.ownerId) : and(isNull(smsMessages.ownerId), eq(smsMessages.to, who.phone ?? '-')));
  const messages = await ctx.db.select().from(smsMessages).where(where).orderBy(asc(smsMessages.createdAt)).limit(500);
  await ctx.db
    .update(smsMessages)
    .set({ readAt: new Date(ctx.now()) })
    .where(and(where, eq(smsMessages.direction, 'in'), isNull(smsMessages.readAt)));
  return messages;
}

export async function unreadCount(ctx: AppContext, businessId: string) {
  const [r] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(smsMessages)
    .where(and(eq(smsMessages.businessId, businessId), eq(smsMessages.direction, 'in'), isNull(smsMessages.readAt)));
  return r?.n ?? 0;
}

/** Reply in a conversation: to a client by their record, to anyone else by number. */
export async function reply(ctx: AppContext, args: { businessId: string; ownerId?: string; phone?: string; body: string; actor: string }) {
  if (args.ownerId) {
    const [o] = await ctx.db.select().from(owners).where(eq(owners.id, args.ownerId));
    if (!o || o.businessId !== args.businessId) throw new NotFoundError('client');
    const row = await sendText(ctx, { businessId: args.businessId, ownerId: o.id, kind: 'manual', body: args.body, sentBy: args.actor });
    if (row.status !== 'sent') throw new ValidationError(`the text was not sent: ${row.error ?? row.status}`);
    return row;
  }
  const to = args.phone ? toE164(args.phone) : null;
  if (!to) throw new ValidationError('that is not a mobile number we can text');
  const leadRows = await ctx.db.select().from(leads).where(eq(leads.businessId, args.businessId));
  const lead = leadRows.find((l) => l.phone && toE164(l.phone) === to);
  if (lead) return messageLead(ctx, { businessId: args.businessId, leadId: lead.id, channel: 'sms', body: args.body, actor: args.actor });
  // Only someone who texted us first can be answered this way; this is not a way to text strangers.
  const [first] = await ctx.db
    .select({ id: smsMessages.id })
    .from(smsMessages)
    .where(and(eq(smsMessages.businessId, args.businessId), eq(smsMessages.to, to), eq(smsMessages.direction, 'in')))
    .limit(1);
  if (!first) throw new ValidationError('you can only reply to numbers that texted you');
  if (await optedOut(ctx, args.businessId, to)) throw new ValidationError('this number replied STOP; texts to it are blocked');
  const base = { businessId: args.businessId, ownerId: null, direction: 'out' as const, to, body: args.body, kind: 'manual' as const, sentBy: args.actor };
  try {
    const r = await (await ctx.smsFor(args.businessId)).send(to, args.body);
    const [row] = await ctx.db.insert(smsMessages).values({ ...base, status: 'sent', providerId: r.id }).returning();
    return row!;
  } catch (e) {
    await ctx.db.insert(smsMessages).values({ ...base, status: 'failed', error: String((e as Error).message).slice(0, 300) });
    throw new ValidationError(`the text did not go through: ${(e as Error).message}`);
  }
}

// ─── Report cards ────────────────────────────────────────────────────────────

const MOOD: Record<string, string> = { great: 'had a great day', good: 'had a good day', shy: 'was a little shy today', tired: 'is tired out' };

export function reportSummary(dog: string, n: typeof visitNotes.$inferSelect) {
  const d = n.details ?? {};
  const bits = [
    `${dog} ${MOOD[d.mood ?? 'good']}`,
    d.playmates?.length ? `played with ${d.playmates.join(', ')}` : null,
    d.ate ? (d.ate === 'all' ? 'ate everything' : d.ate === 'some' ? 'ate some lunch' : 'skipped lunch') : null,
  ].filter(Boolean);
  return `${bits.join(', ')}.`;
}

/** Today's report cards, and dogs that came in today without one. */
export async function reportCards(ctx: AppContext, businessId: string, date?: string) {
  const b = await loadBusiness(ctx.db, businessId);
  const day = date ?? localDateKey(ctx.now(), b.timezone);
  const t0 = new Date(dateKeyToInstant(day, b.timezone));
  const t1 = new Date(dateKeyToInstant(addLocalDays(day, 1), b.timezone));
  const cards = await ctx.db
    .select({ n: visitNotes, dog: dogs.name, owner: owners.name })
    .from(visitNotes)
    .innerJoin(dogs, eq(dogs.id, visitNotes.dogId))
    .innerJoin(owners, eq(owners.id, dogs.ownerId))
    .where(and(eq(visitNotes.businessId, businessId), eq(visitNotes.kind, 'report'), gte(visitNotes.createdAt, t0), sql`${visitNotes.createdAt} < ${t1}`))
    .orderBy(asc(dogs.name));
  const came = await ctx.db
    .select({ dogId: visits.dogId, dog: dogs.name, visitId: visits.id })
    .from(visits)
    .innerJoin(dogs, eq(dogs.id, visits.dogId))
    .where(and(eq(visits.businessId, businessId), gte(visits.checkedInAt, t0), sql`${visits.checkedInAt} < ${t1}`));
  const done = new Set(cards.map((c) => c.n.dogId));
  return {
    date: day,
    cards: cards.map((c) => ({ ...c.n, dog: c.dog, owner: c.owner })),
    missing: came.filter((c) => !done.has(c.dogId)),
  };
}

/** Send report cards: each owner gets a notification, and a text if the daycare turned that on. */
export async function sendReportCards(ctx: AppContext, args: { businessId: string; ids: readonly string[]; actor: string }) {
  if (!args.ids.length) return { sent: 0 };
  const b = await loadBusiness(ctx.db, args.businessId);
  const policies = withPolicyDefaults(b.policies);
  const rows = await ctx.db
    .select({ n: visitNotes, dog: dogs })
    .from(visitNotes)
    .innerJoin(dogs, eq(dogs.id, visitNotes.dogId))
    .where(and(eq(visitNotes.businessId, args.businessId), inArray(visitNotes.id, [...args.ids]), eq(visitNotes.kind, 'report'), isNull(visitNotes.sentAt)));
  for (const { n, dog } of rows) {
    // Claim it first so two people pressing Send don't notify twice.
    const [claimed] = await ctx.db
      .update(visitNotes)
      .set({ sentAt: new Date(ctx.now()), sharedWithOwner: true })
      .where(and(eq(visitNotes.id, n.id), isNull(visitNotes.sentAt)))
      .returning({ id: visitNotes.id });
    if (!claimed) continue;
    const summary = reportSummary(dog.name, n);
    await pushToOwner(ctx, dog.ownerId, `${dog.name}'s report card`, summary, { dogId: dog.id });
    if (policies.reportCardTexts) {
      await sendText(ctx, { businessId: args.businessId, ownerId: dog.ownerId, kind: 'report_card', body: `${b.name}: ${summary} See the full report card in the app.`, sentBy: args.actor });
    }
  }
  return { sent: rows.length };
}

// ─── Automatic friendly texts ────────────────────────────────────────────────

/** After a pickup: ask for a review, no more often than the daycare allows. */
export async function maybeAskForReview(ctx: AppContext, businessId: string, ownerId: string) {
  const b = await loadBusiness(ctx.db, businessId);
  const r = withPolicyDefaults(b.policies).reviewRequests;
  if (!r.enabled || !/^https:\/\//.test(r.url)) return false;
  const since = new Date(ctx.now() - r.everyDays * 86_400_000);
  const [recent] = await ctx.db
    .select({ id: smsMessages.id })
    .from(smsMessages)
    .where(and(eq(smsMessages.ownerId, ownerId), eq(smsMessages.kind, 'review'), gte(smsMessages.createdAt, since)))
    .limit(1);
  if (recent) return false;
  const [o] = await ctx.db.select({ name: owners.name }).from(owners).where(eq(owners.id, ownerId));
  const first = o?.name.split(' ')[0] ?? 'there';
  await sendText(ctx, { businessId, ownerId, kind: 'review', body: `Thanks for coming to ${b.name}, ${first}! If you have a minute, a review would mean a lot to us: ${r.url}` });
  return true;
}

/** Morning birthday texts, once a year per dog. */
export async function runBirthdayTexts(ctx: AppContext) {
  const all = await ctx.db.select().from(businesses);
  let sent = 0;
  for (const b of all) {
    if (!withPolicyDefaults(b.policies).birthdayTexts) continue;
    const today = localDateKey(ctx.now(), b.timezone);
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: b.timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ctx.now())));
    if (hour < 9) continue;
    const md = today.slice(5);
    const leap = Number(today.slice(0, 4)) % 4 === 0;
    // A Feb 29 birthday is celebrated on Feb 28 in other years.
    const wanted = !leap && md === '02-28' ? ['02-28', '02-29'] : [md];
    const list = await ctx.db.select().from(dogs).where(and(eq(dogs.businessId, b.id), eq(dogs.active, true)));
    for (const d of list) {
      if (!d.birthDate || !wanted.includes(d.birthDate.slice(5))) continue;
      const [already] = await ctx.db
        .select({ id: smsMessages.id })
        .from(smsMessages)
        .where(and(eq(smsMessages.ownerId, d.ownerId), eq(smsMessages.kind, 'birthday'), gte(smsMessages.createdAt, new Date(ctx.now() - 300 * 86_400_000)), sql`${smsMessages.body} like ${`%${d.name}%`}`))
        .limit(1);
      if (already) continue;
      const age = Number(today.slice(0, 4)) - Number(d.birthDate.slice(0, 4));
      await sendText(ctx, {
        businessId: b.id,
        ownerId: d.ownerId,
        kind: 'birthday',
        body: `Happy ${age > 0 ? `${age}${age % 10 === 1 && age !== 11 ? 'st' : age % 10 === 2 && age !== 12 ? 'nd' : age % 10 === 3 && age !== 13 ? 'rd' : 'th'} ` : ''}birthday, ${d.name}! 🎂 From all of us at ${b.name}.`,
      });
      sent++;
    }
  }
  return sent;
}

/** A client texted in: tell the managers. */
export async function notifyInbound(ctx: AppContext, businessId: string, ownerName: string, body: string, managerIds: string[]) {
  await pushToUsers(ctx, managerIds, `Text from ${ownerName}`, body.slice(0, 140));
}
