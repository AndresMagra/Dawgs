/**
 * Reports for the manager, over a range of local days: what came in and from
 * which service, who the best clients are, how full boarding is, what is owed
 * in prepaid credits, and staff hours. Exports give the same data as CSV.
 */

import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { addLocalDays, dateKeyToInstant, localDateKey } from '@dawgs/core';
import { bookings, creditGrants, dogs, invoices, kennels, owners, payments, timePunches, users } from '@dawgs/db';
import type { AppContext } from './context.js';
import { loadBusiness } from './ops.js';

async function bounds(ctx: AppContext, businessId: string, from: string, to: string) {
  const b = await loadBusiness(ctx.db, businessId);
  return { b, t0: new Date(dateKeyToInstant(from, b.timezone)), t1: new Date(dateKeyToInstant(addLocalDays(to, 1), b.timezone)) };
}

export async function revenueReport(ctx: AppContext, businessId: string, from: string, to: string) {
  const { b, t0, t1 } = await bounds(ctx, businessId, from, to);
  const rows = await ctx.db
    .select({ at: payments.createdAt, net: sql<number>`${payments.amountCents} - ${payments.refundedCents}`, category: invoices.category, lines: invoices.lines, total: invoices.totalCents })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(and(eq(payments.businessId, businessId), eq(payments.status, 'succeeded'), gte(payments.createdAt, t0), lt(payments.createdAt, t1)));
  const byService = new Map<string, number>();
  const byDay = new Map<string, number>();
  let tips = 0;
  let tax = 0;
  for (const r of rows) {
    byService.set(r.category, (byService.get(r.category) ?? 0) + r.net);
    const day = localDateKey(r.at.getTime(), b.timezone);
    byDay.set(day, (byDay.get(day) ?? 0) + r.net);
    // Tips and tax belong to the staff and the state; show them so they aren't mistaken for income.
    const share = r.total > 0 ? r.net / r.total : 0;
    for (const l of r.lines) {
      if (l.kind === 'tip') tips += Math.round(l.amount * share);
      if (l.kind === 'tax') tax += Math.round(l.amount * share);
    }
  }
  const days: { day: string; cents: number }[] = [];
  for (let d = from; d <= to; d = addLocalDays(d, 1)) days.push({ day: d, cents: byDay.get(d) ?? 0 });
  const total = [...byService.values()].reduce((s, n) => s + n, 0);
  return {
    from,
    to,
    totalCents: total,
    tipsCents: tips,
    taxCents: tax,
    byService: [...byService].map(([service, cents]) => ({ service, cents })).sort((a, b2) => b2.cents - a.cents),
    byDay: days,
  };
}

export async function topClients(ctx: AppContext, businessId: string, from: string, to: string, limit = 10) {
  const { t0, t1 } = await bounds(ctx, businessId, from, to);
  return ctx.db
    .select({ ownerId: owners.id, name: owners.name, cents: sql<number>`sum(${payments.amountCents} - ${payments.refundedCents})::int`, payments: sql<number>`count(*)::int` })
    .from(payments)
    .innerJoin(owners, eq(owners.id, payments.ownerId))
    .where(and(eq(payments.businessId, businessId), eq(payments.status, 'succeeded'), gte(payments.createdAt, t0), lt(payments.createdAt, t1)))
    .groupBy(owners.id, owners.name)
    .orderBy(sql`3 desc`)
    .limit(limit);
}

