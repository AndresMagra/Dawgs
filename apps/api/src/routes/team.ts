/**
 * The team: staff accounts, time clock, schedule, requests, payroll, and the
 * internal chat between managers and staff (owners never see it).
 */

import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ConflictError, ValidationError, addLocalDays, dateKeyToInstant, msToHours, weeklyPay, workedMs } from '@dawgs/core';
import { certifications, chatMessages, chatReads, shifts, staffRequests, timePunches, users } from '@dawgs/db';
import type { AppContext } from '../context.js';
import { checkPassword, isManager, publicUser, requireManager, requireStaff, sameBusiness, type AuthContext } from '../auth.js';
import { hashPassword } from '../crypto.js';
import { cents, dateKey, parse, uuid } from '../util.js';
import { loadBusiness } from '../ops.js';
import { pushToUsers } from '../texts.js';
import { audit } from '../audit.js';

const staffShape = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().nullable().optional(),
  role: z.enum(['manager', 'staff']),
  jobTitle: z.string().nullable().optional(),
  payRateCents: cents.nullable().optional(),
  hiredOn: dateKey.nullable().optional(),
  ptoHours: z.number().min(0).optional(),
  active: z.boolean().optional(),
});

/** `team`, or a direct channel named by the two user ids in sorted order. */
export function dmChannel(a: string, b: string) {
  return [a, b].sort().join(':');
}

async function mayUseChannel(ctx: AppContext, a: AuthContext, channel: string) {
  if (channel === 'team') return true;
  const ids = channel.split(':');
  if (ids.length !== 2 || !ids.includes(a.userId)) return false;
  const other = ids.find((x) => x !== a.userId) ?? a.userId;
  const [u] = await ctx.db.select().from(users).where(eq(users.id, other));
  if (!u || u.businessId !== a.businessId || u.role === 'owner') return false;
  // Staff talk to managers; managers talk to anyone on the team.
  return isManager(a) || u.role === 'manager';
}

