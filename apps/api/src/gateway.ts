/**
 * Card payments: the port of MeDu's AZUL module onto Stripe.
 *
 * Same shape as MeDu: a narrow interface the rest of the API calls, a real
 * implementation, and a simulator that stands in until the business has
 * Stripe keys so every flow runs end to end in development and tests.
 *
 * Cards never touch Dawgs. The apps collect them with Stripe's own UI
 * (Payment Element on the web, PaymentSheet on iOS/Android) against a
 * SetupIntent, and Dawgs only stores the resulting PaymentMethod id plus the
 * brand and last four for display. That keeps the business at PCI SAQ-A.
 *
 * Monthly memberships are charged by Dawgs's own scheduler with off-session
 * PaymentIntents rather than Stripe Billing subscriptions: the retry rules
 * (every 3 days, cancel after 4) live in @dawgs/core where they are tested,
 * the receipt is a Dawgs invoice like every other sale, and there is no
 * Billing fee on top of card processing.
 */

import Stripe from 'stripe';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface CardDetails {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export type ChargeResult =
  | { ok: true; paymentIntentId: string; feeCents: number; card: CardDetails | null }
  | { ok: false; paymentIntentId: string | null; message: string; declineCode: string | null };

export interface GatewayEvent {
  id: string;
  type: string;
  /** The connected account (daycare) the event belongs to. */
  account?: string | null;
  /** For payment_intent.* events. */
  paymentIntentId?: string;
  amountCents?: number;
  metadata: Record<string, string>;
  paymentMethodId?: string | null;
}

export interface PaymentGateway {
  readonly mode: 'simulated' | 'test' | 'live';
  /** The publishable key the apps load Stripe.js / the RN SDK with. */
  readonly publishableKey: string | null;
  createCustomer(args: { name: string; email?: string | null; phone?: string | null; ownerId: string }): Promise<string>;
  /** Start adding a card; the app confirms it with Stripe's UI. */
  createSetupIntent(customerId: string): Promise<{ id: string; clientSecret: string }>;
  /** Look up a card the app just confirmed, to show brand and last four. */
  retrievePaymentMethod(paymentMethodId: string): Promise<CardDetails & { customerId: string | null }>;
  attachPaymentMethod(paymentMethodId: string, customerId: string): Promise<void>;
  detachPaymentMethod(paymentMethodId: string): Promise<void>;
  /** Charge a saved card with nobody at the keyboard (front desk, memberships). */
  chargeSavedCard(args: {
    customerId: string;
    paymentMethodId: string;
    amountCents: number;
    description: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<ChargeResult>;
  /** For pay links and checkout in the customer app: the payer enters or picks a card. */
  createPaymentIntent(args: {
    amountCents: number;
    customerId: string | null;
    description: string;
    metadata: Record<string, string>;
    saveCard: boolean;
  }): Promise<{ id: string; clientSecret: string }>;
  retrievePaymentIntent(id: string): Promise<{
    status: string;
    amountCents: number;
    feeCents: number;
    paymentMethodId: string | null;
    card: CardDetails | null;
    metadata: Record<string, string>;
  }>;
  refund(args: { paymentIntentId: string; amountCents: number }): Promise<{ id: string }>;
  /** Verify and parse a webhook. Throws when the signature is wrong. */
  parseWebhook(rawBody: string, signature: string | undefined): GatewayEvent;
}

// ─── Stripe ─────────────────────────────────────────────────────────────────

function cardOf(pm: Stripe.PaymentMethod | string | null | undefined): CardDetails | null {
  if (!pm || typeof pm === 'string' || !pm.card) return null;
  return { brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year };
}

function feeOf(charge: Stripe.Charge | string | null | undefined): number {
  if (!charge || typeof charge === 'string') return 0;
  const bt = charge.balance_transaction;
  return bt && typeof bt !== 'string' ? bt.fee : 0;
}

export class StripeGateway implements PaymentGateway {
  readonly mode: 'test' | 'live';
  private readonly stripe: Stripe;

  /** Every call is made on the daycare's connected account, never the platform's. */
  private readonly ro: Stripe.RequestOptions;

  constructor(
    stripe: Stripe,
    secretKey: string,
    readonly publishableKey: string | null,
    private readonly webhookSecret: string | null,
    readonly accountId: string,
  ) {
    this.stripe = stripe;
    this.mode = secretKey.startsWith('sk_live_') ? 'live' : 'test';
    this.ro = { stripeAccount: accountId };
  }

  async createCustomer(args: { name: string; email?: string | null; phone?: string | null; ownerId: string }) {
    const c = await this.stripe.customers.create({
      name: args.name,
      ...(args.email ? { email: args.email } : {}),
      ...(args.phone ? { phone: args.phone } : {}),
      metadata: { ownerId: args.ownerId },
    }, this.ro);
    return c.id;
  }

  async createSetupIntent(customerId: string) {
    const si = await this.stripe.setupIntents.create({
      customer: customerId,
      usage: 'off_session',
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    }, this.ro);
    return { id: si.id, clientSecret: si.client_secret! };
  }

  async retrievePaymentMethod(id: string) {
    const pm = await this.stripe.paymentMethods.retrieve(id, {}, this.ro);
    const card = cardOf(pm);
    if (!card) throw new Error('payment method is not a card');
    return { ...card, customerId: typeof pm.customer === 'string' ? pm.customer : (pm.customer?.id ?? null) };
  }

  async attachPaymentMethod(paymentMethodId: string, customerId: string) {
    await this.stripe.paymentMethods.attach(paymentMethodId, { customer: customerId }, this.ro);
  }

  async detachPaymentMethod(paymentMethodId: string) {
    await this.stripe.paymentMethods.detach(paymentMethodId, {}, this.ro);
  }

  async chargeSavedCard(args: {
    customerId: string;
    paymentMethodId: string;
    amountCents: number;
    description: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<ChargeResult> {
    try {
      const pi = await this.stripe.paymentIntents.create(
        {
          amount: args.amountCents,
          currency: 'usd',
          customer: args.customerId,
          payment_method: args.paymentMethodId,
          off_session: true,
          confirm: true,
          description: args.description,
          metadata: args.metadata,
          expand: ['latest_charge.balance_transaction', 'payment_method'],
        },
        { ...this.ro, idempotencyKey: args.idempotencyKey },
      );
      if (pi.status !== 'succeeded') {
        return { ok: false, paymentIntentId: pi.id, message: `payment ${pi.status}`, declineCode: null };
      }
      return { ok: true, paymentIntentId: pi.id, feeCents: feeOf(pi.latest_charge), card: cardOf(pi.payment_method) };
    } catch (e) {
      if (e instanceof Stripe.errors.StripeCardError) {
        return {
          ok: false,
          paymentIntentId: e.payment_intent?.id ?? null,
          message: e.message,
          declineCode: e.decline_code ?? e.code ?? null,
        };
      }
      throw e;
    }
  }

  async createPaymentIntent(args: {
    amountCents: number;
    customerId: string | null;
    description: string;
    metadata: Record<string, string>;
    saveCard: boolean;
  }) {
    const pi = await this.stripe.paymentIntents.create({
      amount: args.amountCents,
      currency: 'usd',
      ...(args.customerId ? { customer: args.customerId } : {}),
      ...(args.saveCard && args.customerId ? { setup_future_usage: 'off_session' as const } : {}),
      description: args.description,
      metadata: args.metadata,
      automatic_payment_methods: { enabled: true },
    }, this.ro);
    return { id: pi.id, clientSecret: pi.client_secret! };
  }

  async retrievePaymentIntent(id: string) {
    const pi = await this.stripe.paymentIntents.retrieve(id, {
      expand: ['latest_charge.balance_transaction', 'payment_method'],
    }, this.ro);
    return {
      status: pi.status,
      amountCents: pi.amount_received || pi.amount,
      feeCents: feeOf(pi.latest_charge),
      paymentMethodId: typeof pi.payment_method === 'string' ? pi.payment_method : (pi.payment_method?.id ?? null),
      card: cardOf(pi.payment_method),
      metadata: pi.metadata,
    };
  }

  async refund(args: { paymentIntentId: string; amountCents: number }) {
    const r = await this.stripe.refunds.create({ payment_intent: args.paymentIntentId, amount: args.amountCents }, this.ro);
    return { id: r.id };
  }

  /** Connect webhooks arrive at one platform endpoint; `account` says whose they are. */
  parseWebhook(rawBody: string, signature: string | undefined): GatewayEvent {
    if (!this.webhookSecret || !signature) throw new Error('webhook signature missing');
    const ev = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    const obj = ev.data.object as { id?: string; amount?: number; metadata?: Record<string, string>; payment_method?: unknown };
    return {
      id: ev.id,
      type: ev.type,
      account: ev.account ?? null,
      ...(ev.type.startsWith('payment_intent.') && obj.id ? { paymentIntentId: obj.id } : {}),
      ...(typeof obj.amount === 'number' ? { amountCents: obj.amount } : {}),
      metadata: obj.metadata ?? {},
      paymentMethodId: typeof obj.payment_method === 'string' ? obj.payment_method : null,
    };
  }
}

// ─── Simulator ──────────────────────────────────────────────────────────────

/**
 * Stripe's test payment-method names, so the apps and tests use the same
 * words in simulation as they will against Stripe's test mode.
 */
const SIM_CARDS: Record<string, CardDetails & { decline?: string }> = {
  pm_card_visa: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
  pm_card_mastercard: { brand: 'mastercard', last4: '4444', expMonth: 10, expYear: 2029 },
  pm_card_amex: { brand: 'amex', last4: '8431', expMonth: 6, expYear: 2031 },
  pm_card_discover: { brand: 'discover', last4: '1117', expMonth: 3, expYear: 2030 },
  pm_card_chargeDeclined: { brand: 'visa', last4: '0002', expMonth: 12, expYear: 2030, decline: 'generic_decline' },
  pm_card_chargeDeclinedInsufficientFunds: {
    brand: 'visa',
    last4: '9995',
    expMonth: 12,
    expYear: 2030,
    decline: 'insufficient_funds',
  },
};

export const SIM_WEBHOOK_SECRET = 'whsec_simulated';

/** Stripe's US standard pricing: 2.9% + 30¢. */
export function standardFee(amountCents: number): number {
  return Math.round(amountCents * 0.029) + 30;
}

export class SimulatedGateway implements PaymentGateway {
  readonly mode = 'simulated' as const;
  readonly publishableKey = null;
  /** Payment methods minted by "confirming" a setup intent in the simulator. */
  private readonly methods = new Map<string, { base: string; customerId: string | null }>();
  private readonly intents = new Map<
    string,
    { amountCents: number; status: string; metadata: Record<string, string>; pm: string | null }
  >();
  readonly refunds: { paymentIntentId: string; amountCents: number }[] = [];
  /** Idempotency: a retried request returns the first answer. */
  private readonly seen = new Map<string, ChargeResult>();

  async createCustomer() {
    return `cus_sim_${randomUUID().slice(0, 12)}`;
  }

  async createSetupIntent(customerId: string) {
    const id = `seti_sim_${randomUUID().slice(0, 12)}`;
    return { id, clientSecret: `${id}_secret_${customerId}` };
  }

  /**
   * What the apps call instead of Stripe's UI in simulation: turn a test
   * card name into a payment method attached to the customer.
   */
  simulateConfirmSetup(customerId: string, testCard: string): string {
    if (!SIM_CARDS[testCard]) throw new Error(`unknown test card ${testCard}`);
    const id = `pm_sim_${randomUUID().slice(0, 12)}`;
    this.methods.set(id, { base: testCard, customerId });
    return id;
  }

  private card(id: string) {
    const base = this.methods.get(id)?.base ?? id;
    const c = SIM_CARDS[base];
    if (!c) throw new Error(`no such payment method ${id}`);
    return c;
  }

  async retrievePaymentMethod(id: string) {
    const c = this.card(id);
    return {
      brand: c.brand,
      last4: c.last4,
      expMonth: c.expMonth,
      expYear: c.expYear,
      customerId: this.methods.get(id)?.customerId ?? null,
    };
  }

  async attachPaymentMethod(paymentMethodId: string, customerId: string) {
    const m = this.methods.get(paymentMethodId);
    this.methods.set(paymentMethodId, { base: m?.base ?? paymentMethodId, customerId });
  }

  async detachPaymentMethod(paymentMethodId: string) {
    this.methods.delete(paymentMethodId);
  }

  async chargeSavedCard(args: {
    paymentMethodId: string;
    amountCents: number;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<ChargeResult> {
    const prior = this.seen.get(args.idempotencyKey);
    if (prior) return prior;
    const c = this.card(args.paymentMethodId);
    const id = `pi_sim_${randomUUID().slice(0, 12)}`;
    const { decline, ...card } = c;
    const result: ChargeResult = decline
      ? {
          ok: false,
          paymentIntentId: id,
          message: decline === 'insufficient_funds' ? 'Your card has insufficient funds.' : 'Your card was declined.',
          declineCode: decline,
        }
      : { ok: true, paymentIntentId: id, feeCents: standardFee(args.amountCents), card };
    this.intents.set(id, {
      amountCents: args.amountCents,
      status: result.ok ? 'succeeded' : 'requires_payment_method',
      metadata: args.metadata,
      pm: args.paymentMethodId,
    });
    this.seen.set(args.idempotencyKey, result);
    return result;
  }

  async createPaymentIntent(args: { amountCents: number; metadata: Record<string, string> }) {
    const id = `pi_sim_${randomUUID().slice(0, 12)}`;
    this.intents.set(id, { amountCents: args.amountCents, status: 'requires_payment_method', metadata: args.metadata, pm: null });
    return { id, clientSecret: `${id}_secret_sim` };
  }

  /** The simulator's stand-in for the payer confirming on Stripe's page. */
  simulateConfirmPayment(paymentIntentId: string, testCard: string): GatewayEvent {
    const pi = this.intents.get(paymentIntentId);
    if (!pi) throw new Error('no such payment intent');
    const c = SIM_CARDS[testCard];
    if (!c) throw new Error(`unknown test card ${testCard}`);
    const pmId = `pm_sim_${randomUUID().slice(0, 12)}`;
    this.methods.set(pmId, { base: testCard, customerId: null });
    pi.pm = pmId;
    pi.status = c.decline ? 'requires_payment_method' : 'succeeded';
    return {
      id: `evt_sim_${randomUUID().slice(0, 12)}`,
      type: c.decline ? 'payment_intent.payment_failed' : 'payment_intent.succeeded',
      paymentIntentId,
      amountCents: pi.amountCents,
      metadata: pi.metadata,
      paymentMethodId: pmId,
    };
  }

  async retrievePaymentIntent(id: string) {
    const pi = this.intents.get(id);
    if (!pi) throw new Error('no such payment intent');
    const card = pi.pm ? (({ decline: _d, ...c }) => c)(this.card(pi.pm)) : null;
    return {
      status: pi.status,
      amountCents: pi.amountCents,
      feeCents: pi.status === 'succeeded' ? standardFee(pi.amountCents) : 0,
      paymentMethodId: pi.pm,
      card,
      metadata: pi.metadata,
    };
  }

  async refund(args: { paymentIntentId: string; amountCents: number }) {
    this.refunds.push(args);
    return { id: `re_sim_${randomUUID().slice(0, 12)}` };
  }

  /** Simulated webhooks are signed with HMAC-SHA256 of the body under SIM_WEBHOOK_SECRET. */
  static sign(rawBody: string): string {
    return createHmac('sha256', SIM_WEBHOOK_SECRET).update(rawBody).digest('hex');
  }

  parseWebhook(rawBody: string, signature: string | undefined): GatewayEvent {
    const want = Buffer.from(SimulatedGateway.sign(rawBody));
    const got = Buffer.from(signature ?? '');
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new Error('bad webhook signature');
    return JSON.parse(rawBody) as GatewayEvent;
  }
}
