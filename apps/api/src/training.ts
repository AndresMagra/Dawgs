/**
 * Training: classes, private lessons, enrollment, attendance and progress.
 *
 * Paying for a class enrolls the dog (through invoice fulfilment, like
 * packs). A private lesson can instead spend one training credit from a pack.
 * Progress marks are shared with the owner unless the trainer says not to.
 */

import { and, asc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { ConflictError, NotFoundError, ValidationError } from '@dawgs/core';
import {
  dogs,
  trainingAttendance,
  trainingEnrollments,
  trainingProgress,
  trainingPrograms,
  trainingSessions,
  users,
} from '@dawgs/db';
import type { AppContext } from './context.js';
import { createInvoice, payInvoice } from './payments.js';
import { spendCredits, walletOf } from './credits.js';
import type { PayInput } from './util.js';
import { pushToOwner, pushToUsers } from './texts.js';
import { audit } from './audit.js';

async function program(ctx: AppContext, businessId: string, id: string) {
  const [p] = await ctx.db.select().from(trainingPrograms).where(eq(trainingPrograms.id, id));
  if (!p || p.businessId !== businessId) throw new NotFoundError('program');
  return p;
}

export async function enrolledCount(ctx: AppContext, programId: string) {
  const [r] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(trainingEnrollments)
    .where(and(eq(trainingEnrollments.programId, programId), inArray(trainingEnrollments.status, ['enrolled', 'pending_payment'])));
  return r?.n ?? 0;
}

/** Enroll a dog in a group class and charge for it. */
export async function enroll(
  ctx: AppContext,
  args: { businessId: string; programId: string; dogId: string; pay: PayInput; actor: string },
) {
  const p = await program(ctx, args.businessId, args.programId);
  if (p.kind !== 'class' || !p.active) throw new ValidationError('that is not an open class');
  const [dog] = await ctx.db.select().from(dogs).where(eq(dogs.id, args.dogId));
  if (!dog || dog.businessId !== args.businessId) throw new NotFoundError('dog');
  const [dup] = await ctx.db
    .select()
    .from(trainingEnrollments)
    .where(and(eq(trainingEnrollments.programId, p.id), eq(trainingEnrollments.dogId, dog.id), ne(trainingEnrollments.status, 'dropped')));
  if (dup) throw new ConflictError(`${dog.name} is already in this class`);
  if ((await enrolledCount(ctx, p.id)) >= p.capacity) throw new ConflictError('the class is full');
  const [e] = await ctx.db
    .insert(trainingEnrollments)
    .values({ businessId: args.businessId, programId: p.id, dogId: dog.id, status: 'pending_payment' })
    .returning();
  const inv = await createInvoice(ctx.db, {
    businessId: args.businessId,
    ownerId: dog.ownerId,
    dogId: dog.id,
    category: 'training',
    lines: [{ kind: 'service', text: `${p.name} for ${dog.name} (${p.sessionCount} sessions)`, amount: p.priceCents }],
    fulfilment: { type: 'training', enrollmentId: e!.id },
  });
  await ctx.db.update(trainingEnrollments).set({ invoiceId: inv.id }).where(eq(trainingEnrollments.id, e!.id));
  await audit(ctx.db, args.businessId, args.actor, 'training.enroll', `${dog.name} → ${p.name}`);
  const out = await payInvoice(ctx, { businessId: args.businessId, invoiceId: inv.id, pay: args.pay, actor: args.actor });
  return { ...out, enrollmentId: e!.id };
}

/**
 * Book a private lesson for one dog. Uses a training credit when the dog
 * has one; otherwise invoices the lesson.
 */
export async function bookPrivate(
  ctx: AppContext,
  args: { businessId: string; programId: string; dogId: string; startsAt: number; trainerId?: string | null; pay: PayInput; actor: string },
) {
  const p = await program(ctx, args.businessId, args.programId);
  if (p.kind !== 'private' || !p.active) throw new ValidationError('that is not a private lesson');
  const [dog] = await ctx.db.select().from(dogs).where(eq(dogs.id, args.dogId));
  if (!dog || dog.businessId !== args.businessId) throw new NotFoundError('dog');
  const trainerId = args.trainerId ?? p.trainerId;
  const endsAt = args.startsAt + p.sessionMinutes * 60_000;
  if (trainerId) {
    const clash = await ctx.db
      .select({ id: trainingSessions.id })
      .from(trainingSessions)
      .where(
        and(
          eq(trainingSessions.trainerId, trainerId),
          ne(trainingSessions.status, 'cancelled'),
          lt(trainingSessions.startsAt, new Date(endsAt)),
          gte(trainingSessions.endsAt, new Date(args.startsAt + 1)),
        ),
      );
    if (clash.length) throw new ConflictError('the trainer is busy then');
  }
  const [s] = await ctx.db
    .insert(trainingSessions)
    .values({
      businessId: args.businessId,
      programId: p.id,
      trainerId: trainerId ?? null,
      startsAt: new Date(args.startsAt),
      endsAt: new Date(endsAt),
      dogId: dog.id,
    })
    .returning();
  const wallet = await walletOf(ctx.db, dog.id, ctx.now());
  const lines = [{ kind: 'service' as const, text: `${p.name} for ${dog.name}`, amount: p.priceCents }];
  if (wallet.training > 0) {
    lines.push({ kind: 'service', text: 'Package credit: 1 training session', amount: -p.priceCents });
    await spendCredits(ctx.db, dog.id, { training: 1 }, ctx.now());
  }
  const inv = await createInvoice(ctx.db, { businessId: args.businessId, ownerId: dog.ownerId, dogId: dog.id, category: 'training', lines });
  if (trainerId) await pushToUsers(ctx, [trainerId], 'Private lesson booked', `${dog.name}, ${p.name}`);
  await audit(ctx.db, args.businessId, args.actor, 'training.private', `${dog.name}: ${p.name}`);
  const out = await payInvoice(ctx, { businessId: args.businessId, invoiceId: inv.id, pay: args.pay, actor: args.actor });
  return { ...out, session: s! };
}

/** The roster for a session: enrolled dogs for a class, the one dog for a private lesson. */
export async function roster(ctx: AppContext, businessId: string, sessionId: string) {
  const [s] = await ctx.db.select().from(trainingSessions).where(eq(trainingSessions.id, sessionId));
  if (!s || s.businessId !== businessId) throw new NotFoundError('session');
  const dogIds = s.dogId
    ? [s.dogId]
    : (
        await ctx.db
          .select({ dogId: trainingEnrollments.dogId })
          .from(trainingEnrollments)
          .where(and(eq(trainingEnrollments.programId, s.programId), eq(trainingEnrollments.status, 'enrolled')))
      ).map((x) => x.dogId);
  const ds = dogIds.length ? await ctx.db.select().from(dogs).where(inArray(dogs.id, dogIds)) : [];
  const att = await ctx.db.select().from(trainingAttendance).where(eq(trainingAttendance.sessionId, s.id));
  return { session: s, dogs: ds.map((d) => ({ id: d.id, name: d.name, attendance: att.find((x) => x.dogId === d.id) ?? null })) };
}

export async function markAttendance(
  ctx: AppContext,
  args: { businessId: string; sessionId: string; marks: { dogId: string; attended: boolean; note?: string | null }[] },
) {
  const { session } = await roster(ctx, args.businessId, args.sessionId);
  for (const m of args.marks) {
    await ctx.db
      .insert(trainingAttendance)
      .values({ businessId: args.businessId, sessionId: session.id, dogId: m.dogId, attended: m.attended, note: m.note ?? null })
      .onConflictDoUpdate({
        target: [trainingAttendance.sessionId, trainingAttendance.dogId],
        set: { attended: m.attended, note: m.note ?? null },
      });
  }
  await ctx.db.update(trainingSessions).set({ status: 'done' }).where(eq(trainingSessions.id, session.id));
  return { ok: true };
}

export async function addProgress(
  ctx: AppContext,
  args: {
    businessId: string;
    dogId: string;
    programId?: string | null;
    skill: string;
    level: number;
    note?: string | null;
    homework?: string | null;
    sharedWithOwner?: boolean;
    author: string;
  },
) {
  const [dog] = await ctx.db.select().from(dogs).where(eq(dogs.id, args.dogId));
  if (!dog || dog.businessId !== args.businessId) throw new NotFoundError('dog');
  const [row] = await ctx.db
    .insert(trainingProgress)
    .values({
      businessId: args.businessId,
      dogId: dog.id,
      programId: args.programId ?? null,
      skill: args.skill,
      level: args.level,
      note: args.note ?? null,
      homework: args.homework ?? null,
      sharedWithOwner: args.sharedWithOwner ?? true,
      author: args.author,
    })
    .returning();
  if (row!.sharedWithOwner) {
    await pushToOwner(ctx, dog.ownerId, `${dog.name}'s training`, `${args.skill}: ${LEVELS[args.level]}${args.homework ? ` · Homework: ${args.homework}` : ''}`);
  }
  return row!;
}

export const LEVELS = ['Not started', 'Learning', 'With help', 'Reliable', 'Mastered'];

/** Latest level per skill, plus the full history, for one dog. */
export async function progressFor(ctx: AppContext, dogId: string, sharedOnly: boolean) {
  const rows = await ctx.db
    .select()
    .from(trainingProgress)
    .where(and(eq(trainingProgress.dogId, dogId), ...(sharedOnly ? [eq(trainingProgress.sharedWithOwner, true)] : [])))
    .orderBy(asc(trainingProgress.createdAt));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latest.set(r.skill, r);
  return {
    skills: [...latest.values()].map((r) => ({ skill: r.skill, level: r.level, label: LEVELS[r.level], at: r.createdAt })),
    history: rows.reverse(),
  };
}

export async function trainers(ctx: AppContext, businessId: string) {
  return ctx.db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.businessId, businessId), ne(users.role, 'owner'), eq(users.active, true)));
}
