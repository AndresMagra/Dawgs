/**
 * Background work, once a minute: pickup texts, membership renewals and
 * retries, overdue-invoice reminders, day-before booking and vaccine reminders, and expired-session cleanup. Every job claims its rows before
 * acting, so running on two servers at once does each thing once.
 */

import type { AppContext } from './context.js';
import { runPickupTexts } from './texts.js';
import { runMemberships } from './sales.js';
import { purgeExpiredSessions } from './auth.js';
import { runInvoiceReminders } from './invoicing.js';
import { runLeadFollowUps } from './leads.js';
import { runBirthdayTexts } from './messaging.js';
import { runBookingReminders, runVaccineReminders } from './reminders.js';

export async function tick(ctx: AppContext) {
  const pickupTexts = await runPickupTexts(ctx);
  const memberships = await runMemberships(ctx);
  const invoiceReminders = await runInvoiceReminders(ctx);
  const leadFollowUps = await runLeadFollowUps(ctx);
  const birthdays = await runBirthdayTexts(ctx);
  const bookingReminders = await runBookingReminders(ctx);
  const vaccineReminders = await runVaccineReminders(ctx);
  await purgeExpiredSessions(ctx);
  return { pickupTexts, memberships, invoiceReminders, leadFollowUps, birthdays, bookingReminders, vaccineReminders };
}

export function startScheduler(ctx: AppContext, everyMs = 60_000) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick(ctx);
    } catch (e) {
      console.error('scheduler', e);
    } finally {
      running = false;
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
