/**
 * Leads: people who asked about the daycare but aren't clients yet. The desk
 * moves them through stages, logs every call and message, sets follow-ups, and
 * turns a won lead into an owner (and their dog) without retyping anything.
 */

import { and, desc, eq, inArray, isNotNull, ne, or, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { localDateKey, NotFoundError, ValidationError } from '@dawgs/core';
import { businesses, dogs, leadActivities, leads, owners, smsMessages, users } from '@dawgs/db';
import type { AppContext } from './context.js';
import { ownerByReferralCode, rewardReferral } from './growth.js';
import { audit } from './audit.js';
import { pushToUsers } from './texts.js';
import { toE164 } from './sms.js';
import { escapeHtml, looksLikeEmail } from './mail.js';

export const STAGES = ['new', 'contacted', 'tour', 'trial', 'won', 'lost'] as const;
export type Stage = (typeof STAGES)[number];
const STAGE_NAME: Record<Stage, string> = { new: 'New', contacted: 'Contacted', tour: 'Tour booked', trial: 'Trial day', won: 'Won', lost: 'Lost' };

export const leadShape = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  dogName: z.string().max(80).nullable().optional(),
  dogBreed: z.string().max(80).nullable().optional(),
  source: z.enum(['website', 'phone', 'walk_in', 'referral', 'social', 'other']).optional(),
  interest: z.array(z.string().max(30)).max(10).optional(),
  message: z.string().max(2000).nullable().optional(),
  followUpOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  assignedTo: z.string().uuid().nullable().optional(),
});
export type LeadInput = z.infer<typeof leadShape>;

async function loadLead(ctx: AppContext, businessId: string, id: string) {
  const [l] = await ctx.db.select().from(leads).where(eq(leads.id, id));
  if (!l || l.businessId !== businessId) throw new NotFoundError('lead');
  return l;
}

async function log(ctx: AppContext, l: { id: string; businessId: string }, kind: (typeof leadActivities.$inferInsert)['kind'], body: string, by: string) {
  await ctx.db.insert(leadActivities).values({ businessId: l.businessId, leadId: l.id, kind, body, by, at: new Date(ctx.now()) });
}

export async function createLead(ctx: AppContext, args: { businessId: string; input: LeadInput; actor: string; source?: LeadInput['source']; referredBy?: string }) {
  const i = args.input;
  if (!i.email && !i.phone) throw new ValidationError('add an email or a phone number so you can reach them');
  if (i.assignedTo) await assertStaff(ctx, args.businessId, i.assignedTo);
  const [l] = await ctx.db
    .insert(leads)
    .values({
      businessId: args.businessId,
      name: i.name.trim(),
      email: i.email?.trim().toLowerCase() ?? null,
      phone: i.phone?.trim() ?? null,
      dogName: i.dogName ?? null,
      dogBreed: i.dogBreed ?? null,
      source: args.source ?? i.source ?? 'other',
      interest: i.interest ?? [],
      stage: 'new',
      message: i.message ?? null,
      followUpOn: i.followUpOn ?? null,
      assignedTo: i.assignedTo ?? null,
      referredBy: args.referredBy ?? null,
      createdAt: new Date(ctx.now()),
    })
    .returning();
  await log(ctx, l!, 'note', i.message?.trim() ? `Inquiry: ${i.message.trim()}` : 'Lead added', args.actor);
  return l!;
}

async function assertStaff(ctx: AppContext, businessId: string, userId: string) {
  const [u] = await ctx.db.select().from(users).where(eq(users.id, userId));
  if (!u || u.businessId !== businessId || u.role === 'owner') throw new NotFoundError('staff member');
}

export async function updateLead(
  ctx: AppContext,
  args: { businessId: string; leadId: string; input: Partial<LeadInput> & { stage?: Stage; lostReason?: string | null }; actor: string },
) {
  const l = await loadLead(ctx, args.businessId, args.leadId);
  const { stage, ...rest } = args.input;
  if (rest.assignedTo) await assertStaff(ctx, args.businessId, rest.assignedTo);
  if (stage === 'won' && !l.ownerId) throw new ValidationError('convert the lead to a client to mark it won');
  const set: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  if (typeof set.email === 'string') set.email = (set.email as string).toLowerCase();
  if (stage && stage !== l.stage) {
    set.stage = stage;
    // A closed lead needs no follow-up.
    if (stage === 'lost' || stage === 'won') set.followUpOn = null;
    await log(ctx, l, 'stage', `${STAGE_NAME[l.stage]} → ${STAGE_NAME[stage]}${stage === 'lost' && args.input.lostReason ? `: ${args.input.lostReason}` : ''}`, args.actor);
  }
  if (rest.followUpOn !== undefined) set.remindedOn = null;
  set.updatedAt = new Date(ctx.now());
  const [out] = await ctx.db.update(leads).set(set).where(eq(leads.id, l.id)).returning();
  return out!;
}

