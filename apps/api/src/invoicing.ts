/**
 * Invoices the desk writes and sends: email and text, each with a pay link,
 * tracked from sent to viewed to paid, with gentle reminders once overdue.
 */

import { and, eq, isNotNull, lt, lte, or, isNull } from 'drizzle-orm';
import { formatMoney, localDateKey, NotFoundError, ValidationError, type BillLine } from '@dawgs/core';
import { businesses, dogs, invoiceSends, invoices, owners } from '@dawgs/db';
import type { AppContext } from './context.js';
import { createInvoice, createPayLink, paidSoFar } from './payments.js';
import { sendText } from './texts.js';
import { audit } from './audit.js';
import { escapeHtml, looksLikeEmail } from './mail.js';

/** Days after the due date that reminders go out: the day after, a week, two weeks. */
export const REMINDER_DAYS = [1, 7, 14];

export async function createCustomInvoice(
  ctx: AppContext,
  args: {
    businessId: string;
    ownerId: string;
    dogId?: string | null;
    lines: { text: string; amountCents: number }[];
    dueDate?: string | null;
    memo?: string | null;
    actor: string;
  },
) {
  const [o] = await ctx.db.select().from(owners).where(eq(owners.id, args.ownerId));
  if (!o || o.businessId !== args.businessId) throw new NotFoundError('owner');
  if (args.dogId) {
    const [d] = await ctx.db.select().from(dogs).where(eq(dogs.id, args.dogId));
    if (!d || d.ownerId !== o.id) throw new NotFoundError('dog');
  }
  if (!args.lines.length) throw new ValidationError('add at least one line');
  // A discount line is a negative amount; the invoice as a whole can't be.
  const lines: BillLine[] = args.lines.map((l) => ({ text: l.text, amount: l.amountCents, kind: l.amountCents < 0 ? 'credit' : 'service' }));
  const inv = await createInvoice(ctx.db, { businessId: args.businessId, ownerId: o.id, dogId: args.dogId ?? null, category: 'other', lines });
  const [out] = await ctx.db
    .update(invoices)
    .set({ dueDate: args.dueDate ?? null, memo: args.memo ?? null })
    .where(eq(invoices.id, inv.id))
    .returning();
  await audit(ctx.db, args.businessId, args.actor, 'invoice.create', `Invoice #${inv.number} for ${o.name}, ${formatMoney(inv.totalCents)}`);
  return out!;
}

