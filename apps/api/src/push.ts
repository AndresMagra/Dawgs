/**
 * Push notifications to the apps through Expo's push service, which fronts
 * both APNs and FCM. Tokens are registered by the apps at sign-in.
 */

export interface PushSender {
  send(tokens: readonly string[], message: { title: string; body: string; data?: Record<string, string> }): Promise<void>;
}

export class ExpoPush implements PushSender {
  constructor(private readonly accessToken?: string) {}
  async send(tokens: readonly string[], message: { title: string; body: string; data?: Record<string, string> }) {
    if (tokens.length === 0) return;
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: JSON.stringify(tokens.map((to) => ({ to, sound: 'default', ...message }))),
    });
    if (!res.ok) console.warn(`expo push answered ${res.status}`);
  }
}

export class MemoryPush implements PushSender {
  readonly sent: { tokens: readonly string[]; title: string; body: string }[] = [];
  async send(tokens: readonly string[], message: { title: string; body: string }) {
    if (tokens.length) this.sent.push({ tokens, ...message });
  }
}
