import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOURS,
  DEFAULT_PRICES,
  afterFailedCharge,
  addOneMonth,
  computeBill,
  dateKeyToInstant,
  emptyWallet,
  inactiveDogs,
  kennelIsFree,
  localDateKey,
  pickupTextDue,
  renewCredits,
  summarizeWalk,
  vaccineStatuses,
  vaccinesAllowEntry,
  weeklyPay,
  zonedInstant,
  HOUR,
  MINUTE,
  DAY,
} from './index.js';

const TZ = 'America/New_York';
const at = (key: string, hhmm: string) => dateKeyToInstant(key, TZ, hhmm);
const base = { prices: DEFAULT_PRICES, hours: DEFAULT_HOURS, tz: TZ };

describe('time zones', () => {
  it('finds local wall times across a DST change', () => {
    // 2026-11-01 is the US fall-back day.
    const before = zonedInstant(TZ, 2026, 10, 31, 12);
    const after = zonedInstant(TZ, 2026, 11, 2, 12);
    expect(new Date(before).toISOString()).toBe('2026-10-31T16:00:00.000Z');
    expect(new Date(after).toISOString()).toBe('2026-11-02T17:00:00.000Z');
  });

  it('keys late-evening times to the local day', () => {
    expect(localDateKey(Date.parse('2026-10-31T03:30:00Z'), TZ)).toBe('2026-10-30');
  });
});

describe('daycare bill', () => {
  it('turns a half day into a full day past 5 hours', () => {
    const b = computeBill({
      ...base,
      visit: { service: 'daycare', plan: 'half', checkedInAt: at('2026-10-30', '08:00') },
      checkoutAt: at('2026-10-30', '13:30'),
      wallet: emptyWallet(),
    });
    expect(b.total).toBe(4000);
    expect(b.lines[0]!.text).toContain('ran past');
  });

  it('bills hourly in quarter hours with a one-hour minimum', () => {
    const short = computeBill({
      ...base,
      visit: { service: 'daycare', plan: 'hourly', checkedInAt: at('2026-10-30', '10:00') },
      checkoutAt: at('2026-10-30', '10:20'),
      wallet: emptyWallet(),
    });
    expect(short.total).toBe(900);
    const long = computeBill({
      ...base,
      visit: { service: 'daycare', plan: 'hourly', checkedInAt: at('2026-10-30', '10:00') },
      checkoutAt: at('2026-10-30', '12:01'),
      wallet: emptyWallet(),
    });
    expect(long.total).toBe(Math.round((9 * 900) / 4));
  });

  it('spends one daycare credit and charges late pickup per minute', () => {
    const b = computeBill({
      ...base,
      visit: { service: 'daycare', plan: 'full', checkedInAt: at('2026-10-30', '08:00') },
      checkoutAt: at('2026-10-30', '19:12'),
      wallet: { ...emptyWallet(), daycare: 3 },
    });
    expect(b.creditsUsed).toEqual({ daycare: 1 });
    expect(b.total).toBe(12 * 100);
  });

  it('covers an exit bath with a bath credit', () => {
    const b = computeBill({
      ...base,
      visit: { service: 'daycare', plan: 'half', checkedInAt: at('2026-10-30', '08:00') },
      checkoutAt: at('2026-10-30', '11:00'),
      wallet: { ...emptyWallet(), bath: 1 },
      addOns: [{ code: 'bath', name: 'Exit bath', price: 2500 }, { code: 'nails', name: 'Nail trim', price: 1500 }],
    });
    expect(b.total).toBe(2800 + 1500);
  });
});

describe('boarding bill', () => {
  it('bills nights and play, spends credits and adds late check-out after noon', () => {
    const b = computeBill({
      ...base,
      visit: {
        service: 'boarding',
        checkedInAt: at('2026-10-27', '17:00'),
        departDate: '2026-10-30',
        kennelType: 'suite',
        kennelName: 'Suite 1',
        play: true,
      },
      checkoutAt: at('2026-10-30', '12:40'),
      wallet: { ...emptyWallet(), night: 1, daycare: 5 },
    });
    // 3 nights × 75 − 1 night credit + 3 play − 3 daycare credits + late fee
    expect(b.total).toBe(3 * 7500 - 7500 + 3 * 1800 - 3 * 1800 + 2000);
    expect(b.creditsUsed).toEqual({ night: 1, daycare: 3 });
  });

  it('charges no late fee before noon', () => {
    const b = computeBill({
      ...base,
      visit: { service: 'boarding', checkedInAt: at('2026-10-29', '17:00'), departDate: '2026-10-30', kennelType: 'run', play: false },
      checkoutAt: at('2026-10-30', '11:59'),
      wallet: emptyWallet(),
    });
    expect(b.total).toBe(6000);
  });
});

