import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

type App = Awaited<ReturnType<typeof makeApp>>;

let t: App;
let mgr: string;
let staff: string;
let dana: string;
beforeAll(async () => {
  t = await makeApp(); // Wed 4 Nov 2026
  mgr = await t.login('priya@happytails.test');
  staff = await t.login('marco@happytails.test');
  dana = await t.login('dana@example.com');
});
afterAll(async () => t.close());

const dog = async (name: string) => (await t.call<any[]>('GET', '/dogs', mgr)).body.find((d) => d.name === name)!;

describe('repeating weekly bookings', () => {
  it('books every Mon/Wed/Fri, skips a day already booked, and stops from a date', async () => {
    const mochi = await dog('Mochi');
    // Already booked on Fri 13 Nov.
    await t.call('POST', '/bookings', staff, { dogId: mochi.id, service: 'daycare', plan: 'full', date: '2026-11-13' });
    const r = await t.call<any>('POST', '/booking-series', staff, { dogId: mochi.id, weekdays: [1, 3, 5], plan: 'full', pickupTime: '17:00', from: '2026-11-09', until: '2026-11-22' });
    expect(r.status).toBe(200);
    // 9, 11, 13, 16, 18, 20 → 13 skipped.
    expect(r.body.booked).toBe(5);
    expect(r.body.skipped.map((s: any) => s.date)).toEqual(['2026-11-13']);
    const list = (await t.call<any>('GET', '/bookings?from=2026-11-09&to=2026-11-22', staff)).body.bookings.filter((b: any) => b.dogId === mochi.id && b.seriesId);
    expect(list.map((b: any) => b.date)).toEqual(['2026-11-09', '2026-11-11', '2026-11-16', '2026-11-18', '2026-11-20']);
    expect((await t.call<any[]>('GET', '/booking-series', staff)).body[0]).toMatchObject({ dog: 'Mochi', weekdays: [1, 3, 5] });

    const stop = await t.call<any>('POST', `/booking-series/${r.body.series.id}/stop`, staff, { from: '2026-11-16' });
    expect(stop.body.cancelled).toBe(3);
    const left = (await t.call<any>('GET', '/bookings?from=2026-11-09&to=2026-11-22', staff)).body.bookings.filter((b: any) => b.seriesId && b.status !== 'cancelled');
    expect(left.map((b: any) => b.date)).toEqual(['2026-11-09', '2026-11-11']);
  });

  it('refuses nonsense ranges and caps an owner at the online-booking window', async () => {
    const biscuit = await dog('Biscuit');
    expect((await t.call('POST', '/booking-series', staff, { dogId: biscuit.id, weekdays: [2], plan: 'full', from: '2026-11-01', until: '2026-11-30' })).status).toBe(400);
    expect((await t.call('POST', '/booking-series', staff, { dogId: biscuit.id, weekdays: [2], plan: 'full', from: '2026-11-10', until: '2027-12-01' })).status).toBe(400);
    await t.call('PATCH', '/settings', mgr, { policies: { onlineBooking: { daysAhead: 14 } } });
    const r = await t.call<any>('POST', '/me/booking-series', dana, { dogId: biscuit.id, weekdays: [2], plan: 'half', from: '2026-11-10', until: '2027-01-31' });
    expect(r.status).toBe(200);
    expect(r.body.until).toBe('2026-11-18');
    expect(r.body.booked).toBe(2); // Tue 10 and Tue 17
    // Sam can't stop Dana's schedule.
    const sam = await t.login('sam@example.com');
    expect((await t.call('POST', `/me/booking-series/${r.body.series.id}/stop`, sam, { from: '2026-11-10' })).status).toBe(404);
    expect((await t.call<any>('POST', `/me/booking-series/${r.body.series.id}/stop`, dana, { from: '2026-11-17' })).body.cancelled).toBe(1);
    expect((await t.call<any[]>('GET', '/me/booking-series', dana)).body).toHaveLength(1);
  });
});