function emailFor(args: {
  business: typeof businesses.$inferSelect;
  owner: typeof owners.$inferSelect;
  inv: typeof invoices.$inferSelect;
  dueCents: number;
  url: string | null;
  kind: 'invoice' | 'reminder';
  message?: string | null;
}) {
  const { business: b, owner: o, inv, url, kind } = args;
  const due = inv.dueDate ? new Date(`${inv.dueDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null;
  const subject =
    kind === 'reminder' ? `Reminder: invoice #${inv.number} from ${b.name} is past due` : `Invoice #${inv.number} from ${b.name}: ${formatMoney(args.dueCents)}`;
  const first = o.name.split(' ')[0] ?? o.name;
  const intro =
    args.message?.trim() ||
    (kind === 'reminder'
      ? `Just a friendly reminder that this invoice${due ? ` was due on ${due}` : ' is still open'}.`
      : `Here is your invoice${due ? `, due ${due}` : ''}. Thank you for trusting us with your pup!`);
  const brand = /^#[0-9a-f]{6}$/i.test(b.brandColor) ? b.brandColor : '#2563eb';
  const rows = inv.lines
    .map((l) => `<tr><td style="padding:6px 0;color:#3f3f46">${escapeHtml(l.text)}</td><td style="padding:6px 0;text-align:right;color:#3f3f46">${formatMoney(l.amount)}</td></tr>`)
    .join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:14px;padding:28px" cellpadding="0" cellspacing="0">
<tr><td>
${b.logoUrl ? `<img src="${escapeHtml(b.logoUrl)}" alt="" height="44" style="display:block;margin-bottom:12px">` : ''}
<div style="font-size:20px;font-weight:700;color:#18181b">${escapeHtml(b.name)}</div>
<p style="color:#3f3f46;font-size:15px;line-height:1.5">Hi ${escapeHtml(first)},</p>
<p style="color:#3f3f46;font-size:15px;line-height:1.5">${escapeHtml(intro)}</p>
<div style="font-size:13px;color:#71717a;margin-top:18px">Invoice #${inv.number}${due ? ` · Due ${due}` : ''}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border-top:1px solid #e4e4e7;font-size:15px">${rows}
<tr><td style="padding:10px 0;border-top:1px solid #e4e4e7;font-weight:700">Amount due</td><td style="padding:10px 0;border-top:1px solid #e4e4e7;text-align:right;font-weight:700">${formatMoney(args.dueCents)}</td></tr></table>
${inv.memo ? `<p style="color:#52525b;font-size:14px;line-height:1.5">${escapeHtml(inv.memo)}</p>` : ''}
${url ? `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="background:${brand};color:#fff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:600;display:inline-block">Pay ${formatMoney(args.dueCents)}</a></p>` : ''}
<p style="color:#71717a;font-size:13px;line-height:1.5">${[b.phone, b.email, b.address].filter(Boolean).map((x) => escapeHtml(x!)).join(' · ')}</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = [
    `Hi ${first},`,
    '',
    intro,
    '',
    `Invoice #${inv.number}${due ? ` (due ${due})` : ''}`,
    ...inv.lines.map((l) => `  ${l.text}: ${formatMoney(l.amount)}`),
    `Amount due: ${formatMoney(args.dueCents)}`,
    ...(inv.memo ? ['', inv.memo] : []),
    ...(url ? ['', `Pay online: ${url}`] : []),
    '',
    b.name,
    [b.phone, b.email].filter(Boolean).join(' · '),
  ].join('\n');
  return { subject, html, text };
}

/**
 * Email and/or text an open invoice with a fresh pay link. Each channel is
 * recorded on its own, so a bad email address doesn't hide a text that got there.
 */
export async function sendInvoice(
  ctx: AppContext,
  args: { businessId: string; invoiceId: string; email: boolean; sms: boolean; message?: string | null; kind?: 'invoice' | 'reminder'; actor: string },
) {
  const kind = args.kind ?? 'invoice';
  if (!args.email && !args.sms) throw new ValidationError('choose email, text, or both');
  const [inv] = await ctx.db.select().from(invoices).where(eq(invoices.id, args.invoiceId));
  if (!inv || inv.businessId !== args.businessId) throw new NotFoundError('invoice');
  if (inv.status !== 'open') throw new ValidationError(`invoice #${inv.number} is ${inv.status}, not open`);
  const [o] = await ctx.db.select().from(owners).where(eq(owners.id, inv.ownerId));
  const [b] = await ctx.db.select().from(businesses).where(eq(businesses.id, inv.businessId));
  const dueCents = Math.max(0, inv.totalCents - (await paidSoFar(ctx.db, inv.id)));
  const link = await createPayLink(ctx, inv.businessId, inv.id);
  const results: (typeof invoiceSends.$inferSelect)[] = [];
  const record = async (row: Omit<typeof invoiceSends.$inferInsert, 'businessId' | 'invoiceId' | 'kind' | 'sentBy'>) => {
    const [r] = await ctx.db
      .insert(invoiceSends)
      .values({ ...row, businessId: inv.businessId, invoiceId: inv.id, kind, sentBy: args.actor })
      .returning();
    results.push(r!);
  };

  if (args.email) {
    if (!looksLikeEmail(o!.email)) {
      await record({ channel: 'email', to: o!.email ?? '', status: 'skipped', error: 'no valid email address on file' });
    } else {
      const mail = emailFor({ business: b!, owner: o!, inv, dueCents, url: link.url, kind, message: args.message ?? null });
      try {
        await ctx.mail.send({ to: o!.email, ...mail, fromName: b!.name, replyTo: b!.email });
        await record({ channel: 'email', to: o!.email, status: 'sent' });
      } catch (e) {
        await record({ channel: 'email', to: o!.email, status: 'failed', error: String((e as Error).message).slice(0, 300) });
      }
    }
  }
  if (args.sms) {
    const lead = kind === 'reminder' ? `Reminder from ${b!.name}: invoice #${inv.number} for ${formatMoney(dueCents)} is past due.` : `${b!.name}: invoice #${inv.number} for ${formatMoney(dueCents)}${inv.dueDate ? `, due ${inv.dueDate}` : ''}.`;
    const body = `${args.message?.trim() ? `${args.message.trim()} ` : ''}${lead}${link.url ? ` Pay here: ${link.url}` : ''}`;
    const t = await sendText(ctx, { businessId: inv.businessId, ownerId: o!.id, kind: kind === 'reminder' ? 'reminder' : 'invoice', body, sentBy: args.actor });
    await record({ channel: 'sms', to: t.to, status: t.status === 'sent' ? 'sent' : t.status === 'failed' ? 'failed' : 'skipped', error: t.error });
  }

  if (results.some((r) => r.status === 'sent') && !inv.sentAt) {
    await ctx.db.update(invoices).set({ sentAt: new Date(ctx.now()) }).where(eq(invoices.id, inv.id));
  }
  const where = results.filter((r) => r.status === 'sent').map((r) => (r.channel === 'email' ? 'email' : 'text'));
  await audit(ctx.db, inv.businessId, args.actor, `invoice.${kind}`, `Invoice #${inv.number} ${where.length ? `sent by ${where.join(' and ')}` : 'could not be sent'}`);
  return { sends: results, url: link.url };
}

export async function sendsFor(ctx: AppContext, invoiceId: string) {
  return ctx.db.select().from(invoiceSends).where(eq(invoiceSends.invoiceId, invoiceId)).orderBy(invoiceSends.createdAt);
}

/** The pay page was opened: remember the first time, for the desk's "viewed" mark. */
export async function markViewed(ctx: AppContext, invoiceId: string) {
  await ctx.db
    .update(invoices)
    .set({ viewedAt: new Date(ctx.now()) })
    .where(and(eq(invoices.id, invoiceId), isNull(invoices.viewedAt)));
}

/**
 * Overdue reminders, from the scheduler. Each invoice is claimed by bumping
 * its reminder count with a guard on the old value, so two servers never
 * both send the same reminder.
 */
export async function runInvoiceReminders(ctx: AppContext) {
  const now = ctx.now();
  const candidates = await ctx.db
    .select({ inv: invoices, tz: businesses.timezone })
    .from(invoices)
    .innerJoin(businesses, eq(businesses.id, invoices.businessId))
    .where(
      and(
        eq(invoices.status, 'open'),
        isNotNull(invoices.dueDate),
        isNotNull(invoices.sentAt),
        lt(invoices.remindersSent, REMINDER_DAYS.length),
        eq(businesses.invoiceRemindersEnabled, true),
        or(isNull(invoices.lastReminderAt), lte(invoices.lastReminderAt, new Date(now - 20 * 3_600_000))),
      ),
    );
  let sent = 0;
  for (const { inv, tz } of candidates) {
    const today = localDateKey(now, tz);
    const daysLate = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${inv.dueDate}T12:00:00Z`)) / 86_400_000);
    if (daysLate < REMINDER_DAYS[inv.remindersSent]!) continue;
    const [claimed] = await ctx.db
      .update(invoices)
      .set({ remindersSent: inv.remindersSent + 1, lastReminderAt: new Date(now) })
      .where(and(eq(invoices.id, inv.id), eq(invoices.remindersSent, inv.remindersSent)))
      .returning({ id: invoices.id });
    if (!claimed) continue;
    await sendInvoice(ctx, { businessId: inv.businessId, invoiceId: inv.id, email: true, sms: true, kind: 'reminder', actor: 'Automatic reminder' });
    sent++;
  }
  return sent;
}
