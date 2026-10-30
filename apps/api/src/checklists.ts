/** Opening, closing and cleaning routines that staff tick off each day. */

import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '@dawgs/core';
import { checklistChecks, checklists } from '@dawgs/db';
import type { AppContext } from './context.js';

export const checklistShape = z.object({
  name: z.string().min(1).max(60),
  items: z.array(z.string().trim().min(1).max(120)).min(1).max(40),
  sort: z.number().int().min(0).max(999).optional(),
  active: z.boolean().optional(),
});

async function load(ctx: AppContext, businessId: string, id: string) {
  const [c] = await ctx.db.select().from(checklists).where(eq(checklists.id, id));
  if (!c || c.businessId !== businessId) throw new NotFoundError('checklist');
  return c;
}

export async function checklistsFor(ctx: AppContext, businessId: string, date: string, includeInactive = false) {
  const lists = await ctx.db
    .select()
    .from(checklists)
    .where(and(eq(checklists.businessId, businessId), ...(includeInactive ? [] : [eq(checklists.active, true)])))
    .orderBy(asc(checklists.sort), asc(checklists.name));
  const checks = await ctx.db.select().from(checklistChecks).where(and(eq(checklistChecks.businessId, businessId), eq(checklistChecks.date, date)));
  return lists.map((c) => {
    const mine = checks.filter((k) => k.checklistId === c.id);
    const items = c.items.map((item) => {
      const k = mine.find((x) => x.item === item);
      return { item, doneBy: k?.doneBy ?? null, doneAt: k?.doneAt ?? null };
    });
    return { ...c, date, items, done: items.filter((i) => i.doneBy).length };
  });
}

export async function saveChecklist(ctx: AppContext, businessId: string, input: z.infer<typeof checklistShape>, id?: string) {
  const items = [...new Set(input.items)];
  if (id) {
    await load(ctx, businessId, id);
    const [c] = await ctx.db
      .update(checklists)
      .set({ name: input.name, items, ...(input.sort !== undefined ? { sort: input.sort } : {}), ...(input.active !== undefined ? { active: input.active } : {}) })
      .where(eq(checklists.id, id))
      .returning();
    return c!;
  }
  const [c] = await ctx.db.insert(checklists).values({ businessId, name: input.name, items, sort: input.sort ?? 0, active: input.active ?? true }).returning();
  return c!;
}

export async function tick(ctx: AppContext, args: { businessId: string; id: string; date: string; item: string; done: boolean; by: string }) {
  const c = await load(ctx, args.businessId, args.id);
  if (!c.items.includes(args.item)) throw new ValidationError('that item is not on this checklist');
  if (args.done) {
    await ctx.db
      .insert(checklistChecks)
      .values({ businessId: args.businessId, checklistId: c.id, date: args.date, item: args.item, doneBy: args.by, doneAt: new Date(ctx.now()) })
      .onConflictDoNothing();
  } else {
    await ctx.db.delete(checklistChecks).where(and(eq(checklistChecks.checklistId, c.id), eq(checklistChecks.date, args.date), eq(checklistChecks.item, args.item)));
  }
  return { ok: true };
}