/** Kennels booked for each of the next 14 nights. */
export async function occupancy(ctx: AppContext, businessId: string) {
  const b = await loadBusiness(ctx.db, businessId);
  const today = localDateKey(ctx.now(), b.timezone);
  const last = addLocalDays(today, 13);
  const [{ n }] = (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(kennels).where(and(eq(kennels.businessId, businessId), eq(kennels.active, true)))) as [{ n: number }];
  const stays = await ctx.db
    .select({ arrive: bookings.arrive, depart: bookings.depart })
    .from(bookings)
    .where(and(eq(bookings.businessId, businessId), eq(bookings.service, 'boarding'), inArray(bookings.status, ['requested', 'confirmed', 'checked_in']), lt(bookings.arrive, addLocalDays(last, 1)), gte(bookings.depart, today)));
  const nights: { night: string; booked: number; kennels: number }[] = [];
  for (let d = today; d <= last; d = addLocalDays(d, 1)) {
    // A stay covers the nights from arrival up to, not including, departure.
    nights.push({ night: d, booked: stays.filter((s) => s.arrive! <= d && s.depart! > d).length, kennels: n });
  }
  return nights;
}

/** Money taken for credits not used yet: what the daycare still owes in service. */
export async function creditLiability(ctx: AppContext, businessId: string) {
  const rows = await ctx.db
    .select({ g: creditGrants, paid: invoices.totalCents, status: invoices.status })
    .from(creditGrants)
    .leftJoin(invoices, eq(invoices.id, creditGrants.invoiceId))
    .where(and(eq(creditGrants.businessId, businessId), or(isNull(creditGrants.expiresAt), gte(creditGrants.expiresAt, new Date(ctx.now())))));
  const byKind = new Map<string, { credits: number; cents: number }>();
  let cents = 0;
  for (const { g, paid, status } of rows) {
    const granted = Object.values(g.credits).reduce((s, n) => s + (n ?? 0), 0);
    const left = Object.values(g.remaining).reduce((s, n) => s + (n ?? 0), 0);
    if (!left) continue;
    // Gifted credits cost the client nothing, so they owe nothing back.
    const value = paid && status === 'paid' && granted ? Math.round((paid * left) / granted) : 0;
    cents += value;
    for (const [k, n] of Object.entries(g.remaining)) {
      if (!n) continue;
      const cur = byKind.get(k) ?? { credits: 0, cents: 0 };
      byKind.set(k, { credits: cur.credits + n, cents: cur.cents + (granted ? Math.round((value * n) / left) : 0) });
    }
  }
  return { cents, byKind: [...byKind].map(([kind, v]) => ({ kind, ...v })) };
}

