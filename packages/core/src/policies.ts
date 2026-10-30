/**
 * The money rules a daycare sets for itself: sales tax, tips, discounts and
 * cancellation fees. `finishBill` applies them to the lines `computeBill`
 * produced, in the order a receipt reads: discounts, then tax, then the tip.
 */

import type { Cents } from './money.js';
import { formatMoney } from './money.js';
import type { Bill, BillLine } from './billing.js';
import { dateKeyToInstant } from './time.js';

export interface Policies {
  /** Sales tax in basis points (725 = 7.25%); 0 means none. */
  salesTaxBps: number;
  taxServices: boolean;
  taxAddOns: boolean;
  tipsEnabled: boolean;
  /** Percent buttons offered at check-out. */
  tipChoices: number[];
  /** Percent off the daycare day for each extra dog from the same family on the same day. */
  multiDogPercent: number;
  /** Cancelling less than this many hours before the booked day starts costs `lateCancelFeeCents`. */
  cancelWindowHours: number;
  lateCancelFeeCents: Cents;
  noShowFeeCents: Cents;
  onlineBooking: { enabled: boolean; autoApprove: boolean; daysAhead: number };
  /** After a pickup, text a link to the daycare's review page, at most once per `everyDays` per client. */
  reviewRequests: { enabled: boolean; url: string; everyDays: number };
  birthdayTexts: boolean;
  /** Also text the owner when a report card is sent (it always appears in their app). */
  reportCardTexts: boolean;
}

export const DEFAULT_POLICIES: Policies = {
  salesTaxBps: 0,
  taxServices: false,
  taxAddOns: true,
  tipsEnabled: true,
  tipChoices: [15, 18, 20],
  multiDogPercent: 0,
  cancelWindowHours: 24,
  lateCancelFeeCents: 0,
  noShowFeeCents: 0,
  onlineBooking: { enabled: true, autoApprove: false, daysAhead: 90 },
  reviewRequests: { enabled: false, url: '', everyDays: 90 },
  birthdayTexts: false,
  reportCardTexts: false,
};

/** Older rows and partial edits are filled from the defaults, so every rule always has a value. */
export function withPolicyDefaults(p: Partial<Policies> | null | undefined): Policies {
  return {
    ...DEFAULT_POLICIES,
    ...(p ?? {}),
    onlineBooking: { ...DEFAULT_POLICIES.onlineBooking, ...(p?.onlineBooking ?? {}) },
    reviewRequests: { ...DEFAULT_POLICIES.reviewRequests, ...(p?.reviewRequests ?? {}) },
  };
}

export interface Extras {
  /** A discount the desk gives at check-out: a fixed amount or a percent of the bill, always with a reason. */
  discount?: { cents?: Cents; percent?: number; reason: string } | null;
  /** This dog is an extra dog from the same family today. */
  multiDog?: boolean;
  tipCents?: Cents;
}

const pct = (amount: Cents, percent: number) => Math.round((amount * percent) / 100);

export function finishBill(bill: Bill, policies: Policies, extras: Extras = {}): Bill {
  const lines: BillLine[] = [...bill.lines];
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const serviceNet = lines.filter((l) => l.kind === 'service' || (l.kind === 'credit' && l.credit?.kind !== 'bath')).reduce((s, l) => s + l.amount, 0);

  let discounted = 0;
  if (extras.multiDog && policies.multiDogPercent > 0 && serviceNet > 0) {
    const off = pct(serviceNet, policies.multiDogPercent);
    lines.push({ kind: 'discount', text: `Multi-dog discount, ${policies.multiDogPercent}%`, amount: -off });
    discounted += off;
  }
  const d = extras.discount;
  if (d && (d.cents || d.percent)) {
    const left = subtotal - discounted;
    const off = Math.min(left, d.cents ?? pct(left, d.percent ?? 0));
    if (off > 0) {
      lines.push({ kind: 'discount', text: `Discount${d.percent && !d.cents ? `, ${d.percent}%` : ''}: ${d.reason}`, amount: -off });
      discounted += off;
    }
  }

  if (policies.salesTaxBps > 0) {
    const isTaxable = (l: BillLine) =>
      (policies.taxAddOns && (l.kind === 'addon' || (l.kind === 'credit' && l.credit?.kind === 'bath'))) ||
      (policies.taxServices && (l.kind === 'service' || l.kind === 'fee' || (l.kind === 'credit' && l.credit?.kind !== 'bath')));
    const base = lines.filter(isTaxable).reduce((s, l) => s + l.amount, 0);
    // Discounts lower the taxable amount in proportion to the share of the bill that is taxable.
    const net = subtotal > 0 ? Math.round(base * (1 - discounted / subtotal)) : 0;
    const tax = Math.round((Math.max(0, net) * policies.salesTaxBps) / 10_000);
    if (tax > 0) lines.push({ kind: 'tax', text: `Sales tax ${(policies.salesTaxBps / 100).toFixed(2).replace(/\.?0+$/, '')}% on ${formatMoney(net)}`, amount: tax });
  }

  if (policies.tipsEnabled && extras.tipCents && extras.tipCents > 0) lines.push({ kind: 'tip', text: 'Tip', amount: extras.tipCents });
  return { ...bill, lines, total: lines.reduce((s, l) => s + l.amount, 0) };
}

/** The tip each button offers, worked out on the bill before tax and tip. */
export function tipOptions(bill: Bill, policies: Policies) {
  if (!policies.tipsEnabled) return [];
  const base = bill.lines.filter((l) => l.kind !== 'tax' && l.kind !== 'tip').reduce((s, l) => s + l.amount, 0);
  return policies.tipChoices.map((p) => ({ percent: p, cents: pct(Math.max(0, base), p) }));
}

/** The fee for cancelling a booking now, or 0 when it is outside the window or no fee is set. */
export function lateCancelFee(policies: Policies, firstDay: string, tz: string, now: number): Cents {
  if (!policies.lateCancelFeeCents) return 0;
  const start = dateKeyToInstant(firstDay, tz);
  return start - now < policies.cancelWindowHours * 3_600_000 ? policies.lateCancelFeeCents : 0;
}
