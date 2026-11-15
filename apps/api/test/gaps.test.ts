import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';
import { tick } from '../src/scheduler.js';
import { signV4 } from '../src/storage.js';

type App = Awaited<ReturnType<typeof makeApp>>;

let t: App;
let mgr: string;
let staff: string;
let dana: string;
beforeAll(async () => {
  t = await makeApp(); // Wed 4 Nov 2026, 8 AM in New York
  mgr = await t.login('priya@happytails.test');
  staff = await t.login('marco@happytails.test');
  dana = await t.login('dana@example.com');
});
afterAll(async () => t.close());

const dog = async (name: string) => (await t.call<any[]>('GET', '/dogs', mgr)).body.find((d) => d.name === name)!;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('reminders', () => {
  it('texts the day before a confirmed booking, once, and not before 10 AM', async () => {
    const biscuit = await dog('Biscuit');
    const b = await t.call<any>('POST', '/bookings', staff, { dogId: biscuit.id, service: 'daycare', plan: 'full', date: '2026-11-05' });
    expect(b.body.status).toBe('confirmed');
    expect((await tick(t.ctx)).bookingReminders).toBe(0); // 8 AM
    t.clock.t = Date.parse('2026-11-04T16:00:00Z'); // 11 AM
    expect((await tick(t.ctx)).bookingReminders).toBeGreaterThan(0);
    expect(t.sms.sent.some((s) => /Biscuit is booked for daycare tomorrow, Thu, Nov 5/.test(s.body))).toBe(true);
    expect((await tick(t.ctx)).bookingReminders).toBe(0);
  });

  it('warns about a vaccine about to expire, unless a newer certificate is in', async () => {
    const biscuit = await dog('Biscuit');
    await t.call('POST', `/dogs/${biscuit.id}/vaccines`, staff, { name: 'Lyme', expiresOn: '2026-11-12' });
    const mochi = await dog('Mochi');
    await t.call('POST', `/dogs/${mochi.id}/vaccines`, staff, { name: 'Lyme', expiresOn: '2026-11-12' });
    await t.call('POST', `/dogs/${mochi.id}/vaccines`, staff, { name: 'Lyme', expiresOn: '2027-11-12' });
    await tick(t.ctx);
    expect(t.sms.sent.filter((s) => s.body.includes("Biscuit's Lyme vaccine expires Thu, Nov 12"))).toHaveLength(1);
    expect(t.sms.sent.some((s) => s.body.includes("Mochi's Lyme"))).toBe(false);
    await tick(t.ctx);
    expect(t.sms.sent.filter((s) => s.body.includes("Biscuit's Lyme vaccine"))).toHaveLength(1);
  });
});

describe('forgot password', () => {
  it('emails a one-use link, says the same for unknown emails, and signs out other devices', async () => {
    const before = t.mail.sent.length;
    expect((await t.call('POST', '/auth/forgot', null, { email: 'nobody@example.com' })).body).toEqual({ ok: true });
    expect(t.mail.sent.length).toBe(before);
    // Staff asking from the customer app get nothing; owners only from the customer app.
    await t.call('POST', '/auth/forgot', null, { email: 'marco@happytails.test', app: 'customer' });
    expect(t.mail.sent.length).toBe(before);
    expect((await t.call('POST', '/auth/forgot', null, { email: 'Dana@Example.com', app: 'customer' })).status).toBe(200);
    const mail = t.mail.sent.at(-1)!;
    expect(mail.to).toBe('dana@example.com');
    const token = /reset\?token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    expect(mail.text).toContain('https://app.dawgs.test/reset?token=');

    expect((await t.call('POST', '/auth/reset', null, { token, password: 'short' })).status).toBe(400);
    const r = await t.call<any>('POST', '/auth/reset', null, { token, password: 'a-brand-new-password' });
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe('dana@example.com');
    expect((await t.call('GET', '/auth/me', dana)).status).toBe(401); // the old session is gone
    expect((await t.call('POST', '/auth/reset', null, { token, password: 'another-password-1' })).status).toBe(400);
    expect((await t.call('POST', '/auth/login', null, { email: 'dana@example.com', password: 'a-brand-new-password' })).status).toBe(200);
    dana = r.body.token;

    // Staff reset links point at the staff site.
    await t.call('POST', '/auth/forgot', null, { email: 'marco@happytails.test', app: 'staff' });
    expect(t.mail.sent.at(-1)!.text).toContain('https://app.dawgs.test/staff/reset?token=');
  });

  it('expires links after an hour', async () => {
    await t.call('POST', '/auth/forgot', null, { email: 'sam@example.com' });
    const token = /reset\?token=([A-Za-z0-9_-]+)/.exec(t.mail.sent.at(-1)!.text)![1]!;
    t.clock.t += 61 * 60_000;
    expect((await t.call('POST', '/auth/reset', null, { token, password: 'sams-new-password' })).status).toBe(400);
  });
});