export async function addActivity(ctx: AppContext, args: { businessId: string; leadId: string; kind: 'note' | 'call' | 'tour'; body: string; actor: string }) {
  const l = await loadLead(ctx, args.businessId, args.leadId);
  await log(ctx, l, args.kind, args.body, args.actor);
  // Logging a call on a new lead means they've been contacted.
  if (args.kind === 'call' && l.stage === 'new') await updateLead(ctx, { businessId: args.businessId, leadId: l.id, input: { stage: 'contacted' }, actor: args.actor });
  return { ok: true };
}

/** Has this number texted STOP more recently than START? Carriers require honouring it, client or not. */
export async function optedOut(ctx: AppContext, businessId: string, e164: string) {
  const inbound = await ctx.db
    .select({ body: smsMessages.body })
    .from(smsMessages)
    .where(and(eq(smsMessages.businessId, businessId), eq(smsMessages.direction, 'in'), eq(smsMessages.to, e164)))
    .orderBy(desc(smsMessages.createdAt))
    .limit(50);
  for (const m of inbound) {
    if (/^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(m.body.trim())) return true;
    if (/^(start|unstop|yes)$/i.test(m.body.trim())) return false;
  }
  return false;
}

export async function messageLead(ctx: AppContext, args: { businessId: string; leadId: string; channel: 'sms' | 'email'; body: string; subject?: string | null; actor: string }) {
  const l = await loadLead(ctx, args.businessId, args.leadId);
  const [b] = await ctx.db.select().from(businesses).where(eq(businesses.id, args.businessId));
  if (args.channel === 'sms') {
    const to = l.phone ? toE164(l.phone) : null;
    if (!to) throw new ValidationError('this lead has no valid mobile number');
    if (await optedOut(ctx, args.businessId, to)) throw new ValidationError('this number replied STOP; texts to it are blocked');
    const base = { businessId: args.businessId, ownerId: null, direction: 'out' as const, to, body: args.body, kind: 'lead' as const, sentBy: args.actor };
    try {
      const r = await (await ctx.smsFor(args.businessId)).send(to, args.body);
      await ctx.db.insert(smsMessages).values({ ...base, status: 'sent', providerId: r.id });
    } catch (e) {
      await ctx.db.insert(smsMessages).values({ ...base, status: 'failed', error: String((e as Error).message).slice(0, 300) });
      throw new ValidationError(`the text did not go through: ${(e as Error).message}`);
    }
  } else {
    if (!looksLikeEmail(l.email)) throw new ValidationError('this lead has no email address');
    const subject = args.subject?.trim() || `From ${b!.name}`;
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5;color:#27272a">${escapeHtml(args.body).replace(/\n/g, '<br>')}<p style="color:#71717a;font-size:13px">${escapeHtml(b!.name)}${b!.phone ? ` · ${escapeHtml(b!.phone)}` : ''}</p></div>`;
    await ctx.mail.send({ to: l.email, subject, html, text: `${args.body}\n\n${b!.name}${b!.phone ? ` · ${b!.phone}` : ''}`, fromName: b!.name, replyTo: b!.email });
  }
  await log(ctx, l, args.channel === 'sms' ? 'text' : 'email', args.body, args.actor);
  if (l.stage === 'new') await ctx.db.update(leads).set({ stage: 'contacted', updatedAt: new Date(ctx.now()) }).where(eq(leads.id, l.id));
  return { ok: true };
}

/** The lead becomes a client: an owner record (reusing one with the same email) and their dog. */
export async function convertLead(ctx: AppContext, args: { businessId: string; leadId: string; actor: string }) {
  const l = await loadLead(ctx, args.businessId, args.leadId);
  if (l.ownerId) throw new ValidationError('this lead is already a client');
  let owner: typeof owners.$inferSelect | undefined;
  if (l.email) [owner] = await ctx.db.select().from(owners).where(and(eq(owners.businessId, args.businessId), eq(owners.email, l.email)));
  if (!owner) {
    [owner] = await ctx.db.insert(owners).values({ businessId: args.businessId, name: l.name, email: l.email, phone: l.phone }).returning();
  }
  let dogId: string | null = null;
  if (l.dogName) {
    const [d] = await ctx.db.insert(dogs).values({ businessId: args.businessId, ownerId: owner!.id, name: l.dogName, breed: l.dogBreed }).returning();
    dogId = d!.id;
  }
  await ctx.db.update(leads).set({ ownerId: owner!.id, stage: 'won', followUpOn: null, updatedAt: new Date(ctx.now()) }).where(eq(leads.id, l.id));
  await log(ctx, l, 'stage', `${STAGE_NAME[l.stage]} → Won: now a client`, args.actor);
  await audit(ctx.db, args.businessId, args.actor, 'lead.convert', `Lead ${l.name} became a client`);
  const reward = l.referredBy && l.referredBy !== owner!.id ? await rewardReferral(ctx, args.businessId, l.referredBy, l.name) : null;
  return { ownerId: owner!.id, dogId, referralRewarded: !!reward };
}

