/**
 * Browser safety headers and brakes on guessing.
 *
 * Limits live in memory, per server: enough to stop a script hammering one
 * box. They count failures (or requests, for "forgot password"), never a
 * person signing in normally.
 */

import type { FastifyInstance } from 'fastify';

export class Brake {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  /** True while `key` has used up its allowance in the window. */
  blocked(key: string, now: number) {
    return this.recent(key, now).length >= this.max;
  }
  hit(key: string, now: number) {
    const list = this.recent(key, now);
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 20_000) this.hits.clear();
  }
  clear(key: string) {
    this.hits.delete(key);
  }
  private recent(key: string, now: number) {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }
}

/** 10 wrong passwords for one email from one address in 15 minutes, then wait. */
export const loginBrake = new Brake(10, 15 * 60_000);
/** 30 wrong passwords from one address across any emails in 15 minutes. */
export const loginIpBrake = new Brake(30, 15 * 60_000);
/** "Forgot password" emails: 3 per email per hour, 20 per address per hour. */
export const resetEmailBrake = new Brake(3, 60 * 60_000);
export const resetIpBrake = new Brake(20, 60 * 60_000);

/**
 * Headers for every response. The apps are served from the same box in the
 * one-server setup, so these also protect the websites: no framing by other
 * sites, no MIME sniffing, no referrer leaking pay-link tokens, and location
 * (live walks) and camera (photos) only for this site.
 */
export function registerSecurityHeaders(app: FastifyInstance) {
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('permissions-policy', 'geolocation=(self), camera=(self), microphone=(), payment=(self)');
    reply.header('cross-origin-opener-policy', 'same-origin-allow-popups');
    if (req.protocol === 'https') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  });
}
