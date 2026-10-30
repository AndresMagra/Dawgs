/**
 * Authorized pickup people and co-owners on an owner's account.
 */

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '@dawgs/core';
import { authorizedPeople, dogs, owners, users, visits } from '@dawgs/db';
import type { AppContext } from './context.js';
import { audit } from './audit.js';
import { pushToOwner } from './texts.js';

export const personShape = z.object({
  name: z.string().min(2).max(120),
  relation: z.string().max(60).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().email().nullable().optional(),
  photoUrl: z.string().max(2000).nullable().optional(),
  coOwner: z.boolean().optional(),
  notes: z.string().max(500).nullable().optional(),
});
export type PersonInput = z.infer<typeof personShape>;

export async function peopleFor(ctx: AppContext, ownerId: string, includeInactive = false) {
  const rows = await ctx.db
    .select()
    .from(authorizedPeople)
    .where(and(eq(authorizedPeople.ownerId, ownerId), ...(includeInactive ? [] : [eq(authorizedPeople.active, true)])))
    .orderBy(authorizedPeople.name);
  // Show whether a co-owner has actually made their login yet.
  const logins = await ctx.db.select({ email: users.email }).from(users).where(eq(users.ownerId, ownerId));
  return rows.map((p) => ({ ...p, hasLogin: !!p.email && logins.some((l) => l.email === p.email) }));
}

async function ownerIn(ctx: AppContext, businessId: string, ownerId: string) {
  const [o] = await ctx.db.select().from(owners).where(eq(owners.id, ownerId));
  if (!o || o.businessId !== businessId) throw new NotFoundError('owner');
  return o;
}

export async function addPerson(ctx: AppContext, args: { businessId: string; ownerId: string; input: PersonInput; actor: string }) {
  const o = await ownerIn(ctx, args.businessId, args.ownerId);
  const email = args.input.email?.trim().toLowerCase() ?? null;
  if (args.input.coOwner && !email) throw new ValidationError('a co-owner needs an email to sign in with');
  const [p] = await ctx.db
    .insert(authorizedPeople)
    .values({
      businessId: args.businessId,
      ownerId: o.id,
      name: args.input.name.trim(),
      relation: args.input.relation ?? null,
      phone: args.input.phone ?? null,
      email,
      photoUrl: args.input.photoUrl ?? null,
      coOwner: args.input.coOwner ?? false,
      notes: args.input.notes ?? null,
      addedBy: args.actor,
    })
    .returning();
  await audit(ctx.db, args.businessId, args.actor, 'pickup.add', `${p!.name} may now pick up for ${o.name}${p!.coOwner ? ' (co-owner)' : ''}`);
  return p!;
}

export async function updatePerson(ctx: AppContext, args: { businessId: string; ownerId: string; personId: string; input: Partial<PersonInput>; actor: string }) {
  const [p] = await ctx.db.select().from(authorizedPeople).where(eq(authorizedPeople.id, args.personId));
  if (!p || p.ownerId !== args.ownerId || p.businessId !== args.businessId) throw new NotFoundError('person');
  const set: Record<string, unknown> = Object.fromEntries(Object.entries(args.input).filter(([, v]) => v !== undefined));
  if (typeof set.email === 'string') set.email = set.email.trim().toLowerCase();
  const email = (set.email as string | null | undefined) ?? p.email;
  if ((set.coOwner ?? p.coOwner) && !email) throw new ValidationError('a co-owner needs an email to sign in with');
  const [out] = await ctx.db.update(authorizedPeople).set(set).where(eq(authorizedPeople.id, p.id)).returning();
  return out!;
}

/**
 * Removing someone switches them off rather than deleting, so past pickups
 * still say who came. A co-owner's login is closed at the same time.
 */
export async function removePerson(ctx: AppContext, args: { businessId: string; ownerId: string; personId: string; actor: string }) {
  const [p] = await ctx.db.select().from(authorizedPeople).where(eq(authorizedPeople.id, args.personId));
  if (!p || p.ownerId !== args.ownerId || p.businessId !== args.businessId) throw new NotFoundError('person');
  await ctx.db.update(authorizedPeople).set({ active: false }).where(eq(authorizedPeople.id, p.id));
  if (p.coOwner && p.email) {
    await ctx.db
      .update(users)
      .set({ active: false })
      .where(and(eq(users.ownerId, p.ownerId), eq(users.email, p.email), eq(users.role, 'owner')));
  }
  await audit(ctx.db, args.businessId, args.actor, 'pickup.remove', `${p.name} removed from pickup list`);
  return { ok: true };
}

/** Who may collect the dog on this visit: the owner first, then their people. */
export async function pickupList(ctx: AppContext, businessId: string, visitId: string) {
  const [v] = await ctx.db.select().from(visits).where(eq(visits.id, visitId));
  if (!v || v.businessId !== businessId) throw new NotFoundError('visit');
  const [d] = await ctx.db.select().from(dogs).where(eq(dogs.id, v.dogId));
  const [o] = await ctx.db.select().from(owners).where(eq(owners.id, d!.ownerId));
  return { owner: { id: o!.id, name: o!.name, phone: o!.phone }, people: await peopleFor(ctx, o!.id) };
}

/** Tell the owner when someone else collected their dog. */
export async function notifyPickup(ctx: AppContext, visitId: string, pickedUpBy: string) {
  const [v] = await ctx.db.select().from(visits).where(eq(visits.id, visitId));
  if (!v) return;
  const [d] = await ctx.db.select().from(dogs).where(eq(dogs.id, v.dogId));
  const [o] = await ctx.db.select().from(owners).where(eq(owners.id, d!.ownerId));
  if (!o || o.name.trim().toLowerCase() === pickedUpBy.trim().toLowerCase()) return;
  await pushToOwner(ctx, o.id, `${d!.name} went home`, `Picked up by ${pickedUpBy}.`);
}
