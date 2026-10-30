import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { businesses, dogs } from '@dawgs/db';
import { makeApp } from './helpers.js';
import { tick } from '../src/scheduler.js';

type App = Awaited<ReturnType<typeof makeApp>>;

let t: App;
let mgr: string;
let staff: string;
beforeAll(async () => {
  t = await makeApp(); // Wed 4 Nov 2026, 08:00 Eastern
  mgr = await t.login('priya@happytails.test');
  staff = await t.login('marco@happytails.test');
  const [b] = await t.ctx.db.select().from(businesses).where(eq(businesses.slug, 'happy-tails'));
  await t.ctx.db.update(businesses).set({ twilioFrom: '+15550001111' }).where(eq(businesses.id, b!.id));
});
afterAll(async () => t.close());

const dog = async (name: string) => (await t.call<any[]>('GET', '/dogs', mgr)).body.find((d) => d.name === name)!;
const inbound = (from: string, body: string) =>
  t.app.inject({
    method: 'POST',
    url: '/webhooks/twilio',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `From=${encodeURIComponent(from)}&To=%2B15550001111&Body=${encodeURIComponent(body)}`,
  });

describe('two-way texts', () => {
  it('groups texts into conversations, counts unread, and replies', async () => {
    await t.call('POST', '/auth/push-token', mgr, { token: 'ExponentPushToken[priya-inbox]', platform: 'ios' });
    // Dana's number from the seed.
    expect((await inbound('+15552014410', 'Can Biscuit stay late today?')).statusCode).toBe(200);
    expect(t.push.sent.at(-1)).toMatchObject({ title: 'Text from Dana Whitfield' });
    await inbound('+15559990000', 'Do you do grooming?');
    expect((await t.call<any>('GET', '/texts/unread', staff)).body.unread).toBe(2);
    const box = (await t.call<any[]>('GET', '/texts/inbox', staff)).body;
    const dana = box.find((x) => x.name === 'Dana Whitfield');
    const stranger = box.find((x) => x.phone === '+15559990000');
    expect(dana.unread).toBe(1);
    expect(stranger).toMatchObject({ name: '+15559990000', unread: 1, ownerId: null });

    const th = (await t.call<any[]>('GET', `/texts/thread?ownerId=${dana.ownerId}`, staff)).body;
    expect(th.at(-1).body).toBe('Can Biscuit stay late today?');
    expect((await t.call<any>('GET', '/texts/unread', staff)).body.unread).toBe(1);
    expect((await t.call('POST', '/texts/reply', staff, { ownerId: dana.ownerId, body: 'Sure, until 7!' })).status).toBe(200);
    expect(t.sms.sent.at(-1)).toMatchObject({ to: '+15552014410', body: 'Sure, until 7!' });
    // Someone who texted first can be answered; a random number can't be texted from here.
    expect((await t.call('POST', '/texts/reply', staff, { phone: '+15559990000', body: 'Yes! Baths and nails.' })).status).toBe(200);
    expect((await t.call('POST', '/texts/reply', staff, { phone: '+15558887777', body: 'Hi' })).status).toBe(400);
    await inbound('+15559990000', 'STOP');
    expect((await t.call('POST', '/texts/reply', staff, { phone: '+15559990000', body: 'Bye' })).status).toBe(400);
    // Another daycare can't read Dana's thread.
    const other = await t.call<any>('POST', '/public/daycares', null, { name: 'Bark Park', managerName: 'Ola', managerEmail: 'ola@barkpark.test', managerPassword: 'bark-park-2026!' });
    expect((await t.call('GET', `/texts/thread?ownerId=${dana.ownerId}`, other.body.token)).status).toBe(404);
    expect((await t.call('POST', '/texts/reply', other.body.token, { ownerId: dana.ownerId, body: 'x' })).status).toBe(404);
  });
});

