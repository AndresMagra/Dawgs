/**
 * Paid walks with live GPS.
 *
 * A manager (or the owner, from the customer app) books a walk; a manager
 * assigns a walker. The walker's phone starts the walk and streams points
 * while it runs; the owner can watch the route live. Finishing measures the
 * route, writes the report, charges a walk credit or the walk price, and
 * texts and pushes the owner a summary.
 */

import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { ConflictError, NotFoundError, ValidationError, formatMoney, summarizeWalk, type GpsPoint } from '@dawgs/core';
import { businesses, dogs, walkPoints, walkTypes, walks } from '@dawgs/db';
import type { AppContext } from './context.js';
import type { AuthContext } from './auth.js';
import { ForbiddenError } from './auth.js';
import { spendCredits, walletOf } from './credits.js';
import { createInvoice, payInvoice } from './payments.js';
import { pushToOwner, sendText } from './texts.js';
import { audit } from './audit.js';

export async function scheduleWalk(
  ctx: AppContext,
  args: { businessId: string; dogId: string; walkTypeId: string; scheduledAt: number; walkerId?: string | null; actor: string; byOwner: boolean },
) {
  const [dog] = await ctx.db.select().from(dogs).where(eq(dogs.id, args.dogId));
  if (!dog || dog.businessId !== args.businessId) throw new NotFoundError('dog');
  const [t] = await ctx.db.select().from(walkTypes).where(eq(walkTypes.id, args.walkTypeId));
  if (!t || t.businessId !== args.businessId || !t.active) throw new NotFoundError('walk type');
  if (args.scheduledAt < ctx.now() - 60 * 60_000) throw new ValidationError('that time has passed');
  const [w] = await ctx.db
    .insert(walks)
    .values({
      businessId: args.businessId,
      dogId: dog.id,
      walkTypeId: t.id,
      walkerId: args.walkerId ?? null,
      scheduledAt: new Date(args.scheduledAt),
      status: args.byOwner ? 'requested' : 'scheduled',
      priceCents: t.priceCents,
    })
    .returning();
  await audit(ctx.db, args.businessId, args.actor, 'walk.schedule', `${t.name} for ${dog.name}`);
  return w!;
}

async function loadWalk(ctx: AppContext, businessId: string, id: string) {
  const [w] = await ctx.db.select().from(walks).where(eq(walks.id, id));
  if (!w || w.businessId !== businessId) throw new NotFoundError('walk');
  return w;
}

/** Only the assigned walker (or a manager) may run a walk. */
function assertWalker(a: AuthContext, w: typeof walks.$inferSelect) {
  if (a.role === 'manager') return;
  if (a.role !== 'staff' || w.walkerId !== a.userId) throw new ForbiddenError('this walk is assigned to someone else');
}

export async function startWalk(ctx: AppContext, a: AuthContext, walkId: string) {
  const w = await loadWalk(ctx, a.businessId, walkId);
  assertWalker(a, w);
  if (w.status !== 'scheduled') throw new ConflictError(`walk is ${w.status}`);
  const [out] = await ctx.db
    .update(walks)
    .set({ status: 'in_progress', startedAt: new Date(ctx.now()), walkerId: w.walkerId ?? a.userId })
    .where(eq(walks.id, w.id))
    .returning();
  const [dog] = await ctx.db.select().from(dogs).where(eq(dogs.id, w.dogId));
  await pushToOwner(ctx, dog!.ownerId, `${dog!.name}'s walk started`, 'Tap to follow along live.', { walkId: w.id });
  return out!;
}

export async function addPoints(ctx: AppContext, a: AuthContext, walkId: string, points: readonly GpsPoint[]) {
  const w = await loadWalk(ctx, a.businessId, walkId);
  assertWalker(a, w);
  if (w.status !== 'in_progress') throw new ConflictError('walk is not running');
  if (!points.length) return { added: 0 };
  await ctx.db.insert(walkPoints).values(
    points.map((p) => ({ walkId: w.id, lat: p.lat, lng: p.lng, at: new Date(p.at), accuracy: p.accuracy ?? null })),
  );
  return { added: points.length };
}

