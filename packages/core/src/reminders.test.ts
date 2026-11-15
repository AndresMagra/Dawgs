import { describe, expect, it } from 'vitest';
import { bookingReminderDue, bookingReminderText, vaccineReminderDue, vaccineReminderText } from './reminders.js';
import { DAY, dateKeyToInstant } from './time.js';

const tz = 'America/New_York';

describe('booking reminders', () => {
  it('goes out from 10:00 the day before until the day starts', () => {
    const at = (key: string, hhmm: string) => dateKeyToInstant(key, tz, hhmm);
    const base = { startDay: '2026-11-10', tz, alreadySent: false };
    expect(bookingReminderDue({ ...base, now: at('2026-11-09', '09:59') })).toBe(false);
    expect(bookingReminderDue({ ...base, now: at('2026-11-09', '10:00') })).toBe(true);
    expect(bookingReminderDue({ ...base, now: at('2026-11-09', '23:59') })).toBe(true);
    expect(bookingReminderDue({ ...base, now: at('2026-11-10', '00:00') })).toBe(false);
    expect(bookingReminderDue({ ...base, alreadySent: true, now: at('2026-11-09', '12:00') })).toBe(false);
  });
  it('names the day and the stay', () => {
    expect(bookingReminderText({ dogName: 'Bowie', service: 'daycare', startDay: '2026-11-10', business: 'Happy Tails' })).toContain('tomorrow, Tue, Nov 10');
    expect(bookingReminderText({ dogName: 'Bowie', service: 'boarding', startDay: '2026-11-10', departDay: '2026-11-12', business: 'Happy Tails' })).toContain('until Thu, Nov 12');
  });
});

describe('vaccine reminders', () => {
  const now = dateKeyToInstant('2026-11-09', tz, '11:00');
  it('only inside the window, before expiry, once', () => {
    expect(vaccineReminderDue({ expiresAt: now + 10 * DAY, now, days: 14, tz, alreadySent: false })).toBe(true);
    expect(vaccineReminderDue({ expiresAt: now + 20 * DAY, now, days: 14, tz, alreadySent: false })).toBe(false);
    expect(vaccineReminderDue({ expiresAt: now - 1, now, days: 14, tz, alreadySent: false })).toBe(false);
    expect(vaccineReminderDue({ expiresAt: now + DAY, now, days: 0, tz, alreadySent: false })).toBe(false);
    expect(vaccineReminderDue({ expiresAt: now + DAY, now, days: 14, tz, alreadySent: true })).toBe(false);
  });
  it('waits for daytime', () => {
    const early = dateKeyToInstant('2026-11-09', tz, '07:00');
    expect(vaccineReminderDue({ expiresAt: early + 3 * DAY, now: early, days: 14, tz, alreadySent: false })).toBe(false);
  });
  it('reads naturally', () => {
    expect(vaccineReminderText({ dogName: 'Bowie', vaccine: 'Rabies', expiresDay: '2026-11-20', business: 'Happy Tails' })).toContain("Bowie's Rabies vaccine expires Fri, Nov 20");
  });
});