describe('sign-in brake and headers', () => {
  it('slows down password guessing for one email', async () => {
    for (let i = 0; i < 10; i++) expect((await t.call('POST', '/auth/login', null, { email: 'alex@example.com', password: `guess-${i}` })).status).toBe(401);
    const r = await t.call<any>('POST', '/auth/login', null, { email: 'alex@example.com', password: 'dawgs-demo-2026' });
    expect(r.status).toBe(429);
    t.clock.t += 16 * 60_000;
    expect((await t.call('POST', '/auth/login', null, { email: 'alex@example.com', password: 'dawgs-demo-2026' })).status).toBe(200);
  });

  it('sends safety headers', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});

describe('new-dog evaluations', () => {
  it('keeps owners from booking a new dog until staff mark it passed', async () => {
    await t.call('PATCH', '/settings', mgr, { policies: { requireEvaluation: true } });
    const pup = await t.call<any>('POST', '/me/dogs', dana, { name: 'Pickle', breed: 'Corgi' });
    expect(pup.body.evaluation).toBe('pending');
    // Dogs already on file are unaffected.
    const biscuit = await dog('Biscuit');
    expect(biscuit.evaluation).toBe('passed');
    // Owners can't make Pickle pass themselves.
    expect((await t.call<any>('PATCH', `/me/dogs/${pup.body.id}`, dana, { evaluation: 'passed' })).body.evaluation).toBe('pending');
    await t.call('POST', `/dogs/${pup.body.id}/vaccines`, staff, { name: 'Rabies', expiresOn: '2027-06-01' });
    await t.call('POST', `/dogs/${pup.body.id}/vaccines`, staff, { name: 'DHPP', expiresOn: '2027-06-01' });
    await t.call('POST', `/dogs/${pup.body.id}/vaccines`, staff, { name: 'Bordetella', expiresOn: '2027-06-01' });
    const tryBook = () => t.call<any>('POST', '/me/bookings', dana, { dogId: pup.body.id, service: 'daycare', plan: 'full', date: '2026-11-20' });
    const refused = await tryBook();
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/Pickle needs a temperament evaluation/);
    expect((await t.call<any>('PATCH', `/dogs/${pup.body.id}`, staff, { evaluation: 'passed', evaluationNote: 'Played well with the small group' })).body.evaluation).toBe('passed');
    const ok = await tryBook();
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await t.call('PATCH', '/settings', mgr, { policies: { requireEvaluation: false } });
  });
});

describe('photos and documents', () => {
  it('stores uploads outside the record and serves them by an unguessable link', async () => {
    const up = await t.call<any>('POST', '/uploads', dana, { dataUrl: PNG });
    expect(up.status).toBe(200);
    expect(up.body.url).toMatch(/^https:\/\/api\.dawgs\.test\/files\/[A-Za-z0-9_-]{40,}\.png$/);
    const res = await t.app.inject({ method: 'GET', url: new URL(up.body.url).pathname });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    expect((await t.app.inject({ method: 'GET', url: '/files/guess.png' })).statusCode).toBe(404);
    expect((await t.call('POST', '/uploads', null, { dataUrl: PNG })).status).toBe(401);
    expect((await t.call('POST', '/uploads', dana, { dataUrl: 'data:text/html;base64,PGgxPg==' })).status).toBe(400);
  });

  it('turns a vaccine photo sent inline into a link', async () => {
    const biscuit = await dog('Biscuit');
    const v = await t.call<any>('POST', `/me/dogs/${biscuit.id}/vaccines`, dana, { name: 'Rabies', expiresOn: '2029-01-01', documentUrl: PNG });
    expect(v.body.documentUrl).toMatch(/^https:\/\/api\.dawgs\.test\/files\//);
  });

  it('signs S3 requests the way AWS documents', () => {
    const h = signV4({
      method: 'PUT',
      url: new URL('https://acct.r2.cloudflarestorage.com/dawgs/abc.png'),
      body: Buffer.from('hi'),
      contentType: 'image/png',
      region: 'auto',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      now: new Date('2026-11-04T13:00:00Z'),
    });
    expect(h['x-amz-date']).toBe('20261104T130000Z');
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/20261104\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });
});

describe('client import', () => {
  const csv = [
    'Owner First Name,Owner Last Name,Email,Cell Phone,Pet Name,Breed,Sex,Birthday,Rabies Expiration,Bordetella Exp,DHPP Exp',
    'Dana,Whitfield,dana@example.com,(555) 201-4410,Biscuit,Golden Retriever,F,,,,',
    'Dana,Whitfield,dana@example.com,,Noodle,Dachshund,M,6/1/2022,6/1/2027,6/1/2027,6/1/2027',
    'Jamie,Ortiz,jamie@example.com,555-777-1212,Rocket,Border Collie,M,1/15/2020,3/3/2027,3/3/2027,3/3/2027',
    'Jamie,Ortiz,,555.777.1212,Comet,Border Collie,F,,,,',
  ].join('\n');

  it('previews without writing, then imports, matching people already on file', async () => {
    expect((await t.call('POST', '/import/clients', staff, { csv })).status).toBe(403);
    const dry = await t.call<any>('POST', '/import/clients', mgr, { csv });
    expect(dry.body).toMatchObject({ dryRun: true, ownersNew: 1, ownersMatched: 1, dogsNew: 3, dogsSkipped: 1, vaccines: 6 });
    expect(dry.body.columns.vaccines).toEqual(['Rabies', 'Bordetella', 'DHPP']);
    expect((await t.call<any[]>('GET', '/dogs', mgr)).body.some((d) => d.name === 'Rocket')).toBe(false);

    const real = await t.call<any>('POST', '/import/clients', mgr, { csv, dryRun: false });
    expect(real.body).toMatchObject({ dryRun: false, ownersNew: 1, dogsNew: 3 });
    const rocket = await dog('Rocket');
    expect(rocket.owner.name).toBe('Jamie Ortiz');
    expect(rocket.canEnter === true || rocket.waiversMissing.length > 0).toBe(true);
    expect(rocket.vaccineState).not.toBe('missing');
    expect((await dog('Comet')).owner.id).toBe(rocket.owner.id);
    expect((await dog('Noodle')).owner.name).toBe('Dana Whitfield');

    // Running the same file again adds nothing.
    const again = await t.call<any>('POST', '/import/clients', mgr, { csv, dryRun: false });
    expect(again.body).toMatchObject({ ownersNew: 0, dogsNew: 0, dogsSkipped: 4 });
  });
});
