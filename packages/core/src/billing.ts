/**
 * What a visit costs when the dog goes home.
 *
 * Ported from the prototype's `bill()`, with the same rules:
 *
 *   - Daycare half day turns into a full day past the half-day limit.
 *   - Hourly bills in quarter hours with a one-hour minimum.
 *   - A daycare credit covers one half or full day; hourly never uses credits.
 *   - Boarding bills per local night at the kennel's rate; night credits cover
 *     nights, daycare credits cover the optional daily play.
 *   - Daycare pickups after closing are charged per minute; boarders leaving
 *     after the check-out time on their departure day pay a flat fee.
 *   - Add-ons are listed after the visit; a bath credit covers an exit bath.
 *
 * Returns lines rather than a total so the receipt, the phone and Stripe's
 * description all say the same thing.
 */

import type { Cents } from './money.js';
import type { HoursPolicy, PriceList } from './prices.js';
import type { CreditKind, Wallet } from './wallet.js';
import { MINUTE, atLocalTime, localDaysBetween, localDateKey, dateKeyToInstant } from './time.js';
import { formatMoney } from './money.js';

export type DaycarePlan = 'half' | 'full' | 'hourly';
export type KennelType = 'suite' | 'run';

export type VisitInput =
  | {
      service: 'daycare';
      plan: DaycarePlan;
      checkedInAt: number;
    }
  | {
      service: 'boarding';
      checkedInAt: number;
      /** `YYYY-MM-DD` the dog is booked to go home. */
      departDate: string;
      kennelType: KennelType;
      kennelName?: string;
      play: boolean;
    };

export interface AddOn {
  code: string;
  name: string;
  price: Cents;
}

export interface BillLine {
  text: string;
  amount: Cents;
  /** Set on credit lines: which credits and how many this line spends. */
  credit?: { kind: CreditKind; count: number };
  kind: 'service' | 'credit' | 'fee' | 'addon' | 'discount' | 'tax' | 'tip';
}

export interface Bill {
  lines: BillLine[];
  total: Cents;
  creditsUsed: Partial<Wallet>;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function formatMinutes(min: number): string {
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

export function computeBill(args: {
  visit: VisitInput;
  checkoutAt: number;
  prices: PriceList;
  hours: HoursPolicy;
  tz: string;
  wallet: Wallet;
  addOns?: readonly AddOn[];
}): Bill {
  const { visit, checkoutAt: t, prices, hours, tz, wallet } = args;
  const lines: BillLine[] = [];
  const used: Partial<Wallet> = {};
  const spend = (kind: CreditKind, n: number) => {
    used[kind] = (used[kind] ?? 0) + n;
  };
  const left = (kind: CreditKind) => wallet[kind] - (used[kind] ?? 0);

  if (visit.service === 'boarding') {
    const nights = Math.max(1, localDaysBetween(visit.checkedInAt, t, tz));
    const rate = visit.kennelType === 'suite' ? prices.suiteNight : prices.runNight;
    lines.push({
      kind: 'service',
      text: `${plural(nights, 'night')}${visit.kennelName ? ` in ${visit.kennelName}` : ''} × ${formatMoney(rate)}`,
      amount: nights * rate,
    });
    const nc = Math.min(nights, left('night'));
    if (nc > 0) {
      lines.push({
        kind: 'credit',
        text: `Package credit: ${plural(nc, 'night')}`,
        amount: -nc * rate,
        credit: { kind: 'night', count: nc },
      });
      spend('night', nc);
    }
    if (visit.play) {
      lines.push({
        kind: 'service',
        text: `Daycare play, ${plural(nights, 'day')} × ${formatMoney(prices.boarderPlay)}`,
        amount: nights * prices.boarderPlay,
      });
      const dc = Math.min(nights, left('daycare'));
      if (dc > 0) {
        lines.push({
          kind: 'credit',
          text: `Package credit: ${plural(dc, 'daycare day')}`,
          amount: -dc * prices.boarderPlay,
          credit: { kind: 'daycare', count: dc },
        });
        spend('daycare', dc);
      }
    }
    const departCutoff = dateKeyToInstant(visit.departDate, tz, hours.checkoutBy);
    if (localDateKey(t, tz) >= visit.departDate && t > departCutoff) {
      lines.push({ kind: 'fee', text: `Late check-out, after ${hours.checkoutBy}`, amount: prices.lateCheckout });
    }
  } else if (visit.plan === 'hourly') {
    const elapsedMin = Math.max(0, (t - visit.checkedInAt) / MINUTE);
    const quarters = Math.max(hours.hourlyMinimumMinutes / 15, Math.ceil(elapsedMin / 15));
    lines.push({
      kind: 'service',
      text: `Hourly, ${formatMinutes(quarters * 15)} at ${formatMoney(prices.hourly)}/h`,
      amount: Math.round((quarters * prices.hourly) / 4),
    });
  } else {
    const elapsedMin = (t - visit.checkedInAt) / MINUTE;
    const full = visit.plan === 'full' || elapsedMin > hours.halfDayLimitMinutes;
    const amount = full ? prices.fullDay : prices.halfDay;
    lines.push({
      kind: 'service',
      text: full
        ? visit.plan === 'half'
          ? `Full day (half day ran past ${hours.halfDayLimitMinutes / 60} h)`
          : 'Full day'
        : `Half day (up to ${hours.halfDayLimitMinutes / 60} h)`,
      amount,
    });
    if (left('daycare') > 0) {
      lines.push({
        kind: 'credit',
        text: 'Package credit: 1 daycare day',
        amount: -amount,
        credit: { kind: 'daycare', count: 1 },
      });
      spend('daycare', 1);
    }
  }

  if (visit.service === 'daycare') {
    const close = atLocalTime(t, tz, hours.closesAt);
    if (t > close) {
      const m = Math.ceil((t - close) / MINUTE);
      lines.push({
        kind: 'fee',
        text: `Late pickup, ${m} min after closing`,
        amount: m * prices.latePickupPerMinute,
      });
    }
  }

  for (const a of args.addOns ?? []) {
    lines.push({ kind: 'addon', text: a.name, amount: a.price });
    if (a.code === 'bath' && left('bath') > 0) {
      lines.push({
        kind: 'credit',
        text: 'Package credit: exit bath',
        amount: -a.price,
        credit: { kind: 'bath', count: 1 },
      });
      spend('bath', 1);
    }
  }

  return { lines, total: lines.reduce((s, l) => s + l.amount, 0), creditsUsed: used };
}

/** Estimate for a boarding reservation before the dog arrives. */
export function estimateStay(args: {
  nights: number;
  kennelType: KennelType;
  play: boolean;
  prices: PriceList;
}): Cents {
  const rate = args.kennelType === 'suite' ? args.prices.suiteNight : args.prices.runNight;
  return args.nights * rate + (args.play ? args.nights * args.prices.boarderPlay : 0);
}
