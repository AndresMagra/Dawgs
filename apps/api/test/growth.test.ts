import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

type App = Awaited<ReturnType<typeof makeApp>>;

let t: App;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => t.close());

describe('staff permissions', () => {
  it('keeps money, refunds and exports from staff until a manager allows them', async () => {
    const mgr = await t.login('priya@happytails.test');
    const staff = await t.login('marco@happytails.test');
    expect((await t.call('GET', '/reports', staff)).status).toBe(403);
    expect((await t.call('GET', '/reports/export?kind=clients', staff)).status).toBe(403);
    expect((await t.call<any>('GET', '/auth/me', staff)).body.can).toMatchObject({ seeMoney: false, export: false });
    expect((await t.call<any>('GET', '/auth/me', mgr)).body.can).toMatchObject({ seeMoney: true, refund: true });

    expect((await t.call('PATCH', '/settings', mgr, { staffPermissions: { seeMoney: true } })).status).toBe(200);
    expect((await t.call('GET', '/reports', staff)).status).toBe(200);
    expect((await t.call('GET', '/reports/export?kind=clients', staff)).status).toBe(403);
    const s = (await t.call<any>('GET', '/settings', mgr)).body;
    expect(s.business.staffPermissions).toMatchObject({ seeMoney: true, export: false });
    // Staff can't hand themselves more.
    expect((await t.call('PATCH', '/settings', staff, { staffPermissions: { export: true } })).status).toBe(403);
    await t.call('PATCH', '/settings', mgr, { staffPermissions: { seeMoney: false } });
  });
});

describe('campaigns', () => {
  it('previews a group, sends with an opt-out line, skips opted-out clients, and reports what followed', async () => {
    const mgr = await t.login('priya@happytails.test');
    const staff = await t.login('marco@happytails.test');
    const preview = (await t.call<any>('GET', '/campaigns/audience?audience=all', mgr)).body;
    expect(preview.count).toBeGreaterThan(2);
    expect((await t.call('GET', '/campaigns/audience?audience=all', staff)).status).toBe(403);

    const owners = (await t.call<any>('GET', '/owners', mgr)).body as any[];
    const alex = owners.find((o) => o.name.startsWith('Alex'));
    const { db } = t.ctx;
    const { owners: ownersT } = await import('@dawgs/db');
    const { eq } = await import('drizzle-orm');
    await db.update(ownersT).set({ marketingOptOut: true }).where(eq(ownersT.id, alex.id));
    const after = (await t.call<any>('GET', '/campaigns/audience?audience=all', mgr)).body;
    expect(after.count).toBe(preview.count - 1);
    expect(after.optedOut).toBe(1);

    expect((await t.call('POST', '/campaigns', mgr, { name: 'Fall', audience: 'all', channel: 'email', body: 'Hi' })).status).toBe(400);
    const texts = t.sms.sent.length;
    const mails = t.mail.sent.length;
    const sent = await t.call<any>('POST', '/campaigns', mgr, { name: 'Fall special', audience: 'all', channel: 'both', subject: '20% off baths', body: 'Baths are 20% off this week.' });
    expect(sent.status).toBe(200);
    const newTexts = t.sms.sent.slice(texts);
    expect(newTexts.length).toBeGreaterThan(0);
    expect(newTexts.every((m) => m.body.endsWith('Reply STOP to opt out.'))).toBe(true);
    const newMail = t.mail.sent.slice(mails);
    expect(newMail.length).toBeGreaterThan(0);
    expect(newMail[0]!.text).toContain('unsubscribe');
    expect(newMail.some((m) => m.to === alex.email)).toBe(false);

    // A recipient books afterwards: that's the campaign's result.
    t.clock.t += 3_600_000;
    const dana = await t.login('dana@example.com');
    const dogs = (await t.call<any>('GET', '/me', dana)).body.dogs;
    const r = await t.call('POST', '/me/bookings', dana, { dogId: dogs[0].id, service: 'daycare', plan: 'full', date: '2026-11-20' });
    expect(r.status).toBe(200);
    const list = (await t.call<any>('GET', '/campaigns', mgr)).body;
    expect(list[0]).toMatchObject({ name: 'Fall special', recipients: after.count });
    expect(list[0].results.bookings).toBeGreaterThanOrEqual(1);
  });
});

