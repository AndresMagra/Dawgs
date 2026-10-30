/**
 * Everything a route needs, passed in, so the whole API runs in tests against
 * in-process Postgres with the Stripe and Twilio simulators and a clock the
 * test controls.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '@dawgs/db';
import type { PaymentGateway } from './gateway.js';
import type { SmsSender } from './sms.js';
import type { PushSender } from './push.js';
import type { Mailer } from './mail.js';
import type { StripeConnect } from './tenants.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, '../../../packages/db/migrations');

export interface AppContext {
  readonly db: Database;
  /**
   * The daycare's own Stripe account (through Connect) or the simulator.
   * Throws a clear error when a daycare has not connected Stripe yet.
   */
  gatewayFor(businessId: string): Promise<PaymentGateway>;
  /** Parses Stripe webhooks for every connected daycare at one endpoint. */
  readonly webhookGateway: PaymentGateway;
  /** The daycare's own Twilio number, or the console sender when none is set. */
  smsFor(businessId: string): Promise<SmsSender>;
  /** Stripe Connect onboarding; null when the platform has no Stripe keys (simulation). */
  readonly connect: StripeConnect | null;
  /** Deployment secret for encrypting per-daycare credentials at rest. */
  readonly secret: string | null;
  readonly push: PushSender;
  /** Invoices, receipts and reminders by email. */
  readonly mail: Mailer;
  /** Epoch ms. Tests move it; production is Date.now. */
  now(): number;
  /** Where the customer web app lives, for pay links in texts. */
  readonly publicUrl: string | null;
  /** Anyone may create an owner account from the customer app. */
  readonly ownerSignupOpen: boolean;
  /** New daycares may sign up for a trial from the website. */
  readonly daycareSignupOpen: boolean;
}