export async function leadDetail(ctx: AppContext, businessId: string, id: string) {
  const l = await loadLead(ctx, businessId, id);
  const activity = await ctx.db.select().from(leadActivities).where(eq(leadActivities.leadId, id)).orderBy(desc(leadActivities.at));
  const texts = l.phone
    ? await ctx.db
        .select()
        .from(smsMessages)
        .where(and(eq(smsMessages.businessId, businessId), eq(smsMessages.to, toE164(l.phone) ?? '-'), isNull(smsMessages.ownerId)))
        .orderBy(desc(smsMessages.createdAt))
        .limit(50)
    : [];
  return { lead: l, activity, replies: texts.filter((t) => t.direction === 'in') };
}

export async function listLeads(ctx: AppContext, businessId: string, includeClosed: boolean) {
  return ctx.db
    .select()
    .from(leads)
    .where(and(eq(leads.businessId, businessId), ...(includeClosed ? [] : [inArray(leads.stage, ['new', 'contacted', 'tour', 'trial'])])))
    .orderBy(desc(leads.createdAt))
    .limit(500);
}

/** In-memory brake on the public form: a few inquiries per address per hour is plenty for a person. */
const recent = new Map<string, number[]>();
export function inquiryAllowed(key: string, now: number) {
  const hour = 3_600_000;
  const list = (recent.get(key) ?? []).filter((t) => now - t < hour);
  if (list.length >= 5) return false;
  list.push(now);
  recent.set(key, list);
  if (recent.size > 10_000) recent.clear();
  return true;
}

/** From the daycare's website: a new lead, a push to the managers, and a thank-you email. */
export async function publicInquiry(ctx: AppContext, slug: string, input: LeadInput, ref?: string) {
  const [b] = await ctx.db.select().from(businesses).where(eq(businesses.slug, slug.toLowerCase()));
  if (!b) throw new NotFoundError('daycare');
  // An unknown code is simply ignored: the inquiry matters more than the credit.
  const referredBy = ref ? await ownerByReferralCode(ctx, b.id, ref) : null;
  const l = await createLead(ctx, { businessId: b.id, input, source: referredBy ? 'referral' : 'website', actor: 'Website form', ...(referredBy ? { referredBy } : {}) });
  const managers = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.businessId, b.id), eq(users.role, 'manager'), eq(users.active, true)));
  await pushToUsers(ctx, managers.map((m) => m.id), 'New inquiry', `${l.name}${l.dogName ? ` (${l.dogName})` : ''} asked about ${l.interest.length ? l.interest.join(', ') : 'your daycare'}.`, { leadId: l.id });
  if (looksLikeEmail(l.email)) {
    const first = l.name.split(' ')[0] ?? l.name;
    const text = `Hi ${first},\n\nThanks for reaching out to ${b.name}! We got your message and will be in touch soon.${b.phone ? ` If it's urgent, call us at ${b.phone}.` : ''}\n\n${b.name}`;
    await ctx.mail
      .send({ to: l.email, subject: `Thanks for contacting ${b.name}`, text, html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`, fromName: b.name, replyTo: b.email })
      .catch(() => undefined);
  }
  return { ok: true };
}

/** Morning push of follow-ups due, to whoever owns the lead (or the managers). Once a day per lead. */
export async function runLeadFollowUps(ctx: AppContext) {
  const rows = await ctx.db
    .select({ l: leads, tz: businesses.timezone })
    .from(leads)
    .innerJoin(businesses, eq(businesses.id, leads.businessId))
    .where(and(isNotNull(leads.followUpOn), ne(leads.stage, 'won'), ne(leads.stage, 'lost')));
  let sent = 0;
  for (const { l, tz } of rows) {
    const today = localDateKey(ctx.now(), tz);
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ctx.now())));
    if (l.followUpOn! > today || hour < 8 || l.remindedOn === today) continue;
    const [claimed] = await ctx.db
      .update(leads)
      .set({ remindedOn: today })
      .where(and(eq(leads.id, l.id), or(isNull(leads.remindedOn), ne(leads.remindedOn, today))))
      .returning({ id: leads.id });
    if (!claimed) continue;
    const to = l.assignedTo
      ? [l.assignedTo]
      : (await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.businessId, l.businessId), eq(users.role, 'manager'), eq(users.active, true)))).map((u) => u.id);
    await pushToUsers(ctx, to, 'Follow up today', `${l.name}${l.dogName ? ` (${l.dogName})` : ''}: ${STAGE_NAME[l.stage]}`, { leadId: l.id });
    sent++;
  }
  return sent;
}

/** A text from a number that isn't a client: if it's an open lead, it goes on their timeline and the desk hears about it. */
export async function leadReply(ctx: AppContext, businessId: string, from: string, body: string) {
  const open = await ctx.db
    .select()
    .from(leads)
    .where(and(eq(leads.businessId, businessId), isNotNull(leads.phone), ne(leads.stage, 'lost')))
    .orderBy(desc(leads.createdAt));
  const l = open.find((x) => toE164(x.phone!) === from);
  if (!l) return false;
  await log(ctx, l, 'text', `Reply: ${body}`, l.name);
  const to = l.assignedTo
    ? [l.assignedTo]
    : (await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.businessId, businessId), eq(users.role, 'manager'), eq(users.active, true)))).map((u) => u.id);
  await pushToUsers(ctx, to, `Text from ${l.name}`, body.slice(0, 140), { leadId: l.id });
  return true;
}
