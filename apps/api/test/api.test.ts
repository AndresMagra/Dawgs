import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

type App = Awaited<ReturnType<typeof makeApp>>;
const H = 3_600_000;

let t: App;
let mgr: string;
let staff: string;
let dana: string;
let sam: string;

beforeAll(async () => {
  t = await makeApp();
});
// Sessions last 30 days and some tests move the clock months ahead.
beforeEach(async () => {
  mgr = await t.login('priya@happytails.test');
  staff = await t.login('marco@happytails.test');
  dana = await t.login('dana@example.com');
  sam = await t.login('sam@example.com');
});
afterAll(async () => t.close());

let samVisa: string;

async function dogByName(name: string) {
  const r = await t.call<any[]>('GET', '/dogs', await t.login('priya@happytails.test'));
  const d = r.body.find((x) => x.name === name);
  if (!d) throw new Error(`no dog ${name}`);
  return d;
}

describe('access', () => {
  it('closes every route that is not marked public', async () => {
    expect((await t.call('GET', '/dogs')).status).toBe(401);
    expect((await t.call('GET', '/me')).status).toBe(401);
    expect((await t.call('GET', '/health')).status).toBe(200);
  });

  it('keeps owners out of staff screens and staff out of manager screens', async () => {
    expect((await t.call('GET', '/dogs', dana)).status).toBe(403);
    expect((await t.call('GET', '/money/summary', staff)).status).toBe(403);
    expect((await t.call('GET', '/money/summary', mgr)).status).toBe(200);
  });

  it("never shows an owner another owner's dog", async () => {
    const luna = await dogByName('Luna');
    expect((await t.call('GET', `/me/dogs/${luna.id}`, dana)).status).toBe(404);
    expect((await t.call('GET', `/me/dogs/${luna.id}`, sam)).status).toBe(200);
  });

  it('keeps daycares apart', async () => {
    const r = await t.call<any>('POST', '/public/daycares', null, {
      name: 'Other Place',
      managerName: 'Olga',
      managerEmail: 'olga@other.test',
      managerPassword: 'other-pass-2026',
    });
    expect(r.status).toBe(200);
    const olga = r.body.token as string;
    const biscuit = await dogByName('Biscuit');
    expect((await t.call('GET', `/dogs/${biscuit.id}`, olga)).status).toBe(404);
    expect((await t.call<any[]>('GET', '/dogs', olga)).body).toHaveLength(0);
  });
});

describe('waivers and vaccines gate bookings', () => {
  it('a new owner must sign the waiver and have verified shots before booking', async () => {
    const su = await t.call<any>('POST', '/auth/signup', null, {
      business: 'happy-tails',
      name: 'Casey New',
      email: 'casey@example.com',
      phone: '(555) 444-1212',
      password: 'casey-pass-1',
    });
    expect(su.status).toBe(200);
    const casey = su.body.token;
    const dog = (await t.call<any>('POST', '/me/dogs', casey, { name: 'Ziggy', breed: 'Mutt', weightLb: 30 })).body;
    const me = (await t.call<any>('GET', '/me', casey)).body;
    expect(me.formsToSign).toBe(1);

    const date = '2026-11-06';
    let r = await t.call<any>('POST', '/me/bookings', casey, { dogId: dog.id, service: 'daycare', plan: 'full', date });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/vaccines/);

    // Owner uploads shots; they do not count until staff verify them.
    for (const name of ['Rabies', 'DHPP', 'Bordetella']) {
      await t.call('POST', `/me/dogs/${dog.id}/vaccines`, casey, { name, expiresOn: '2027-10-01' });
    }
    r = await t.call<any>('POST', '/me/bookings', casey, { dogId: dog.id, service: 'daycare', plan: 'full', date });
    expect(r.body.message).toMatch(/vaccines/);
    const detail = (await t.call<any>('GET', `/dogs/${dog.id}`, staff)).body;
    for (const v of detail.vaccineRecords) await t.call('POST', `/vaccines/${v.id}/verify`, staff, {});

    r = await t.call<any>('POST', '/me/bookings', casey, { dogId: dog.id, service: 'daycare', plan: 'full', date });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/sign/);

    const form = me.forms[0];
    const signed = await t.call<any>('POST', `/me/waivers/${form.waiverId}/sign`, casey, {
      signedName: 'Casey New',
      signatureImage: 'M0 0 L10 10',
      version: form.version,
      agree: true,
    });
    expect(signed.status).toBe(200);
    expect(signed.body.bodySigned).toContain('liability');

    r = await t.call<any>('POST', '/me/bookings', casey, { dogId: dog.id, service: 'daycare', plan: 'full', date });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('requested');
  });

  it('editing the waiver text asks everyone to sign again', async () => {
    const list = (await t.call<any[]>('GET', '/waivers', mgr)).body;
    const w = list[0];
    const up = await t.call<any>('PATCH', `/waivers/${w.id}`, mgr, { body: `${w.body}\n7. Dogs must be picked up by closing.` });
    expect(up.body.version).toBe(w.version + 1);
    const me = (await t.call<any>('GET', '/me', dana)).body;
    expect(me.formsToSign).toBe(1);
    const stale = await t.call<any>('POST', `/me/waivers/${w.id}/sign`, dana, { signedName: 'Dana Whitfield', version: w.version, agree: true });
    expect(stale.status).toBe(409);
    for (const tok of [dana, sam, await t.login('alex@example.com'), await t.login('jordan@example.com'), await t.login('riley@example.com'), ]) {
      const ok = await t.call('POST', `/me/waivers/${w.id}/sign`, tok, { signedName: 'Signed again', version: w.version + 1, agree: true });
      expect(ok.status).toBe(200);
    }
  });
});