export async function walkTrack(ctx: AppContext, walkId: string, since?: number) {
  const rows = await ctx.db
    .select()
    .from(walkPoints)
    .where(and(eq(walkPoints.walkId, walkId), ...(since ? [gte(walkPoints.at, new Date(since))] : [])))
    .orderBy(asc(walkPoints.at));
  return rows.map((r) => ({ lat: r.lat, lng: r.lng, at: r.at.getTime(), accuracy: r.accuracy }));
}

export async function finishWalk(
  ctx: AppContext,
  a: AuthContext,
  walkId: string,
  report: { pee?: boolean; poop?: boolean; report?: string | null },
) {
  const w = await loadWalk(ctx, a.businessId, walkId);
  assertWalker(a, w);
  if (w.status !== 'in_progress') throw new ConflictError('walk is not running');
  const now = ctx.now();
  const track = await walkTrack(ctx, w.id);
  const s = summarizeWalk(track);
  const durationMs = s.durationMs || now - (w.startedAt?.getTime() ?? now);
  const [done] = await ctx.db
    .update(walks)
    .set({
      status: 'done',
      endedAt: new Date(now),
      meters: s.meters,
      durationMs,
      pee: report.pee ?? null,
      poop: report.poop ?? null,
      report: report.report ?? null,
    })
    .where(and(eq(walks.id, w.id), eq(walks.status, 'in_progress')))
    .returning();
  if (!done) throw new ConflictError('walk already finished');

  const [dog] = await ctx.db.select().from(dogs).where(eq(dogs.id, w.dogId));
  const [t] = w.walkTypeId ? await ctx.db.select().from(walkTypes).where(eq(walkTypes.id, w.walkTypeId)) : [];
  const [biz] = await ctx.db.select().from(businesses).where(eq(businesses.id, w.businessId));
  const wallet = await walletOf(ctx.db, dog!.id, now);
  const lines = [{ kind: 'service' as const, text: `${t?.name ?? 'Walk'} for ${dog!.name}`, amount: w.priceCents }];
  if (wallet.walk > 0) {
    lines.push({ kind: 'service', text: 'Package credit: 1 walk', amount: -w.priceCents });
    await spendCredits(ctx.db, dog!.id, { walk: 1 }, now);
  }
  const inv = await createInvoice(ctx.db, { businessId: w.businessId, ownerId: dog!.ownerId, dogId: dog!.id, category: 'walks', lines });
  await ctx.db.update(walks).set({ invoiceId: inv.id }).where(eq(walks.id, w.id));
  const pay = await payInvoice(ctx, { businessId: w.businessId, invoiceId: inv.id, pay: { method: 'card' }, actor: a.name }).catch(
    () => null,
  );

  const miles = (s.meters / 1609.344).toFixed(2);
  const mins = Math.round(durationMs / 60_000);
  const bits = [report.pee ? 'pee' : null, report.poop ? 'poop' : null].filter(Boolean).join(' and ');
  const body = `${biz!.name}: ${dog!.name} walked ${miles} mi in ${mins} min${bits ? ` (${bits})` : ''}.${report.report ? ` "${report.report}"` : ''}${
    pay?.paid ? (inv.totalCents ? ` ${formatMoney(inv.totalCents)} charged.` : ' Used a walk credit.') : ''
  }`;
  await sendText(ctx, { businessId: w.businessId, ownerId: dog!.ownerId, kind: 'walk_report', body });
  await pushToOwner(ctx, dog!.ownerId, `${dog!.name}'s walk is done`, body, { walkId: w.id });
  await audit(ctx.db, w.businessId, a.name, 'walk.finish', `${dog!.name}: ${miles} mi, ${mins} min`);
  return { walk: done, summary: { ...s, durationMs }, invoice: pay?.invoice ?? inv, paid: pay?.paid ?? false };
}

export async function walksBetween(ctx: AppContext, businessId: string, from: number, to: number) {
  return ctx.db
    .select()
    .from(walks)
    .where(and(eq(walks.businessId, businessId), gte(walks.scheduledAt, new Date(from)), lte(walks.scheduledAt, new Date(to))))
    .orderBy(asc(walks.scheduledAt));
}
