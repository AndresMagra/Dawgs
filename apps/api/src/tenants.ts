/**
 * Daycares as tenants: their own Stripe (through Connect) and their own Twilio.
 *
 * Dawgs is sold to many daycares. Card money must land in each daycare's own
 * Stripe account, so the platform holds one Stripe "platform" account and each
 * daycare connects theirs with Stripe's OAuth (Connect Standard): they sign in
 * to Stripe, Stripe hands back their account id, and every charge is made on
 * that account. Dawgs never sees their Stripe password or secret key.
 *
 * Texts work the other way round: a daycare pastes its own Twilio account SID,
 * auth token and number in Settings, and the token is stored encrypted.
 */

import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { DawgsError, ValidationError } from '@dawgs/core';
import { businesses, type Database } from '@dawgs/db';
import { SimulatedGateway, StripeGateway, type PaymentGateway } from './gateway.js';
import { ConsoleSms, TwilioSms, type SmsSender } from './sms.js';
import { decryptSecret, encryptSecret } from './crypto.js';

export class NotConnectedError extends DawgsError {
  constructor() {
    super('STRIPE_NOT_CONNECTED', 'this daycare has not connected Stripe yet (Settings → Payments)');
  }
}

export interface StripePlatformConfig {
  secretKey: string;
  publishableKey: string | null;
  webhookSecret: string | null;
  /** The platform's Connect client id (ca_…), for the OAuth link. */
  connectClientId: string | null;
}

export class StripeConnect {
  readonly stripe: Stripe;
  constructor(readonly config: StripePlatformConfig) {
    this.stripe = new Stripe(config.secretKey);
  }

  /** Where a manager is sent to connect their Stripe account. `state` comes back on return. */
  authorizeUrl(state: string, redirectUri: string): string {
    if (!this.config.connectClientId) throw new ValidationError('Stripe Connect is not configured on this server');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.connectClientId,
      scope: 'read_write',
      state,
      redirect_uri: redirectUri,
    });
    return `https://connect.stripe.com/oauth/authorize?${q}`;
  }

  async finish(code: string): Promise<string> {
    const r = await this.stripe.oauth.token({ grant_type: 'authorization_code', code });
    if (!r.stripe_user_id) throw new ValidationError('Stripe did not return an account');
    return r.stripe_user_id;
  }

  async disconnect(accountId: string) {
    if (!this.config.connectClientId) return;
    await this.stripe.oauth.deauthorize({ client_id: this.config.connectClientId, stripe_user_id: accountId });
  }

  gateway(accountId: string): PaymentGateway {
    return new StripeGateway(
      this.stripe,
      this.config.secretKey,
      this.config.publishableKey,
      this.config.webhookSecret,
      accountId,
    );
  }

  /** Parses webhooks for all connected accounts; the event carries `account`. */
  webhookParser(): PaymentGateway {
    return new StripeGateway(this.stripe, this.config.secretKey, this.config.publishableKey, this.config.webhookSecret, '');
  }
}

/**
 * Build the per-daycare lookups the context exposes.
 *
 * With no platform Stripe keys the whole deployment runs on the simulator —
 * that is development, tests and demos. With keys, a daycare that has not
 * connected gets a clear error instead of a charge on the wrong account.
 */
export function tenantProviders(args: {
  db: Database;
  connect: StripeConnect | null;
  simulator: SimulatedGateway;
  consoleSms: SmsSender;
  secret: string | null;
}) {
  async function load(businessId: string) {
    const [b] = await args.db.select().from(businesses).where(eq(businesses.id, businessId));
    if (!b) throw new DawgsError('NOT_FOUND', 'business not found');
    return b;
  }
  return {
    async gatewayFor(businessId: string): Promise<PaymentGateway> {
      if (!args.connect) return args.simulator;
      const b = await load(businessId);
      if (!b.stripeAccountId) throw new NotConnectedError();
      return args.connect.gateway(b.stripeAccountId);
    },
    async smsFor(businessId: string): Promise<SmsSender> {
      const b = await load(businessId);
      if (b.twilioAccountSid && b.twilioAuthTokenEnc && b.twilioFrom && args.secret) {
        return new TwilioSms(b.twilioAccountSid, decryptSecret(b.twilioAuthTokenEnc, args.secret), b.twilioFrom);
      }
      return args.consoleSms;
    },
    webhookGateway: args.connect ? args.connect.webhookParser() : args.simulator,
  };
}

export async function saveTwilio(
  db: Database,
  secret: string | null,
  businessId: string,
  input: { accountSid: string; authToken: string; from: string } | null,
) {
  if (!input) {
    await db
      .update(businesses)
      .set({ twilioAccountSid: null, twilioAuthTokenEnc: null, twilioFrom: null })
      .where(eq(businesses.id, businessId));
    return;
  }
  if (!secret) throw new ValidationError('the server has no DAWGS_SECRET, so it cannot store Twilio keys safely');
  if (!/^AC[0-9a-f]{32}$/i.test(input.accountSid)) throw new ValidationError('Twilio account SID starts with AC');
  if (!/^(\+\d{8,15}|MG[0-9a-f]{32})$/i.test(input.from))
    throw new ValidationError('the sending number must be in +1… form, or a Messaging Service SID');
  await db
    .update(businesses)
    .set({
      twilioAccountSid: input.accountSid,
      twilioAuthTokenEnc: encryptSecret(input.authToken, secret),
      twilioFrom: input.from,
    })
    .where(eq(businesses.id, businessId));
}