export function registerTeamRoutes(app: FastifyInstance, ctx: AppContext) {
  // ─── Staff accounts ──────────────────────────────────────────────────────
  app.get('/staff', async (req) => {
    const a = requireStaff(req);
    const rows = await ctx.db
      .select()
      .from(users)
      .where(and(eq(users.businessId, a.businessId), inArray(users.role, ['manager', 'staff'])))
      .orderBy(users.name);
    const certs = await ctx.db.select().from(certifications).where(eq(certifications.businessId, a.businessId));
    const open = await ctx.db
      .select()
      .from(timePunches)
      .where(and(eq(timePunches.businessId, a.businessId), isNull(timePunches.outAt)));
    return rows.map((u) => ({
      ...publicUser(u),
      active: u.active,
      onClock: open.some((p) => p.userId === u.id),
      // Pay and hire details are for managers.
      ...(isManager(a) ? { payRateCents: u.payRateCents, hiredOn: u.hiredOn, ptoHours: u.ptoHours, certifications: certs.filter((c) => c.userId === u.id) } : {}),
    }));
  });

  app.post('/staff', async (req) => {
    const a = requireManager(req);
    const b = parse(staffShape.extend({ password: z.string() }), req.body);
    checkPassword(b.password);
    const email = b.email.toLowerCase();
    const [dup] = await ctx.db.select().from(users).where(and(eq(users.businessId, a.businessId), eq(users.email, email)));
    if (dup) throw new ConflictError('someone already uses that email');
    const [u] = await ctx.db
      .insert(users)
      .values({
        businessId: a.businessId,
        role: b.role,
        name: b.name,
        email,
        phone: b.phone ?? null,
        jobTitle: b.jobTitle ?? null,
        payRateCents: b.payRateCents ?? null,
        hiredOn: b.hiredOn ?? null,
        ptoHours: b.ptoHours ?? 0,
        passwordHash: hashPassword(b.password),
      })
      .returning();
    await audit(ctx.db, a.businessId, a.name, 'staff.create', `${u!.name} joined as ${b.role}`);
    return publicUser(u!);
  });

  app.patch('/staff/:id', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const b = parse(staffShape.partial().extend({ password: z.string().optional() }), req.body);
    const [u] = await ctx.db.select().from(users).where(eq(users.id, id));
    sameBusiness(a, u, 'staff member');
    if (u!.role === 'owner') throw new ValidationError('that is a customer account');
    if (id === a.userId && (b.role === 'staff' || b.active === false)) throw new ValidationError('you cannot demote or deactivate yourself');
    const { password, ...rest } = b;
    const set: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    if (password) {
      checkPassword(password);
      set.passwordHash = hashPassword(password);
    }
    if (set.email) set.email = String(set.email).toLowerCase();
    const [out] = await ctx.db.update(users).set(set).where(eq(users.id, id)).returning();
    return publicUser(out!);
  });

  app.post('/staff/:id/certifications', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const b = parse(z.object({ name: z.string().min(1), expiresOn: dateKey.nullable().optional() }), req.body);
    const [u] = await ctx.db.select().from(users).where(eq(users.id, id));
    sameBusiness(a, u, 'staff member');
    const [c] = await ctx.db.insert(certifications).values({ businessId: a.businessId, userId: id, name: b.name, expiresOn: b.expiresOn ?? null }).returning();
    return c;
  });

  app.delete('/certifications/:id', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const [c] = await ctx.db.select().from(certifications).where(eq(certifications.id, id));
    sameBusiness(a, c, 'certification');
    await ctx.db.delete(certifications).where(eq(certifications.id, id));
    return { ok: true };
  });

  // ─── Time clock ──────────────────────────────────────────────────────────
  app.get('/clock', async (req) => {
    const a = requireStaff(req);
    const [open] = await ctx.db.select().from(timePunches).where(and(eq(timePunches.userId, a.userId), isNull(timePunches.outAt)));
    return { onClock: Boolean(open), since: open?.inAt ?? null };
  });

  app.post('/clock/in', async (req) => {
    const a = requireStaff(req);
    const [open] = await ctx.db.select().from(timePunches).where(and(eq(timePunches.userId, a.userId), isNull(timePunches.outAt)));
    if (open) throw new ConflictError('already clocked in');
    const [p] = await ctx.db.insert(timePunches).values({ businessId: a.businessId, userId: a.userId, inAt: new Date(ctx.now()) }).returning();
    return p;
  });

  app.post('/clock/out', async (req) => {
    const a = requireStaff(req);
    const [p] = await ctx.db
      .update(timePunches)
      .set({ outAt: new Date(ctx.now()) })
      .where(and(eq(timePunches.userId, a.userId), isNull(timePunches.outAt)))
      .returning();
    if (!p) throw new ConflictError('not clocked in');
    return p;
  });

  /** A manager's correction of a missed or wrong punch. */
  app.post('/punches', async (req) => {
    const a = requireManager(req);
    const b = parse(z.object({ userId: uuid, inAt: z.number().int(), outAt: z.number().int().nullable() }), req.body);
    const [u] = await ctx.db.select().from(users).where(eq(users.id, b.userId));
    sameBusiness(a, u, 'staff member');
    if (b.outAt && b.outAt <= b.inAt) throw new ValidationError('out must be after in');
    const [p] = await ctx.db
      .insert(timePunches)
      .values({ businessId: a.businessId, userId: b.userId, inAt: new Date(b.inAt), outAt: b.outAt ? new Date(b.outAt) : null })
      .returning();
    await audit(ctx.db, a.businessId, a.name, 'punch.manual', `Punch added for ${u!.name}`);
    return p;
  });

  app.get('/punches', async (req) => {
    const a = requireStaff(req);
    const q = parse(z.object({ from: z.coerce.number().int(), to: z.coerce.number().int(), userId: uuid.optional() }), req.query);
    const who = isManager(a) ? q.userId : a.userId;
    return ctx.db
      .select()
      .from(timePunches)
      .where(
        and(
          eq(timePunches.businessId, a.businessId),
          gte(timePunches.inAt, new Date(q.from)),
          lt(timePunches.inAt, new Date(q.to)),
          ...(who ? [eq(timePunches.userId, who)] : []),
        ),
      )
      .orderBy(asc(timePunches.inAt));
  });

  // ─── Schedule ────────────────────────────────────────────────────────────
  app.get('/shifts', async (req) => {
    const a = requireStaff(req);
    const q = parse(z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() }), req.query);
    return ctx.db
      .select()
      .from(shifts)
      .where(and(eq(shifts.businessId, a.businessId), gte(shifts.startsAt, new Date(q.from)), lt(shifts.startsAt, new Date(q.to))))
      .orderBy(asc(shifts.startsAt));
  });

  app.post('/shifts', async (req) => {
    const a = requireManager(req);
    const b = parse(z.object({ userId: uuid, startsAt: z.number().int(), endsAt: z.number().int() }), req.body);
    if (b.endsAt <= b.startsAt) throw new ValidationError('shift must end after it starts');
    const [u] = await ctx.db.select().from(users).where(eq(users.id, b.userId));
    sameBusiness(a, u, 'staff member');
    const [s] = await ctx.db
      .insert(shifts)
      .values({ businessId: a.businessId, userId: b.userId, startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt) })
      .returning();
    await pushToUsers(ctx, [b.userId], 'Schedule updated', 'You have a new shift.');
    return s;
  });

  app.delete('/shifts/:id', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const [s] = await ctx.db.select().from(shifts).where(eq(shifts.id, id));
    sameBusiness(a, s, 'shift');
    await ctx.db.delete(shifts).where(eq(shifts.id, id));
    return { ok: true };
  });

  // ─── Requests (time off, swaps) ──────────────────────────────────────────
  app.get('/requests', async (req) => {
    const a = requireStaff(req);
    const rows = await ctx.db
      .select({ r: staffRequests, name: users.name })
      .from(staffRequests)
      .innerJoin(users, eq(users.id, staffRequests.userId))
      .where(and(eq(staffRequests.businessId, a.businessId), ...(isManager(a) ? [] : [eq(staffRequests.userId, a.userId)])))
      .orderBy(desc(staffRequests.createdAt));
    return rows.map((x) => ({ ...x.r, userName: x.name }));
  });

  app.post('/requests', async (req) => {
    const a = requireStaff(req);
    const b = parse(
      z.object({
        kind: z.enum(['time_off', 'swap', 'other']),
        fromDate: dateKey.nullable().optional(),
        toDate: dateKey.nullable().optional(),
        hours: z.number().min(0).nullable().optional(),
        note: z.string().nullable().optional(),
      }),
      req.body,
    );
    const [r] = await ctx.db
      .insert(staffRequests)
      .values({
        businessId: a.businessId,
        userId: a.userId,
        kind: b.kind,
        fromDate: b.fromDate ?? null,
        toDate: b.toDate ?? null,
        hours: b.hours ?? null,
        note: b.note ?? null,
        status: 'pending',
      })
      .returning();
    const managers = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.businessId, a.businessId), eq(users.role, 'manager')));
    await pushToUsers(ctx, managers.map((m) => m.id), 'New staff request', `${a.name} sent a request.`);
    return r;
  });

  app.post('/requests/:id/decide', async (req) => {
    const a = requireManager(req);
    const { id } = req.params as { id: string };
    const { status } = parse(z.object({ status: z.enum(['approved', 'denied']) }), req.body);
    const [r] = await ctx.db.select().from(staffRequests).where(eq(staffRequests.id, id));
    sameBusiness(a, r, 'request');
    if (r!.status !== 'pending') throw new ConflictError('already decided');
    await ctx.db.update(staffRequests).set({ status, decidedBy: a.name }).where(eq(staffRequests.id, id));
    if (status === 'approved' && r!.kind === 'time_off' && r!.hours) {
      await ctx.db.update(users).set({ ptoHours: sql`greatest(0, ${users.ptoHours} - ${r!.hours})` }).where(eq(users.id, r!.userId));
    }
    await pushToUsers(ctx, [r!.userId], `Request ${status}`, `${a.name} ${status} your request.`);
    return { ok: true };
  });

  // ─── Payroll ─────────────────────────────────────────────────────────────
  /** Hours and gross pay for a Monday-to-Sunday week, ready to hand to a payroll provider. */
  app.get('/payroll', async (req) => {
    const a = requireManager(req);
    const { weekStart } = parse(z.object({ weekStart: dateKey }), req.query);
    const b = await loadBusiness(ctx.db, a.businessId);
    const from = dateKeyToInstant(weekStart, b.timezone);
    const to = dateKeyToInstant(addLocalDays(weekStart, 7), b.timezone);
    const team = await ctx.db.select().from(users).where(and(eq(users.businessId, a.businessId), inArray(users.role, ['manager', 'staff'])));
    const punches = await ctx.db
      .select()
      .from(timePunches)
      .where(and(eq(timePunches.businessId, a.businessId), gte(timePunches.inAt, new Date(from)), lt(timePunches.inAt, new Date(to))));
    const rows = team.map((u) => {
      const mine = punches.filter((p) => p.userId === u.id).map((p) => ({ inAt: p.inAt.getTime(), outAt: p.outAt?.getTime() ?? null }));
      const hours = msToHours(workedMs(mine, Math.min(ctx.now(), to)));
      const pay = weeklyPay(hours, u.payRateCents ?? 0);
      return { userId: u.id, name: u.name, rateCents: u.payRateCents, hours, ...pay, openPunch: mine.some((p) => p.outAt == null) };
    });
    return { weekStart, rows, totalGrossCents: rows.reduce((s, r) => s + r.gross, 0) };
  });

  // ─── Chat ────────────────────────────────────────────────────────────────
  app.get('/chat', async (req) => {
    const a = requireStaff(req);
    const team = await ctx.db
      .select({ id: users.id, name: users.name, role: users.role })
      .from(users)
      .where(and(eq(users.businessId, a.businessId), inArray(users.role, ['manager', 'staff']), eq(users.active, true)));
    const others = team.filter((u) => u.id !== a.userId && (isManager(a) || u.role === 'manager'));
    const channels = ['team', ...others.map((u) => dmChannel(a.userId, u.id))];
    const reads = await ctx.db.select().from(chatReads).where(eq(chatReads.userId, a.userId));
    const counts = await ctx.db
      .select({ channel: chatMessages.channel, last: sql<Date>`max(${chatMessages.createdAt})` })
      .from(chatMessages)
      .where(and(eq(chatMessages.businessId, a.businessId), inArray(chatMessages.channel, channels)))
      .groupBy(chatMessages.channel);
    const unread = await Promise.all(
      channels.map(async (ch) => {
        const since = reads.find((r) => r.channel === ch)?.readAt ?? new Date(0);
        const [{ n }] = (await ctx.db
          .select({ n: sql<number>`count(*)::int` })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.businessId, a.businessId),
              eq(chatMessages.channel, ch),
              gte(chatMessages.createdAt, since),
              sql`${chatMessages.fromUserId} <> ${a.userId}`,
            ),
          )) as [{ n: number }];
        return n;
      }),
    );
    return channels.map((ch, i) => ({
      channel: ch,
      name: ch === 'team' ? 'Whole team' : (others.find((u) => dmChannel(a.userId, u.id) === ch)?.name ?? 'Chat'),
      unread: unread[i],
      lastAt: counts.find((c) => c.channel === ch)?.last ?? null,
    }));
  });

  app.get('/chat/:channel', async (req) => {
    const a = requireStaff(req);
    const { channel } = req.params as { channel: string };
    if (!(await mayUseChannel(ctx, a, channel))) throw new ValidationError('no such chat');
    const msgs = await ctx.db
      .select({ m: chatMessages, from: users.name })
      .from(chatMessages)
      .innerJoin(users, eq(users.id, chatMessages.fromUserId))
      .where(and(eq(chatMessages.businessId, a.businessId), eq(chatMessages.channel, channel)))
      .orderBy(desc(chatMessages.createdAt))
      .limit(200);
    await ctx.db
      .insert(chatReads)
      .values({ userId: a.userId, channel, readAt: new Date(ctx.now()) })
      .onConflictDoUpdate({ target: [chatReads.userId, chatReads.channel], set: { readAt: new Date(ctx.now()) } });
    return msgs.reverse().map((x) => ({ ...x.m, fromName: x.from }));
  });

  app.post('/chat/:channel', async (req) => {
    const a = requireStaff(req);
    const { channel } = req.params as { channel: string };
    const { body } = parse(z.object({ body: z.string().min(1).max(2000) }), req.body);
    if (!(await mayUseChannel(ctx, a, channel))) throw new ValidationError('no such chat');
    const [m] = await ctx.db
      .insert(chatMessages)
      .values({ businessId: a.businessId, channel, fromUserId: a.userId, body, createdAt: new Date(ctx.now()) })
      .returning();
    const targets =
      channel === 'team'
        ? (await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.businessId, a.businessId), inArray(users.role, ['manager', 'staff'])))).map((u) => u.id)
        : channel.split(':');
    await pushToUsers(ctx, targets.filter((t) => t !== a.userId), a.name, body.slice(0, 120), { channel });
    return m;
  });
}

export { or };