export async function staffHours(ctx: AppContext, businessId: string, from: string, to: string) {
  const { t0, t1 } = await bounds(ctx, businessId, from, to);
  const rows = await ctx.db
    .select({ userId: users.id, name: users.name, inAt: timePunches.inAt, outAt: timePunches.outAt })
    .from(timePunches)
    .innerJoin(users, eq(users.id, timePunches.userId))
    .where(and(eq(timePunches.businessId, businessId), gte(timePunches.inAt, t0), lt(timePunches.inAt, t1)))
    .orderBy(asc(users.name));
  const by = new Map<string, { name: string; minutes: number; shifts: number }>();
  for (const r of rows) {
    const end = r.outAt?.getTime() ?? Math.min(ctx.now(), t1.getTime());
    const cur = by.get(r.userId) ?? { name: r.name, minutes: 0, shifts: 0 };
    by.set(r.userId, { name: r.name, minutes: cur.minutes + Math.max(0, Math.round((end - r.inAt.getTime()) / 60_000)), shifts: cur.shifts + 1 });
  }
  return [...by].map(([userId, v]) => ({ userId, ...v, hours: Math.round((v.minutes / 60) * 100) / 100 }));
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

function csv(header: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    // Quote anything with a comma, quote or newline; a leading =,+,-,@ is defused so spreadsheets don't run it.
    const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
const usd = (c: number) => (c / 100).toFixed(2);

export const EXPORTS = ['payments', 'invoices', 'clients', 'bookings', 'staff-hours'] as const;
export type ExportKind = (typeof EXPORTS)[number];

export async function exportCsv(ctx: AppContext, businessId: string, kind: ExportKind, from: string, to: string) {
  const { b, t0, t1 } = await bounds(ctx, businessId, from, to);
  const day = (d: Date) => localDateKey(d.getTime(), b.timezone);
  let body: string;
  if (kind === 'payments') {
    const rows = await ctx.db
      .select({ p: payments, number: invoices.number, category: invoices.category, owner: owners.name })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .innerJoin(owners, eq(owners.id, payments.ownerId))
      .where(and(eq(payments.businessId, businessId), gte(payments.createdAt, t0), lt(payments.createdAt, t1)))
      .orderBy(asc(payments.createdAt));
    body = csv(
      ['Date', 'Invoice', 'Client', 'Category', 'Method', 'Status', 'Amount', 'Refunded', 'Card fee', 'Taken by'],
      rows.map((r) => [day(r.p.createdAt), r.number, r.owner, r.category, r.p.method, r.p.status, usd(r.p.amountCents), usd(r.p.refundedCents), usd(r.p.feeCents), r.p.takenBy]),
    );
  } else if (kind === 'invoices') {
    const rows = await ctx.db
      .select({ i: invoices, owner: owners.name })
      .from(invoices)
      .innerJoin(owners, eq(owners.id, invoices.ownerId))
      .where(and(eq(invoices.businessId, businessId), gte(invoices.createdAt, t0), lt(invoices.createdAt, t1)))
      .orderBy(asc(invoices.number));
    const sum = (lines: { kind: string; amount: number }[], k: string) => lines.filter((l) => l.kind === k).reduce((s, l) => s + l.amount, 0);
    body = csv(
      ['Invoice', 'Date', 'Client', 'Category', 'Status', 'Discounts', 'Tax', 'Tip', 'Total', 'Due date'],
      rows.map((r) => [r.i.number, day(r.i.createdAt), r.owner, r.i.category, r.i.status, usd(sum(r.i.lines, 'discount')), usd(sum(r.i.lines, 'tax')), usd(sum(r.i.lines, 'tip')), usd(r.i.totalCents), r.i.dueDate]),
    );
  } else if (kind === 'clients') {
    const rows = await ctx.db
      .select({ o: owners, dog: dogs.name, breed: dogs.breed })
      .from(owners)
      .leftJoin(dogs, eq(dogs.ownerId, owners.id))
      .where(eq(owners.businessId, businessId))
      .orderBy(asc(owners.name));
    body = csv(
      ['Client', 'Email', 'Phone', 'Address', 'Texts OK', 'Dog', 'Breed'],
      rows.map((r) => [r.o.name, r.o.email, r.o.phone, r.o.address, r.o.smsOptIn ? 'yes' : 'no', r.dog, r.breed]),
    );
  } else if (kind === 'bookings') {
    const rows = await ctx.db
      .select({ k: bookings, dog: dogs.name, owner: owners.name })
      .from(bookings)
      .innerJoin(dogs, eq(dogs.id, bookings.dogId))
      .innerJoin(owners, eq(owners.id, dogs.ownerId))
      .where(and(eq(bookings.businessId, businessId), or(and(gte(bookings.date, from), sql`${bookings.date} <= ${to}`), and(sql`${bookings.arrive} <= ${to}`, gte(bookings.depart, from)))))
      .orderBy(asc(bookings.createdAt));
    body = csv(
      ['Dog', 'Client', 'Service', 'Plan', 'Date', 'Arrive', 'Depart', 'Status', 'Booked by', 'Estimate'],
      rows.map((r) => [r.dog, r.owner, r.k.service, r.k.plan, r.k.date, r.k.arrive, r.k.depart, r.k.status, r.k.source, r.k.estimateCents == null ? '' : usd(r.k.estimateCents)]),
    );
  } else {
    const rows = await staffHours(ctx, businessId, from, to);
    body = csv(['Staff', 'Shifts', 'Hours'], rows.map((r) => [r.name, r.shifts, r.hours]));
  }
  return { filename: `${b.slug}-${kind}-${from}-to-${to}.csv`, csv: body };
}
