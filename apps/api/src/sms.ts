/**
 * Texts to owners, through Twilio.
 *
 * Plain REST with fetch rather than Twilio's SDK: sending a message is one
 * form POST, and inbound replies are verified with Twilio's documented
 * HMAC-SHA1 signature, which is a dozen lines. The console sender stands in
 * until the business has a Twilio number; it records what would have gone.
 *
 * US carriers require A2P 10DLC registration for business texting from a
 * local number. That registration is done once in the Twilio console by the
 * account holder and is not something this code can do.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SmsSender {
  readonly mode: 'console' | 'twilio';
  send(to: string, body: string): Promise<{ id: string }>;
  /** True when an inbound webhook really came from the provider. */
  verifyInbound(url: string, params: Record<string, string>, signature: string | undefined): boolean;
}

/** US numbers to E.164: "(555) 300-1101" → "+15553001101". */
export function toE164(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (phone.trim().startsWith('+') && digits.length >= 8) return `+${digits}`;
  return null;
}

export class ConsoleSms implements SmsSender {
  readonly mode = 'console' as const;
  readonly sent: { to: string; body: string }[] = [];
  async send(to: string, body: string) {
    this.sent.push({ to, body });
    if (process.env.NODE_ENV !== 'test') console.log(`[sms → ${to}] ${body}`);
    return { id: `SM_console_${this.sent.length}` };
  }
  verifyInbound() {
    return true;
  }
}

export class TwilioSms implements SmsSender {
  readonly mode = 'twilio' as const;
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    /** A Twilio number in E.164, or a Messaging Service SID (MG…). */
    private readonly from: string,
  ) {}

  async send(to: string, body: string) {
    const form = new URLSearchParams({ To: to, Body: body });
    if (this.from.startsWith('MG')) form.set('MessagingServiceSid', this.from);
    else form.set('From', this.from);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const json = (await res.json()) as { sid?: string; message?: string };
    if (!res.ok || !json.sid) throw new Error(json.message ?? `Twilio answered ${res.status}`);
    return { id: json.sid };
  }

  /** https://www.twilio.com/docs/usage/security#validating-requests */
  verifyInbound(url: string, params: Record<string, string>, signature: string | undefined) {
    if (!signature) return false;
    const data = Object.keys(params)
      .sort()
      .reduce((s, k) => s + k + params[k], url);
    const want = Buffer.from(createHmac('sha1', this.authToken).update(data).digest('base64'));
    const got = Buffer.from(signature);
    return want.length === got.length && timingSafeEqual(want, got);
  }
}