describe('vaccines', () => {
  const now = at('2026-10-30', '09:00');
  it('blocks missing and expired, allows due soon', () => {
    const s = vaccineStatuses(
      [
        { name: 'Rabies', expiresAt: now + 400 * DAY },
        { name: 'DHPP', expiresAt: now + 10 * DAY },
        { name: 'Bordetella', expiresAt: now - DAY },
      ],
      now,
    );
    expect(s.map((x) => x.state)).toEqual(['ok', 'due_soon', 'expired']);
    expect(vaccinesAllowEntry(s)).toBe(false);
    expect(vaccinesAllowEntry(s.slice(0, 2))).toBe(true);
  });
});

describe('kennels', () => {
  it('lets a departure and an arrival share a day', () => {
    const stays = [{ id: 'a', kennelId: 'S1', arrive: '2026-11-01', depart: '2026-11-05' }];
    expect(kennelIsFree('S1', { arrive: '2026-11-05', depart: '2026-11-07' }, stays)).toBe(true);
    expect(kennelIsFree('S1', { arrive: '2026-11-04', depart: '2026-11-07' }, stays)).toBe(false);
    expect(kennelIsFree('S1', { arrive: '2026-11-04', depart: '2026-11-07' }, stays, 'a')).toBe(true);
  });
});

describe('memberships', () => {
  it('rolls over up to the cap and adds the month', () => {
    expect(renewCredits({ credits: { daycare: 12 }, rolloverMax: 2 }, { daycare: 5 })).toEqual({
      daycare: 14, night: 0, walk: 0, bath: 0, training: 0,
    });
  });
  it('retries every 3 days and cancels on the 4th failure', () => {
    const t = 0;
    expect(afterFailedCharge(0, t)).toEqual({ action: 'retry', failures: 1, nextAttemptAt: 3 * DAY });
    expect(afterFailedCharge(3, t)).toEqual({ action: 'cancel', failures: 4 });
  });
  it('clamps month ends', () => {
    expect(new Date(addOneMonth(Date.UTC(2027, 0, 31))).toISOString().slice(0, 10)).toBe('2027-02-28');
  });
});

describe('walks', () => {
  it('measures a route and drops GPS jumps', () => {
    const t0 = 1_000_000;
    const pts = [
      { lat: 40.0, lng: -75.0, at: t0 },
      { lat: 40.001, lng: -75.0, at: t0 + 60_000 },
      { lat: 40.05, lng: -75.0, at: t0 + 70_000 }, // 5 km in 10 s: dropped
      { lat: 40.002, lng: -75.0, at: t0 + 120_000 },
      { lat: 40.003, lng: -75.0, at: t0 + 130_000, accuracy: 200 }, // inaccurate: dropped
    ];
    const s = summarizeWalk(pts);
    expect(s.points).toBe(3);
    expect(s.meters).toBeGreaterThan(215);
    expect(s.meters).toBeLessThan(230);
    expect(s.durationMs).toBe(120_000);
  });
});

describe('reminders', () => {
  it('sends the pickup text inside the last hour only once', () => {
    const p = at('2026-10-30', '17:00');
    expect(pickupTextDue({ plannedPickupAt: p, now: p - 61 * MINUTE, alreadySent: false })).toBe(false);
    expect(pickupTextDue({ plannedPickupAt: p, now: p - 59 * MINUTE, alreadySent: false })).toBe(true);
    expect(pickupTextDue({ plannedPickupAt: p, now: p - 59 * MINUTE, alreadySent: true })).toBe(false);
    expect(pickupTextDue({ plannedPickupAt: p, now: p + HOUR, alreadySent: false })).toBe(false);
  });
  it('lists regulars who stopped coming', () => {
    const now = 100 * DAY;
    const r = inactiveDogs(
      [
        { dogId: 'a', visits: 10, lastVisitAt: now - 30 * DAY },
        { dogId: 'b', visits: 1, lastVisitAt: now - 60 * DAY },
        { dogId: 'c', visits: 5, lastVisitAt: now - 2 * DAY },
      ],
      now,
    );
    expect(r.map((x) => x.dogId)).toEqual(['a']);
  });
});

describe('payroll', () => {
  it('pays time and a half past 40 hours', () => {
    expect(weeklyPay(45, 2000)).toEqual({ regular: 40, overtime: 5, gross: 80000 + 15000 });
  });
});