describe('referrals', () => {
  it('gives each client a link; a friend who inquires through it and becomes a client earns the reward', async () => {
    const mgr = await t.login('priya@happytails.test');
    const sam = await t.login('sam@example.com');
    const ref = (await t.call<any>('GET', '/me/referral', sam)).body;
    expect(ref.code).toMatch(/^[A-Z0-9x]{8}$/i);
    expect(ref.rewardCredits).toBe(0);
    expect((await t.call<any>('GET', '/me/referral', sam)).body.code).toBe(ref.code);

    await t.call('PATCH', '/settings', mgr, { policies: { referralRewardCredits: 2 } });
    const r = await t.call('POST', '/public/daycares/happy-tails/inquiry', null, { name: 'Robin Friend', email: 'robin@example.com', dogName: 'Ziggy', ref: ref.code.toLowerCase() });
    expect(r.status).toBe(200);
    const lead = (await t.call<any>('GET', '/leads', mgr)).body.leads.find((l: any) => l.name === 'Robin Friend');
    expect(lead.source).toBe('referral');

    const wallet = async () => {
      const dogs = (await t.call<any>('GET', '/me', sam)).body.dogs as any[];
      return dogs.reduce((s, d) => s + (d.wallet?.daycare ?? 0), 0);
    };
    const before = await wallet();
    const conv = await t.call<any>('POST', `/leads/${lead.id}/convert`, mgr);
    expect(conv.body.referralRewarded).toBe(true);
    expect(await wallet()).toBe(before + 2);
    expect((await t.call<any>('GET', '/me/referral', sam)).body).toMatchObject({ referred: 1, joined: 1, rewardCredits: 2 });

    // A made-up code still delivers the inquiry, just without credit.
    await t.call('POST', '/public/daycares/happy-tails/inquiry', null, { name: 'Lee Nobody', email: 'lee@example.com', ref: 'NOTACODE' });
    const lee = (await t.call<any>('GET', '/leads', mgr)).body.leads.find((l: any) => l.name === 'Lee Nobody');
    expect(lee.source).toBe('website');
  });
});

describe('checklists', () => {
  it('managers set routines; staff tick items for the day, once, and can untick', async () => {
    const mgr = await t.login('priya@happytails.test');
    const staff = await t.login('marco@happytails.test');
    expect((await t.call('POST', '/checklists', staff, { name: 'Opening', items: ['Lights'] })).status).toBe(403);
    const c = (await t.call<any>('POST', '/checklists', mgr, { name: 'Opening', items: ['Unlock gates', 'Fill water bowls', 'Fill water bowls'] })).body;
    expect(c.items).toEqual(['Unlock gates', 'Fill water bowls']);

    expect((await t.call('POST', `/checklists/${c.id}/check`, staff, { item: 'Unlock gates', done: true })).status).toBe(200);
    expect((await t.call('POST', `/checklists/${c.id}/check`, staff, { item: 'Unlock gates', done: true })).status).toBe(200);
    expect((await t.call('POST', `/checklists/${c.id}/check`, staff, { item: 'Not on it', done: true })).status).toBe(400);
    let today = (await t.call<any>('GET', '/checklists', staff)).body.find((x: any) => x.id === c.id);
    expect(today.done).toBe(1);
    expect(today.items[0]).toMatchObject({ item: 'Unlock gates', doneBy: expect.stringContaining('Marco') });
    // Another day starts fresh.
    const other = (await t.call<any>('GET', '/checklists?date=2026-11-05', staff)).body.find((x: any) => x.id === c.id);
    expect(other.done).toBe(0);
    await t.call('POST', `/checklists/${c.id}/check`, staff, { item: 'Unlock gates', done: false });
    today = (await t.call<any>('GET', '/checklists', staff)).body.find((x: any) => x.id === c.id);
    expect(today.done).toBe(0);

    await t.call('PATCH', `/checklists/${c.id}`, mgr, { name: 'Opening', items: ['Unlock gates'], active: false });
    expect((await t.call<any>('GET', '/checklists', staff)).body.some((x: any) => x.id === c.id)).toBe(false);
    expect((await t.call<any>('GET', '/checklists?all=1', mgr)).body.some((x: any) => x.id === c.id)).toBe(true);
  });
});
