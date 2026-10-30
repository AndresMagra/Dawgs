import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

type App = Awaited<ReturnType<typeof makeApp>>;

let t: App;
let mgr: string;
let staff: string;
let dana: string;
beforeAll(async () => {
  t = await makeApp();
  mgr = await t.login('priya@happytails.test');
  staff = await t.login('marco@happytails.test');
  dana = await t.login('dana@example.com');
});
afterAll(async () => t.close());

async function dogByName(name: string) {
  const r = await t.call<any[]>('GET', '/dogs', mgr);
  return r.body.find((x) => x.name === name)!;
}
const settings = async () => (await t.call<any>('GET', '/settings', mgr)).body.addOns as any[];

describe('add-on services and transport', () => {
  it('lets the manager define any add-on, and only managers', async () => {
    const r = await t.call<any>('POST', '/settings/add-ons', mgr, {
      name: 'Blueberry facial',
      category: 'Spa',
      description: 'Gentle face wash',
      priceCents: 1200,
      durationMinutes: 10,
      services: ['daycare'],
      dailyLimit: 1,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ code: 'blueberry-facial', kind: 'extra', pricing: 'flat', ownerBookable: true });
    expect((await t.call('POST', '/settings/add-ons', staff, { name: 'X', priceCents: 1 })).status).toBe(403);
    const hidden = await t.call<any>('POST', '/settings/add-ons', mgr, { name: 'Sedation check', priceCents: 0, ownerBookable: false });
    const menu = (await t.call<any>('GET', '/me/add-ons', dana)).body;
    expect(menu.addOns.some((a: any) => a.name === 'Blueberry facial')).toBe(true);
    expect(menu.addOns.some((a: any) => a.id === hidden.body.id)).toBe(false);
    expect(menu.addOns[0].dailyLimit).toBeUndefined();
  });

  it('books pickup, drop-off and extras with a stay, runs the van, and bills it all at check-out', async () => {
    const list = await settings();
    const pickup = list.find((a) => a.kind === 'pickup');
    const dropoff = list.find((a) => a.kind === 'dropoff');
    const meds = list.find((a) => a.code === 'meds');
    const nails = list.find((a) => a.code === 'nails');
    const facial = list.find((a) => a.code === 'blueberry-facial');
    const biscuit = await dogByName('Biscuit');

    // Transport needs a time and somewhere to go.
    const noTime = await t.call('POST', '/me/bookings', dana, { dogId: biscuit.id, service: 'boarding', arrive: '2026-11-10', depart: '2026-11-12', addOns: [{ addOnId: pickup.id, address: '1 Oak St' }] });
    expect(noTime.status).toBe(400);
    // A daycare-only add-on can't go on a boarding stay.
    const wrong = await t.call('POST', '/me/bookings', dana, { dogId: biscuit.id, service: 'boarding', arrive: '2026-11-10', depart: '2026-11-12', addOns: [{ addOnId: facial.id }] });
    expect(wrong.status).toBe(400);
    // Nothing half-made from those refusals.
    expect((await t.call<any[]>('GET', '/me/bookings', dana)).body.filter((b) => b.arrive === '2026-11-10')).toHaveLength(0);

    const bk = await t.call<any>('POST', '/me/bookings', dana, {
      dogId: biscuit.id,
      service: 'boarding',
      arrive: '2026-11-10',
      depart: '2026-11-12',
      addOns: [
        { addOnId: pickup.id, time: '08:00', address: '1 Oak St', notes: 'Gate code 1234' },
        { addOnId: dropoff.id, time: '17:30', address: '1 Oak St' },
        { addOnId: meds.id },
      ],
    });
    expect(bk.status).toBe(200);
    expect(bk.body.addOns.map((a: any) => [a.name, a.date, a.quantity])).toEqual([
      ['Pickup from home', '2026-11-10', 1],
      ['Drop-off at home', '2026-11-12', 1],
      ['Medication', '2026-11-10', 2],
    ]);
    // Owners can add one more later, but not a second pickup.
    expect((await t.call('POST', `/me/bookings/${bk.body.id}/add-ons`, dana, { addOnId: pickup.id, time: '09:00', address: 'x' })).status).toBe(400);
    expect((await t.call('POST', `/me/bookings/${bk.body.id}/add-ons`, dana, { addOnId: nails.id })).status).toBe(200);
    // Sam can't touch Dana's booking.
    const sam = await t.login('sam@example.com');
    expect((await t.call('POST', `/me/bookings/${bk.body.id}/add-ons`, sam, { addOnId: nails.id })).status).toBe(404);

    // The run sheet for the 10th: the pickup, with the address and gate code.
    await t.call('POST', `/bookings/${bk.body.id}/status`, staff, { status: 'confirmed' });
    const sheet = (await t.call<any>('GET', '/run-sheet?date=2026-11-10', staff)).body;
    const run = sheet.transport.find((x: any) => x.dog === 'Biscuit');
    expect(run).toMatchObject({ kind: 'pickup', time: '08:00', address: '1 Oak St', notes: 'Gate code 1234', owner: 'Dana Whitfield' });
    expect(sheet.services.map((s: any) => s.name)).toEqual(expect.arrayContaining(['Medication', 'Nail trim']));

    // Dana hears when the van leaves and when Biscuit is on board.
    await t.call('POST', '/auth/push-token', dana, { token: 'ExponentPushToken[dana-van]', platform: 'ios' });
    expect((await t.call('POST', `/booking-add-ons/${run.id}/status`, staff, { status: 'on_way' })).status).toBe(200);
    expect(t.push.sent.at(-1)!.body).toMatch(/Marco is heading to you to pick up Biscuit/);
    await t.call('POST', `/booking-add-ons/${run.id}/status`, staff, { status: 'done' });
    expect(t.push.sent.at(-1)!.title).toBe('Biscuit is on board');
    // A started pickup can't be cancelled.
    expect((await t.call('DELETE', `/me/booking-add-ons/${run.id}`, dana)).status).toBe(400);

    t.clock.t = Date.parse('2026-11-10T13:30:00Z');
    await t.call('POST', `/owners/${biscuit.owner.id}/cards`, staff, { testCard: 'pm_card_visa' });
    const v = await t.call<any>('POST', '/visits', staff, { bookingId: bk.body.id });
    expect(v.status).toBe(200);
    t.clock.t = Date.parse('2026-11-12T15:00:00Z');
    const bill = (await t.call<any>('GET', `/visits/${v.body.id}/bill`, staff)).body;
    const texts = bill.lines.map((l: any) => l.text);
    expect(texts).toEqual(expect.arrayContaining(['Pickup from home (08:00)', 'Drop-off at home (17:30)', 'Medication × 2', 'Nail trim']));
    const addonTotal = bill.lines.filter((l: any) => l.kind === 'addon').reduce((s: number, l: any) => s + l.amount, 0);
    expect(addonTotal).toBe(1500 + 1500 + 2 * 300 + 1500);
    const out = await t.call<any>('POST', `/visits/${v.body.id}/checkout`, staff, { pay: { method: 'card' } });
    expect(out.body.paid).toBe(true);
    // The drop-off is still the driver's to do after check-out.
    const home = (await t.call<any>('GET', '/run-sheet?date=2026-11-12', staff)).body.transport.find((x: any) => x.dog === 'Biscuit');
    expect(home.status).toBe('scheduled');
    await t.call('POST', `/booking-add-ons/${home.id}/status`, staff, { status: 'done' });
    expect(t.push.sent.at(-1)!.title).toBe('Biscuit is home');
  });

  it('holds to the daily limit and frees the spot when cancelled', async () => {
    const facial = (await settings()).find((a) => a.code === 'blueberry-facial');
    const mochi = await dogByName('Mochi');
    const olive = await dogByName('Olive');
    const first = await t.call<any>('POST', '/bookings', staff, { dogId: mochi.id, service: 'daycare', plan: 'full', date: '2026-11-20', addOns: [{ addOnId: facial.id }] });
    expect(first.status).toBe(200);
    const second = await t.call('POST', '/bookings', staff, { dogId: olive.id, service: 'daycare', plan: 'full', date: '2026-11-20', addOns: [{ addOnId: facial.id }] });
    expect(second.status).toBe(409);
    expect((await t.call('DELETE', `/booking-add-ons/${first.body.addOns[0].id}`, staff)).status).toBe(200);
    expect((await t.call('POST', '/bookings', staff, { dogId: olive.id, service: 'daycare', plan: 'full', date: '2026-11-20', addOns: [{ addOnId: facial.id }] })).status).toBe(200);
    // Switched off, it can't be booked any more.
    await t.call('PATCH', `/settings/add-ons/${facial.id}`, mgr, { active: false });
    expect((await t.call('POST', `/bookings/${first.body.id}/add-ons`, staff, { addOnId: facial.id })).status).toBe(404);
  });

  it('keeps add-ons inside their own daycare', async () => {
    const other = await t.call<any>('POST', '/public/daycares', null, { name: 'Bark Park', managerName: 'Ola', managerEmail: 'ola@barkpark.test', managerPassword: 'bark-park-2026!' });
    const theirs = other.body.token as string;
    const pickup = (await settings()).find((a) => a.kind === 'pickup');
    expect((await t.call('PATCH', `/settings/add-ons/${pickup.id}`, theirs, { priceCents: 1 })).status).toBe(404);
    const sheet = (await t.call<any>('GET', '/run-sheet?date=2026-11-10', staff)).body;
    expect((await t.call('POST', `/booking-add-ons/${sheet.transport[0].id}/status`, theirs, { status: 'done' })).status).toBe(404);
    expect((await t.call<any>('GET', '/run-sheet?date=2026-11-10', theirs)).body.transport).toHaveLength(0);
  });
});