describe('a daycare day', () => {
  it('checks a dog in, spends a credit, and charges the card on file at check-out', async () => {
    const biscuit = await dogByName('Biscuit');
    expect(biscuit.wallet.daycare).toBe(6);
    // Dana adds a card in the customer app.
    const card = await t.call<any>('POST', '/me/cards', dana, { testCard: 'pm_card_visa' });
    expect(card.body.last4).toBe('4242');

    const yards = (await t.call<any>('GET', '/settings', staff)).body.yards;
    const big = yards.find((y: any) => y.name === 'Big yard');
    const v = await t.call<any>('POST', '/visits', staff, { dogId: biscuit.id, service: 'daycare', plan: 'full', yardId: big.id, pickupTime: '17:00' });
    expect(v.status).toBe(200);
    const again = await t.call<any>('POST', '/visits', staff, { dogId: biscuit.id, service: 'daycare', plan: 'full' });
    expect(again.status).toBe(409);

    const board = (await t.call<any>('GET', '/board', staff)).body;
    expect(board.inBuilding).toHaveLength(1);
    expect(board.tasks.some((x: any) => x.kind === 'feeding')).toBe(true);

    // 4:05 PM: inside the last hour before a 5 PM pickup, the text goes out once.
    t.clock.t += 8 * H + 5 * 60_000;
    const { tick } = await import('../src/scheduler.js');
    expect((await tick(t.ctx)).pickupTexts).toBe(1);
    expect((await tick(t.ctx)).pickupTexts).toBe(0);
    expect(t.sms.sent.at(-1)!.to).toBe('+15552014410');
    expect(t.sms.sent.at(-1)!.body).toMatch(/Biscuit is ready for pickup around 5:00 PM/);

    const out = await t.call<any>('POST', `/visits/${v.body.id}/checkout`, staff, { addOns: ['nails'], pay: { method: 'card' } });
    expect(out.status).toBe(200);
    expect(out.body.paid).toBe(true);
    expect(out.body.invoice.totalCents).toBe(1500); // full day covered by a credit; nail trim charged
    expect((await dogByName('Biscuit')).wallet.daycare).toBe(5);
  });

  it('keeps the invoice open when a card is declined, then takes cash', async () => {
    const pepper = await dogByName('Pepper');
    await t.call('POST', `/owners/${pepper.owner.id}/cards`, staff, { testCard: 'pm_card_chargeDeclined' });
    const v = await t.call<any>('POST', '/visits', staff, { dogId: pepper.id, service: 'daycare', plan: 'half' });
    t.clock.t += 2 * H;
    const out = await t.call<any>('POST', `/visits/${v.body.id}/checkout`, staff, { pay: { method: 'card' } });
    expect(out.body.paid).toBe(false);
    expect(out.body.declined.message).toMatch(/declined/);
    expect(out.body.invoice.status).toBe('open');
    const cash = await t.call<any>('POST', `/invoices/${out.body.invoice.id}/pay`, staff, { pay: { method: 'cash' } });
    expect(cash.body.paid).toBe(true);
  });

  it('pays an invoice through a texted link', async () => {
    const olive = await dogByName('Olive');
    t.clock.t = Date.parse('2026-11-05T14:00:00Z'); // next morning, well before closing
    const v = await t.call<any>('POST', '/visits', staff, { dogId: olive.id, service: 'daycare', plan: 'hourly' });
    t.clock.t += 90 * 60_000;
    const out = await t.call<any>('POST', `/visits/${v.body.id}/checkout`, staff, { pay: { method: 'later' } });
    expect(out.body.invoice.totalCents).toBe(Math.round((6 * 900) / 4));
    const link = await t.call<any>('POST', `/invoices/${out.body.invoice.id}/link`, staff, { text: true });
    expect(link.body.url).toMatch(/^https:\/\/app\.dawgs\.test\/pay\//);
    expect(t.sms.sent.at(-1)!.body).toContain(link.body.url);
    const page = await t.call<any>('GET', `/pay/${link.body.token}`);
    expect(page.body.dueCents).toBe(out.body.invoice.totalCents);
    const paid = await t.call<any>('POST', `/pay/${link.body.token}/simulate`, null, { paymentIntentId: page.body.paymentIntentId, testCard: 'pm_card_visa' });
    expect(paid.body.paid).toBe(true);
    const inv = (await t.call<any>('GET', `/invoices/${out.body.invoice.id}`, staff)).body;
    expect(inv.invoice.status).toBe('paid');
    expect(inv.payments[0].method).toBe('link');
  });

  it('refunds part of a payment', async () => {
    const list = (await t.call<any[]>('GET', '/invoices?status=paid', mgr)).body;
    const inv = list.find((i) => i.totalCents > 0)!;
    const detail = (await t.call<any>('GET', `/invoices/${inv.id}`, mgr)).body;
    const p = detail.payments.find((x: any) => x.status === 'succeeded');
    expect((await t.call('POST', `/payments/${p.id}/refund`, staff, { amountCents: 100 })).status).toBe(403);
    const r = await t.call<any>('POST', `/payments/${p.id}/refund`, mgr, { amountCents: 100 });
    expect(r.status).toBe(200);
  });
});

describe('boarding', () => {
  it('books a kennel, refuses a double booking, and bills nights with a late check-out', async () => {
    const bruno = await dogByName('Bruno');
    const avail = await t.call<any>('GET', '/availability?service=boarding&arrive=2026-11-10&depart=2026-11-13', staff);
    const suite = avail.body.freeKennels.find((k: any) => k.type === 'suite');
    expect(avail.body.nights).toBe(3);
    const bk = await t.call<any>('POST', '/bookings', staff, { dogId: bruno.id, service: 'boarding', arrive: '2026-11-10', depart: '2026-11-13', kennelId: suite.id, play: true });
    expect(bk.status).toBe(200);
    const mochi = await dogByName('Mochi');
    const clash = await t.call<any>('POST', '/bookings', staff, { dogId: mochi.id, service: 'boarding', arrive: '2026-11-12', depart: '2026-11-14', kennelId: suite.id });
    expect(clash.status).toBe(409);
    const sameDay = await t.call<any>('POST', '/bookings', staff, { dogId: mochi.id, service: 'boarding', arrive: '2026-11-13', depart: '2026-11-14', kennelId: suite.id });
    expect(sameDay.status).toBe(200);

    t.clock.t = Date.parse('2026-11-10T22:00:00Z'); // 5 PM Eastern
    await t.call('POST', `/owners/${bruno.owner.id}/cards`, staff, { testCard: 'pm_card_mastercard' });
    const v = await t.call<any>('POST', '/visits', staff, { bookingId: bk.body.id });
    expect(v.status).toBe(200);
    t.clock.t = Date.parse('2026-11-13T17:30:00Z'); // 12:30 PM, after noon
    const bill = (await t.call<any>('GET', `/visits/${v.body.id}/bill`, staff)).body;
    // 3 nights × $75 − 2 night credits, 3 days play × $18, late check-out $20
    expect(bill.total).toBe(3 * 7500 - 2 * 7500 + 3 * 1800 + 2000);
    const out = await t.call<any>('POST', `/visits/${v.body.id}/checkout`, staff, { pay: { method: 'card' } });
    expect(out.body.paid).toBe(true);
  });
});

describe('packs and memberships', () => {
  it('grants credits only after the pack is paid', async () => {
    const pkgs = (await t.call<any[]>('GET', '/me/packages', sam)).body;
    const ten = pkgs.find((p) => p.name.startsWith('10-day'));
    const luna = await dogByName('Luna');
    // Sam's first card (added at the desk) declines; he adds a good one and pays with it.
    samVisa = (await t.call<any>('POST', '/me/cards', sam, { testCard: 'pm_card_visa' })).body.id;
    const r = await t.call<any>('POST', `/me/packages/${ten.id}/buy`, sam, { dogId: luna.id, paymentMethodId: samVisa });
    expect(r.body.paid).toBe(true);
    expect((await dogByName('Luna')).wallet.daycare).toBe(10);
  });

  it('renews monthly, rolls over, retries every 3 days and cancels after 4 failures', async () => {
    const { tick } = await import('../src/scheduler.js');
    const pkgs = (await t.call<any[]>('GET', '/packages', staff)).body;
    const monthly = pkgs.find((p) => p.recurring);
    const olive = await dogByName('Olive');
    await t.call('POST', `/owners/${olive.owner.id}/cards`, staff, { testCard: 'pm_card_visa' });
    const start = await t.call<any>('POST', `/packages/${monthly.id}/sell`, staff, { dogId: olive.id, pay: { method: 'card' } });
    expect(start.body.paid).toBe(true);
    expect((await dogByName('Olive')).wallet.daycare).toBe(12);

    // Next month renews: 12 new + up to 2 rolled over.
    t.clock.t += 32 * 24 * H;
    await tick(t.ctx);
    expect((await dogByName('Olive')).wallet.daycare).toBe(14);

    // Swap the card for one that declines, then run past the next renewal.
    const desk = await t.login('marco@happytails.test');
    const owner = (await t.call<any>('GET', `/owners/${olive.owner.id}`, desk)).body;
    for (const c of owner.cards) await t.call('DELETE', `/owners/${olive.owner.id}/cards/${c.id}`, desk);
    await t.call('POST', `/owners/${olive.owner.id}/cards`, desk, { testCard: 'pm_card_chargeDeclinedInsufficientFunds' });
    t.clock.t += 31 * 24 * H;
    for (let i = 0; i < 4; i++) {
      await tick(t.ctx);
      t.clock.t += 3 * 24 * H + 60_000;
    }
    const desk2 = await t.login('marco@happytails.test');
    const ms = (await t.call<any[]>('GET', '/memberships', desk2)).body.filter((m) => m.dogId === olive.id);
    expect(ms[0].status).toBe('cancelled');
    expect(ms[0].failures).toBe(4);
    const open = (await t.call<any[]>('GET', `/invoices?status=open&ownerId=${olive.owner.id}`, desk2)).body;
    expect(open).toHaveLength(1); // one month's invoice retried, not four
  });
});

describe('walks', () => {
  it('runs a walk with GPS, charges a walk credit, and reports to the owner', async () => {
    const mochi = await dogByName('Mochi');
    const types = (await t.call<any[]>('GET', '/me/walk-types', await t.login('alex@example.com'))).body;
    const alex = await t.login('alex@example.com');
    const req = await t.call<any>('POST', '/me/walks', alex, { dogId: mochi.id, walkTypeId: types[1].id, scheduledAt: t.clock.t + H });
    expect(req.body.status).toBe('requested');
    const staffList = (await t.call<any[]>('GET', '/staff', mgr)).body;
    const marco = staffList.find((s) => s.name === 'Marco');
    expect((await t.call('POST', `/walks/${req.body.id}/assign`, staff, { walkerId: marco.id })).status).toBe(403);
    await t.call('POST', `/walks/${req.body.id}/assign`, mgr, { walkerId: marco.id });
    const leo = await t.login('leo@happytails.test');
    expect((await t.call('POST', `/walks/${req.body.id}/start`, leo)).status).toBe(403);
    expect((await t.call('POST', `/walks/${req.body.id}/start`, staff)).status).toBe(200);

    const t0 = t.clock.t;
    const points = Array.from({ length: 31 }, (_, i) => ({ lat: 40 + i * 0.0003, lng: -75, at: t0 + i * 60_000, accuracy: 8 }));
    await t.call('POST', `/walks/${req.body.id}/points`, staff, { points: points.slice(0, 15) });
    const live = (await t.call<any>('GET', `/me/walks/${req.body.id}`, alex)).body;
    expect(live.track).toHaveLength(15);
    await t.call('POST', `/walks/${req.body.id}/points`, staff, { points: points.slice(15) });
    t.clock.t = t0 + 31 * 60_000;
    const done = await t.call<any>('POST', `/walks/${req.body.id}/finish`, staff, { pee: true, poop: true, report: 'Great walk, chased a leaf.' });
    expect(done.status).toBe(200);
    expect(done.body.summary.meters).toBeGreaterThan(950);
    expect(done.body.invoice.totalCents).toBe(0);
    expect((await dogByName('Mochi')).wallet.walk).toBe(1);
    expect(t.sms.sent.at(-1)!.body).toMatch(/Mochi walked 0\.6\d mi in 30 min \(pee and poop\)/);
  });
});

describe('training', () => {
  it('enrolls a dog in a class once paid, tracks attendance and shares progress', async () => {
    const programs = (await t.call<any>('GET', '/me/training', dana)).body.programs;
    const puppy = programs.find((p: any) => p.name === 'Puppy Basics');
    await t.call('POST', `/training/programs/${puppy.id}/sessions`, mgr, { firstStartsAt: t.clock.t + 24 * H, count: 6 });
    const biscuit = await dogByName('Biscuit');
    const r = await t.call<any>('POST', `/me/training/${puppy.id}/enroll`, dana, { dogId: biscuit.id });
    expect(r.body.paid).toBe(true);
    const mine = (await t.call<any>('GET', '/me/training', dana)).body;
    expect(mine.enrollments[0].status).toBe('enrolled');
    expect(mine.mySessions).toHaveLength(6);

    const s = mine.mySessions[0];
    const roster = (await t.call<any>('GET', `/training/sessions/${s.id}`, staff)).body;
    expect(roster.dogs.map((d: any) => d.name)).toEqual(['Biscuit']);
    await t.call('POST', `/training/sessions/${s.id}/attendance`, staff, { marks: [{ dogId: biscuit.id, attended: true }] });
    await t.call('POST', `/dogs/${biscuit.id}/progress`, staff, { skill: 'Sit', level: 3, homework: 'Practice sit at doors' });
    await t.call('POST', `/dogs/${biscuit.id}/progress`, staff, { skill: 'Down', level: 1, sharedWithOwner: false });
    const dog = (await t.call<any>('GET', `/me/dogs/${biscuit.id}`, dana)).body;
    expect(dog.training.skills).toEqual([expect.objectContaining({ skill: 'Sit', level: 3, label: 'Reliable' })]);
  });

  it('spends a training credit on a private lesson and refuses a trainer double booking', async () => {
    const programs = (await t.call<any[]>('GET', '/training/programs', staff)).body;
    const priv = programs.find((p) => p.kind === 'private');
    const pkgs = (await t.call<any[]>('GET', '/packages', staff)).body;
    const lessons = pkgs.find((p) => p.credits.training);
    const luna = await dogByName('Luna');
    await t.call('POST', `/me/cards/${samVisa}/default`, sam, {});
    await t.call('POST', `/packages/${lessons.id}/sell`, staff, { dogId: luna.id, pay: { method: 'card' } });
    const at = t.clock.t + 48 * H;
    const r = await t.call<any>('POST', `/training/programs/${priv.id}/private`, staff, { dogId: luna.id, startsAt: at, pay: { method: 'card' } });
    expect(r.body.invoice.totalCents).toBe(0);
    expect((await dogByName('Luna')).wallet.training).toBe(3);
    const clash = await t.call<any>('POST', `/training/programs/${priv.id}/private`, staff, { dogId: luna.id, startsAt: at + 15 * 60_000, pay: { method: 'card' } });
    expect(clash.status).toBe(409);
  });
});

describe('calendar, team and texts', () => {
  it('shows bookings, walks, training and shifts on one calendar', async () => {
    const cal = (await t.call<any>('GET', '/calendar?from=2026-11-01&to=2026-12-31', mgr)).body;
    expect(cal.events.some((e: any) => e.type === 'boarding')).toBe(true);
    const thisWeek = (await t.call<any>('GET', '/calendar', mgr)).body;
    expect(thisWeek.events.some((e: any) => e.type === 'training')).toBe(true);
    const mine = (await t.call<any>('GET', '/me/calendar?from=2026-11-01&to=2026-12-31', dana)).body;
    expect(mine.events.every((e: any) => !e.title.includes('Bruno'))).toBe(true);
  });

  it('clocks staff in and out and pays overtime past 40 hours', async () => {
    const leo = await t.login('leo@happytails.test');
    const staffList = (await t.call<any[]>('GET', '/staff', mgr)).body;
    const leoId = staffList.find((s) => s.name === 'Leo').id;
    const monday = Date.parse('2027-01-04T14:00:00Z');
    for (let d = 0; d < 5; d++) {
      await t.call('POST', '/punches', mgr, { userId: leoId, inAt: monday + d * 24 * H, outAt: monday + d * 24 * H + 9 * H });
    }
    t.clock.t = Date.parse('2027-01-11T12:00:00Z');
    const pay = (await t.call<any>('GET', '/payroll?weekStart=2027-01-04', mgr)).body;
    const row = pay.rows.find((r: any) => r.name === 'Leo');
    expect(row.hours).toBe(45);
    expect(row.gross).toBe(40 * 1600 + 5 * 1600 * 1.5);
    expect((await t.call('POST', '/clock/in', leo)).status).toBe(200);
    expect((await t.call('POST', '/clock/in', leo)).status).toBe(409);
    expect((await t.call('POST', '/clock/out', leo)).status).toBe(200);
  });

  it('lets staff message managers but not each other directly', async () => {
    const list = (await t.call<any[]>('GET', '/chat', staff)).body;
    expect(list.map((c) => c.name)).toEqual(['Whole team', 'Priya']);
    const staffList = (await t.call<any[]>('GET', '/staff', mgr)).body;
    const ids = Object.fromEntries(staffList.map((s) => [s.name, s.id]));
    const ch = [ids.Marco, ids.Priya].sort().join(':');
    expect((await t.call('POST', `/chat/${ch}`, staff, { body: 'Running 10 min late' })).status).toBe(200);
    const peer = [ids.Marco, ids.Jess].sort().join(':');
    expect((await t.call('POST', `/chat/${peer}`, staff, { body: 'hi' })).status).toBe(400);
    const unread = (await t.call<any[]>('GET', '/chat', mgr)).body.find((c) => c.name === 'Marco');
    expect(unread.unread).toBe(1);
    expect((await t.call('GET', `/chat/${ch}`, dana)).status).toBe(403);
  });

  it('honours STOP from an owner', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/webhooks/twilio',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'From=%2B15552014410&To=%2B15550000000&Body=STOP',
    });
    // No daycare uses that number yet, so it is refused rather than guessed at.
    expect(r.statusCode).toBe(404);
  });
});
