/**
 * The price list a manager edits.
 *
 * Daycare and boarding are priced separately, as in the prototype: daycare by
 * half day, full day or hour; boarding by night per kennel type, with an
 * optional daily play add-on and a flat late check-out fee after noon.
 */

import type { Cents } from './money.js';

export interface PriceList {
  halfDay: Cents;
  fullDay: Cents;
  hourly: Cents;
  latePickupPerMinute: Cents;
  suiteNight: Cents;
  runNight: Cents;
  boarderPlay: Cents;
  lateCheckout: Cents;
}

export const DEFAULT_PRICES: PriceList = {
  halfDay: 2800,
  fullDay: 4000,
  hourly: 900,
  latePickupPerMinute: 100,
  suiteNight: 7500,
  runNight: 6000,
  boarderPlay: 1800,
  lateCheckout: 2000,
};

export interface HoursPolicy {
  /** Local `HH:MM` the building closes; daycare pickups after this are late. */
  closesAt: string;
  /** Local `HH:MM` boarders must leave by on their departure day. */
  checkoutBy: string;
  /** A half day turns into a full day once the dog has been in this long. */
  halfDayLimitMinutes: number;
  /** Hourly visits bill in quarter hours with this minimum. */
  hourlyMinimumMinutes: number;
}

export const DEFAULT_HOURS: HoursPolicy = {
  closesAt: '19:00',
  checkoutBy: '12:00',
  halfDayLimitMinutes: 300,
  hourlyMinimumMinutes: 60,
};
