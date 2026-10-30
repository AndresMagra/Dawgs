/**
 * Texts and push notifications to owners.
 *
 * Every text is logged, including the ones not sent (no phone, opted out,
 * provider error), so the desk can see why an owner says they heard nothing.
 * An owner who replies STOP is opted out; START opts them back in — carriers
 * require honouring both.
 */

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { pickupText, pickupTextDue, zonedParts } from '@dawgs/core';
import { businesses, dogs, owners, pushTokens, smsMessages, users, visits } from '@dawgs/db';
import type { AppContext } from './context.js';
import { toE164 } from './sms.js';

type Kind = (typeof smsMessages.$inferInsert)['kind'];

export async function sendText(
  ctx: AppContext,
  args: { businessId: string; ownerId: string; kind: Kind; body: string; sentBy?: string | null },
) {
  const [o] = await ctx.db.select().from(owners).where(eq(owners.id, args.ownerId));
  const to = o?.phone ? toE164(o.phone) : null;
  const base = {
    businessId: args.businessId,
    ownerId: args.ownerId,
    direction: 'out' as const,
    to: to ?? o?.phone ?? '',
    body: args.body,
    kind: args.kind,
    sentBy: args.sentBy ?? 'Automatic',
  };
  if (!o || !to) {
    const [row] = await ctx.db.insert(smsMessages).values({ ...base, status: 'skipped', error: 'no valid mobile number' }).returning();
    return row!;
  }
  if (!o.smsOptIn) {
    const [row] = await ctx.db.insert(smsMessages).values({ ...base, status: 'skipped', error: 'owner opted out of texts' }).returning();
    return row!;
  }
  try {
    const sms = await ctx.smsFor(args.businessId);
    const r = await sms.send(to, args.body);
    const [row] = await ctx.db.insert(smsMessages).values({ ...base, status: 'sent', providerId: r.id }).returning();
    return row!;
  } catch (e) {
    const [row] = await ctx.db
      .insert(smsMessages)
      .values({ ...base, status: 'failed', error: String((e as Error).message).slice(0, 300) })
      .returning();
    return row!;
  }
}

/** Push to every device an owner (or staff member) is signed in on. */
export async function pushToOwner(ctx: AppContext, ownerId: string, title: string, body: string, data?: Record<string, string>) {
  const tokens = await ctx.db
    .select({ token: pushTokens.token })
    .from(pushTokens)
    .innerJoin(users, eq(users.id, pushTokens.userId))
    .where(eq(users.ownerId, ownerId));
  await ctx.push.send(
    tokens.map((t) => t.token),
    { title, body, ...(data ? { data } : {}) },
  );
}

export async function pushToUsers(ctx: AppContext, userIds: readonly string[], title: string, body: string, data?: Record<string, string>) {
  if (!userIds.length) return;
  const tokens = await ctx.db.select({ token: pushTokens.token }).from(pushTokens).where(inArray(pushTokens.userId, [...userIds]));
  await ctx.push.send(
    tokens.map((t) => t.token),
    { title, body, ...(data ? { data } : {}) },
  );
}

function clock(t: number, tz: string): string {
  const p = zonedParts(t, tz);
  const h = p.hour % 12 || 12;
  return `${h}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

/** The scheduler's pickup pass: one text per visit, inside the last hour before pickup. */
export async function runPickupTexts(ctx: AppContext) {
  const now = ctx.now();
  const open = await ctx.db
    .select({ v: visits, dog: dogs, biz: businesses })
    .from(visits)
    .innerJoin(dogs, eq(dogs.id, visits.dogId))
    .innerJoin(businesses, eq(businesses.id, visits.businessId))
    .where(and(isNull(visits.checkedOutAt), isNull(visits.pickupTextSentAt), isNotNull(visits.plannedPickupAt)));
  let sent = 0;
  for (const { v, dog, biz } of open) {
    if (!biz.pickupTextsEnabled) continue;
    if (!pickupTextDue({ plannedPickupAt: v.plannedPickupAt!.getTime(), now, alreadySent: false })) continue;
    // Claim the visit first so two nodes never both text.
    const [claimed] = await ctx.db
      .update(visits)
      .set({ pickupTextSentAt: new Date(now) })
      .where(and(eq(visits.id, v.id), isNull(visits.pickupTextSentAt)))
      .returning();
    if (!claimed) continue;
    const body = pickupText(dog.name, clock(v.plannedPickupAt!.getTime(), biz.timezone), biz.name);
    await sendText(ctx, { businessId: biz.id, ownerId: dog.ownerId, kind: 'pickup', body });
    await pushToOwner(ctx, dog.ownerId, `${dog.name} is almost ready`, body);
    sent++;
  }
  return sent;
}