describe('report cards', () => {
  it('saves drafts and sends the day in one go, once', async () => {
    await t.call('PATCH', '/settings', mgr, { policies: { reportCardTexts: true } });
    const dana = await t.login('dana@example.com');
    await t.call('POST', '/auth/push-token', dana, { token: 'ExponentPushToken[dana-rc]', platform: 'ios' });
    const biscuit = await dog('Biscuit');
    const mochi = await dog('Mochi');
    await t.call('POST', '/visits', staff, { dogId: biscuit.id, service: 'daycare', plan: 'full' });
    await t.call('POST', '/visits', staff, { dogId: mochi.id, service: 'daycare', plan: 'full' });
    const n = await t.call<any>('POST', `/dogs/${biscuit.id}/notes`, staff, { kind: 'report', body: 'Loved the pool.', draft: true, details: { mood: 'great', ate: 'all', playmates: ['Mochi'] } });
    expect(n.body.sharedWithOwner).toBe(false);
    const day = (await t.call<any>('GET', '/report-cards', staff)).body;
    expect(day.cards.map((c: any) => [c.dog, c.sentAt])).toEqual([['Biscuit', null]]);
    expect(day.missing.map((m: any) => m.dog)).toEqual(['Mochi']);
    // Not visible to Dana until sent.
    const before = JSON.stringify((await t.call('GET', `/me/dogs/${biscuit.id}`, dana)).body);
    expect(before).not.toContain('Loved the pool.');

    const sent = await t.call<any>('POST', '/report-cards/send', staff, { ids: [n.body.id] });
    expect(sent.body.sent).toBe(1);
    expect(t.push.sent.at(-1)).toMatchObject({ title: "Biscuit's report card", body: 'Biscuit had a great day, played with Mochi, ate everything.' });
    expect(t.sms.sent.at(-1)!.body).toContain('Biscuit had a great day');
    expect((await t.call<any>('POST', '/report-cards/send', staff, { ids: [n.body.id] })).body.sent).toBe(0);
    expect(JSON.stringify((await t.call('GET', `/me/dogs/${biscuit.id}`, dana)).body)).toContain('Loved the pool.');
  });
});

describe('friendly automatic texts', () => {
  it('asks for a review after pickup at most every 90 days', async () => {
    await t.call('PATCH', '/settings', mgr, { policies: { reviewRequests: { enabled: true, url: 'https://g.page/happy-tails/review' } } });
    expect((await t.call('PATCH', '/settings', mgr, { policies: { reviewRequests: { url: 'http://insecure' } } })).status).toBe(400);
    const visits = (await t.call<any>('GET', '/board', staff)).body.inBuilding;
    const biscuitVisit = visits.find((x: any) => x.dog.name === 'Biscuit').visit;
    const before = t.sms.sent.length;
    await t.call('POST', `/visits/${biscuitVisit.id}/checkout`, staff, { pay: { method: 'cash' } });
    const review = t.sms.sent.slice(before).filter((m) => m.body.includes('g.page'));
    expect(review).toHaveLength(1);
    expect(review[0]!.body).toMatch(/^Thanks for coming to Happy Tails Dog Daycare, Dana!/);
    const v2 = (await t.call<any>('POST', '/visits', staff, { dogId: (await dog('Biscuit')).id, service: 'daycare', plan: 'full' })).body;
    const mid = t.sms.sent.length;
    await t.call('POST', `/visits/${v2.id}/checkout`, staff, { pay: { method: 'cash' } });
    expect(t.sms.sent.slice(mid).some((m) => m.body.includes('g.page'))).toBe(false);
  });

  it('texts happy birthday once, in the morning', async () => {
    await t.call('PATCH', '/settings', mgr, { policies: { birthdayTexts: true } });
    const mochi = await dog('Mochi');
    await t.ctx.db.update(dogs).set({ birthDate: '2022-11-05' }).where(eq(dogs.id, mochi.id));
    t.clock.t = Date.parse('2026-11-05T12:00:00Z'); // 7 AM Eastern: too early
    await tick(t.ctx);
    expect(t.sms.sent.some((m) => m.body.includes('birthday, Mochi'))).toBe(false);
    t.clock.t = Date.parse('2026-11-05T15:00:00Z');
    await tick(t.ctx);
    await tick(t.ctx);
    const wishes = t.sms.sent.filter((m) => m.body.includes('birthday, Mochi'));
    expect(wishes).toHaveLength(1);
    expect(wishes[0]!.body).toBe('Happy 4th birthday, Mochi! 🎂 From all of us at Happy Tails Dog Daycare.');
  });
});
