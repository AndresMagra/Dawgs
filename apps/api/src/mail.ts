/**
 * Email. Dawgs sends from one platform address (with the daycare's name as the
 * sender name and its own email as reply-to), so a daycare doesn't need to set
 * up a mail service; owners' replies still go straight to the daycare.
 */

export interface Email {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName: string;
  replyTo?: string | null;
}

export interface Mailer {
  readonly mode: 'console' | 'resend';
  send(e: Email): Promise<{ id: string }>;
}

/** Keeps what it would have sent: development, tests, and servers with no mail key. */
export class ConsoleMail implements Mailer {
  readonly mode = 'console' as const;
  readonly sent: Email[] = [];
  async send(e: Email) {
    this.sent.push(e);
    if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) console.log(`[mail] to ${e.to}: ${e.subject}`);
    return { id: `console_${this.sent.length}` };
  }
}

/** Resend's REST API; one key and one verified sending domain for the whole platform. */
export class ResendMail implements Mailer {
  readonly mode = 'resend' as const;
  constructor(
    private readonly apiKey: string,
    private readonly fromAddress: string,
  ) {}
  async send(e: Email) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        // A quoted display name keeps commas and other punctuation in a daycare's name legal.
        from: `"${e.fromName.replace(/["\\\r\n]/g, '')}" <${this.fromAddress}>`,
        to: [e.to],
        subject: e.subject,
        html: e.html,
        text: e.text,
        ...(e.replyTo ? { reply_to: e.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok || !body.id) throw new Error(body.message ?? `email provider answered ${res.status}`);
    return { id: body.id };
  }
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const looksLikeEmail = (s: string | null | undefined): s is string => !!s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
