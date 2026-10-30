import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { businesses } from '@dawgs/db';
import { makeApp } from './helpers.js';
import { tick } from '../src/scheduler.js';

type App = Awaited<ReturnType<typeof makeApp>>;

let t: App;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => t.close());

describe('leads', () => {
  it('takes an inquiry from the website, tells the manager, and thanks the person', async () => {
    const mgr = await t.login('priya@happytails.test');
    await t.call('POST', '/auth/push-token', mgr, { token: 'ExponentPushToken[priya]', platform: 'ios' });
    const pushes = t.push.sent.length;
    const r = await t.call('POST', '/public/daycares/happy-tails/inquiry', null, {
      name: 'Casey Lin',
      email: 'Casey@Example.com',
      phone: '(555) 777-1234',
      dogName: 'Pepper',
      dogBreed: 'Beagle',
      interest: ['daycare', 'boarding'],
      message: 'Do you have space on Fridays?',
    });
    expect(r.status).toBe(200);
    expect(t.push.sent.length).toBe(pushes + 1);
    expect(t.push.sent.at(-1)!.body).toContain('Casey Lin (Pepper)');
    const thanks = t.mail.sent.at(-1)!;
    expect(thanks.to).toBe('casey@example.com');
    expect(thanks.subject).toContain('Happy Tails');

    const list = (await t.call<any>('GET', '/leads', mgr)).body;
    const lead = list.leads.find((l: any) => l.name === 'Casey Lin');
    expect(lead).toMatchObject({ stage: 'new', source: 'website', email: 'casey@example.com', interest: ['daycare', 'boarding'] });
    const detail = (await t.call<any>('GET', `/leads/${lead.id}`, mgr)).body;
    expect(detail.activity[0].body).toContain('Fridays');

    // Bots that fill the hidden field get a polite nothing.
    const before = list.leads.length;
    await t.call('POST', '/public/daycares/happy-tails/inquiry', null, { name: 'Bot', email: 'b@x.com', website: 'http://spam' });
    expect((await t.call<any>('GET', '/leads', mgr)).body.leads.length).toBe(before);
    // No way to reach them, no lead.
    expect((await t.call('POST', '/public/daycares/happy-tails/inquiry', null, { name: 'Nobody' })).status).toBe(400);
    expect((await t.call('POST', '/public/daycares/nope/inquiry', null, { name: 'X', email: 'x@x.com' })).status).toBe(404);
  });

  it('works a lead: text, call, tour, follow-up reminder, then convert to a client with their dog', async () => {
    const mgr = await t.login('priya@happytails.test');
    const staff = await t.login('marco@happytails.test');
    const created = await t.call<any>('POST', '/leads', staff, { name: 'Morgan Ruiz', phone: '555-888-2020', dogName: 'Tank', source: 'phone' });
    expect(created.status).toBe(200);
    const id = created.body.id;

    const text = await t.call('POST', `/leads/${id}/message`, staff, { channel: 'sms', body: 'Hi Morgan! Want to book a tour?' });
    expect(text.status).toBe(200);
    expect(t.sms.sent.at(-1)).toMatchObject({ to: '+15558882020' });
    let lead = (await t.call<any>('GET', `/leads/${id}`, mgr)).body.lead;
    expect(lead.stage).toBe('contacted');
    // No email on file.
    expect((await t.call('POST', `/leads/${id}/message`, staff, { channel: 'email', body: 'hi' })).status).toBe(400);

    await t.call('POST', `/leads/${id}/activities`, staff, { kind: 'call', body: 'Booked a tour Thursday 10am' });
    const followUpOn = '2026-11-06';
    const moved = await t.call<any>('PATCH', `/leads/${id}`, staff, { stage: 'tour', followUpOn });
    expect(moved.body.stage).toBe('tour');
    // Won only comes through converting.
    expect((await t.call('PATCH', `/leads/${id}`, staff, { stage: 'won' })).status).toBe(400);

    // Follow-up push: not before the day, once on the day.
    await t.call('POST', '/auth/push-token', mgr, { token: 'ExponentPushToken[priya2]', platform: 'ios' });
    const p0 = t.push.sent.filter((p) => p.title === 'Follow up today').length;
    await tick(t.ctx);
    expect(t.push.sent.filter((p) => p.title === 'Follow up today').length).toBe(p0);
    t.clock.t = Date.parse('2026-11-06T14:00:00Z');
    await tick(t.ctx);
    await tick(t.ctx);
    const fu = t.push.sent.filter((p) => p.title === 'Follow up today');
    expect(fu.length).toBe(p0 + 1);
    expect(fu.at(-1)!.body).toContain('Morgan Ruiz');

    const conv = await t.call<any>('POST', `/leads/${id}/convert`, staff);
    expect(conv.status).toBe(200);
    const owner = (await t.call<any>('GET', `/owners/${conv.body.ownerId}`, mgr)).body;
    expect(owner.name ?? owner.owner?.name).toBe('Morgan Ruiz');
    expect(JSON.stringify(owner)).toContain('Tank');
    lead = (await t.call<any>('GET', `/leads/${id}`, mgr)).body.lead;
    expect(lead).toMatchObject({ stage: 'won', followUpOn: null, ownerId: conv.body.ownerId });
    expect((await t.call('POST', `/leads/${id}/convert`, staff)).status).toBe(400);
    // Closed leads leave the default list.
    expect((await t.call<any>('GET', '/leads', mgr)).body.leads.some((l: any) => l.id === id)).toBe(false);
    expect((await t.call<any>('GET', '/leads?all=1', mgr)).body.leads.some((l: any) => l.id === id)).toBe(true);
  });

  it('respects STOP from a lead and puts replies on the timeline', async () => {
    const mgr = await t.login('priya@happytails.test');
    const [b] = await t.ctx.db.select().from(businesses).where(eq(businesses.slug, 'happy-tails'));
    await t.ctx.db.update(businesses).set({ twilioFrom: '+15550001111' }).where(eq(businesses.id, b!.id));
    const id = (await t.call<any>('POST', '/leads', mgr, { name: 'Jamie Fox', phone: '5553334444' })).body.id;
    const inbound = (body: string) =>
      t.app.inject({
        method: 'POST',
        url: '/webhooks/twilio',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `From=%2B15553334444&To=%2B15550001111&Body=${encodeURIComponent(body)}`,
      });
    expect((await inbound('Is there a waitlist?')).statusCode).toBe(200);
    const detail = (await t.call<any>('GET', `/leads/${id}`, mgr)).body;
    expect(detail.activity.some((a: any) => a.body === 'Reply: Is there a waitlist?')).toBe(true);
    await inbound('STOP');
    expect((await t.call('POST', `/leads/${id}/message`, mgr, { channel: 'sms', body: 'Hello?' })).status).toBe(400);
    await inbound('START');
    expect((await t.call('POST', `/leads/${id}/message`, mgr, { channel: 'sms', body: 'Welcome back' })).status).toBe(200);
  });

  it('keeps each daycare to its own leads', async () => {
    const other = await t.call<any>('POST', '/public/daycares', null, { name: 'Bark Park', managerName: 'Ola', managerEmail: 'ola@barkpark.test', managerPassword: 'bark-park-2026!' });
    expect(other.status).toBe(200);
    const theirs = other.body.token as string;
    const mgr = await t.login('priya@happytails.test');
    const mine = (await t.call<any>('GET', '/leads', mgr)).body.leads[0];
    expect((await t.call<any>('GET', '/leads', theirs)).body.leads).toHaveLength(0);
    expect((await t.call('GET', `/leads/${mine.id}`, theirs)).status).toBe(404);
    expect((await t.call('PATCH', `/leads/${mine.id}`, theirs, { stage: 'lost' })).status).toBe(404);
    expect((await t.call('POST', `/leads/${mine.id}/convert`, theirs)).status).toBe(404);
    const owner = await t.login('dana@example.com');
    expect((await t.call('GET', '/leads', owner)).status).toBe(403);
  });
});
