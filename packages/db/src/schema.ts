/**
 * The Dawgs schema.
 *
 * Every business-owned row carries `businessId`, and the API checks it on
 * every read and write (see apps/api/src/auth.ts). One daycare runs on it
 * today; the column is what lets a second one sign up without a migration.
 *
 * Money is integer cents. Times are timestamptz. Calendar days that are
 * local to the business (a boarding arrival date, a daycare booking date) are
 * `date` columns holding the LOCAL date, never an instant.
 */

import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { BillLine, HoursPolicy, PriceList, Wallet } from '@dawgs/core';

const id = () => uuid('id').primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const created = () => ts('created_at').notNull().defaultNow();
const biz = () =>
  uuid('business_id')
    .notNull()
    .references(() => businesses.id);

export const businesses = pgTable('businesses', {
  id: id(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('America/New_York'),
  phone: text('phone'),
  email: text('email'),
  address: text('address'),
  prices: jsonb('prices').$type<PriceList>().notNull(),
  hours: jsonb('hours').$type<HoursPolicy>().notNull(),
  daycareCapacity: integer('daycare_capacity').notNull().default(30),
  requiredVaccines: jsonb('required_vaccines').$type<string[]>().notNull(),
  /** Days without a visit before a regular shows on the manager's reminder list. */
  inactiveAfterDays: integer('inactive_after_days').notNull().default(21),
  pickupTextsEnabled: boolean('pickup_texts_enabled').notNull().default(true),
  /** Email and text owners when an invoice with a due date goes unpaid. */
  invoiceRemindersEnabled: boolean('invoice_reminders_enabled').notNull().default(true),
  /** Short name used in the customer app's address and sign-up link. */
  slug: text('slug').notNull().unique(),
  logoUrl: text('logo_url'),
  brandColor: text('brand_color').notNull().default('#2f6f4f'),
  /** `free` for comped daycares (the first one); paying daycares are on `standard`. */
  plan: text('plan').$type<'free' | 'trial' | 'standard' | 'lapsed'>().notNull().default('trial'),
  trialEndsAt: ts('trial_ends_at'),
  /** The daycare's own Stripe account, connected through Stripe Connect. */
  stripeAccountId: text('stripe_account_id'),
  /** The daycare's own Twilio account. The token is AES-GCM encrypted under DAWGS_SECRET. */
  twilioAccountSid: text('twilio_account_sid'),
  twilioAuthTokenEnc: text('twilio_auth_token_enc'),
  twilioFrom: text('twilio_from'),
  createdAt: created(),
});

/** Staff, managers and pet owners all sign in as users; `role` decides what they see. */
export const users = pgTable(
  'users',
  {
    id: id(),
    businessId: biz(),
    role: text('role').$type<'manager' | 'staff' | 'owner'>().notNull(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    passwordHash: text('password_hash').notNull(),
    /** For role `owner`: the owner record this login belongs to. */
    ownerId: uuid('owner_id'),
    jobTitle: text('job_title'),
    payRateCents: integer('pay_rate_cents'),
    hiredOn: date('hired_on'),
    ptoHours: real('pto_hours').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: created(),
  },
  (t) => [uniqueIndex('users_email').on(t.businessId, t.email)],
);

export const sessions = pgTable('sessions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: created(),
});

export const pushTokens = pgTable('push_tokens', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  platform: text('platform').notNull(),
  createdAt: created(),
});

export const owners = pgTable(
  'owners',
  {
    id: id(),
    businessId: biz(),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    address: text('address'),
    emergencyName: text('emergency_name'),
    emergencyPhone: text('emergency_phone'),
    vetName: text('vet_name'),
    vetPhone: text('vet_phone'),
    smsOptIn: boolean('sms_opt_in').notNull().default(true),
    stripeCustomerId: text('stripe_customer_id'),
    notes: text('notes'),
    createdAt: created(),
  },
  (t) => [index('owners_business').on(t.businessId)],
);

/**
 * People an owner allows to collect their dogs: a partner, a dog walker, a
 * grandparent. A co-owner with an email can also sign in to the customer app
 * on the same account. Staff check the list at pickup and record who came.
 */
export const authorizedPeople = pgTable(
  'authorized_people',
  {
    id: id(),
    businessId: biz(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    name: text('name').notNull(),
    relation: text('relation'),
    phone: text('phone'),
    email: text('email'),
    photoUrl: text('photo_url'),
    /** May sign in to the customer app and manage the account like the owner. */
    coOwner: boolean('co_owner').notNull().default(false),
    notes: text('notes'),
    active: boolean('active').notNull().default(true),
    addedBy: text('added_by').notNull(),
    createdAt: created(),
  },
  (t) => [index('authorized_people_owner').on(t.ownerId)],
);

export const paymentMethods = pgTable('payment_methods', {
  id: id(),
  businessId: biz(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => owners.id, { onDelete: 'cascade' }),
  stripePaymentMethodId: text('stripe_payment_method_id').notNull(),
  brand: text('brand').notNull(),
  last4: text('last4').notNull(),
  expMonth: integer('exp_month').notNull(),
  expYear: integer('exp_year').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: created(),
});

export interface Behaviour {
  escapeRisk?: boolean;
  leashReactive?: boolean;
  eatsAlone?: boolean;
  notes?: string;
}

export const dogs = pgTable(
  'dogs',
  {
    id: id(),
    businessId: biz(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    name: text('name').notNull(),
    breed: text('breed'),
    sex: text('sex').$type<'male' | 'female'>(),
    fixed: boolean('fixed'),
    birthDate: date('birth_date'),
    weightLb: real('weight_lb'),
    color: text('color'),
    photoUrl: text('photo_url'),
    feeding: text('feeding'),
    behaviour: jsonb('behaviour').$type<Behaviour>().notNull().default({}),
    allergies: jsonb('allergies').$type<string[]>().notNull().default([]),
    medications: jsonb('medications').$type<{ name: string; dose: string; when: string }[]>().notNull().default([]),
    defaultYardId: uuid('default_yard_id'),
    active: boolean('active').notNull().default(true),
    createdAt: created(),
  },
  (t) => [index('dogs_owner').on(t.ownerId), index('dogs_business').on(t.businessId)],
);

export const vaccines = pgTable('vaccines', {
  id: id(),
  businessId: biz(),
  dogId: uuid('dog_id')
    .notNull()
    .references(() => dogs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  expiresAt: ts('expires_at').notNull(),
  documentUrl: text('document_url'),
  /** Null until staff have looked at the certificate an owner uploaded. */
  verifiedBy: text('verified_by'),
  createdAt: created(),
});

export const yards = pgTable('yards', {
  id: id(),
  businessId: biz(),
  name: text('name').notNull(),
  capacity: integer('capacity').notNull(),
  maxWeightLb: real('max_weight_lb'),
  note: text('note'),
  sort: integer('sort').notNull().default(0),
});

export const kennels = pgTable('kennels', {
  id: id(),
  businessId: biz(),
  name: text('name').notNull(),
  type: text('type').$type<'suite' | 'run'>().notNull(),
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
});

export type BookingStatus =
  | 'requested'
  | 'confirmed'
  | 'waitlist'
  | 'checked_in'
  | 'checked_out'
  | 'cancelled'
  | 'declined'
  | 'no_show';

/**
 * A plan to come in. Daycare uses `date`; boarding uses `arrive`/`depart`.
 * Owners create bookings as `requested`; staff confirm or decline.
 */
export const bookings = pgTable(
  'bookings',
  {
    id: id(),
    businessId: biz(),
    dogId: uuid('dog_id')
      .notNull()
      .references(() => dogs.id),
    service: text('service').$type<'daycare' | 'boarding'>().notNull(),
    plan: text('plan').$type<'half' | 'full' | 'hourly'>(),
    date: date('date'),
    arrive: date('arrive'),
    depart: date('depart'),
    kennelId: uuid('kennel_id').references(() => kennels.id),
    play: boolean('play').notNull().default(false),
    status: text('status').$type<BookingStatus>().notNull(),
    /** Local `HH:MM` the owner plans to pick up; drives the pickup text. */
    pickupTime: text('pickup_time'),
    source: text('source').$type<'staff' | 'owner'>().notNull(),
    notes: text('notes'),
    estimateCents: integer('estimate_cents'),
    createdAt: created(),
  },
  (t) => [index('bookings_date').on(t.businessId, t.date), index('bookings_stay').on(t.businessId, t.arrive)],
);

/** A dog physically in the building, from check-in to check-out. */
export const visits = pgTable(
  'visits',
  {
    id: id(),
    businessId: biz(),
    bookingId: uuid('booking_id').references(() => bookings.id),
    dogId: uuid('dog_id')
      .notNull()
      .references(() => dogs.id),
    service: text('service').$type<'daycare' | 'boarding'>().notNull(),
    plan: text('plan').$type<'half' | 'full' | 'hourly'>(),
    kennelId: uuid('kennel_id').references(() => kennels.id),
    departDate: date('depart_date'),
    play: boolean('play').notNull().default(false),
    yardId: uuid('yard_id').references(() => yards.id),
    checkedInAt: ts('checked_in_at').notNull(),
    checkedInBy: text('checked_in_by').notNull(),
    plannedPickupAt: ts('planned_pickup_at'),
    pickupTextSentAt: ts('pickup_text_sent_at'),
    checkedOutAt: ts('checked_out_at'),
    checkedOutBy: text('checked_out_by'),
    /** Who collected the dog: the owner or one of their authorized people, by name. */
    pickedUpBy: text('picked_up_by'),
    invoiceId: uuid('invoice_id'),
  },
  (t) => [index('visits_open').on(t.businessId, t.checkedOutAt)],
);

/** Report-card notes and incidents. `sharedWithOwner` puts it in the customer app. */
export const visitNotes = pgTable('visit_notes', {
  id: id(),
  businessId: biz(),
  dogId: uuid('dog_id')
    .notNull()
    .references(() => dogs.id),
  visitId: uuid('visit_id').references(() => visits.id),
  kind: text('kind').$type<'report' | 'incident' | 'note'>().notNull(),
  body: text('body').notNull(),
  photoUrl: text('photo_url'),
  author: text('author').notNull(),
  sharedWithOwner: boolean('shared_with_owner').notNull().default(false),
  createdAt: created(),
});

export const careTasks = pgTable('care_tasks', {
  id: id(),
  businessId: biz(),
  dogId: uuid('dog_id')
    .notNull()
    .references(() => dogs.id),
  visitId: uuid('visit_id').references(() => visits.id),
  kind: text('kind').$type<'feeding' | 'meds' | 'potty' | 'other'>().notNull(),
  title: text('title').notNull(),
  dueAt: ts('due_at').notNull(),
  doneAt: ts('done_at'),
  doneBy: text('done_by'),
});

export const addOns = pgTable('add_ons', {
  id: id(),
  businessId: biz(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  active: boolean('active').notNull().default(true),
});

export const inventoryItems = pgTable('inventory_items', {
  id: id(),
  businessId: biz(),
  name: text('name').notNull(),
  sku: text('sku'),
  priceCents: integer('price_cents').notNull(),
  costCents: integer('cost_cents').notNull().default(0),
  onHand: integer('on_hand').notNull().default(0),
  reorderAt: integer('reorder_at').notNull().default(0),
});

/** What a manager sells: packs of credits, optionally renewing monthly. */
export const packages = pgTable('packages', {
  id: id(),
  businessId: biz(),
  name: text('name').notNull(),
  credits: jsonb('credits').$type<Partial<Wallet>>().notNull(),
  priceCents: integer('price_cents').notNull(),
  /** Days the credits stay valid after purchase; null = no expiry. */
  expiresDays: integer('expires_days'),
  recurring: boolean('recurring').notNull().default(false),
  rolloverMax: integer('rollover_max').notNull().default(0),
  badge: text('badge'),
  stripePriceId: text('stripe_price_id'),
  /** Listed in the customer app for owners to buy themselves. */
  sellOnline: boolean('sell_online').notNull().default(true),
  active: boolean('active').notNull().default(true),
  createdAt: created(),
});

export const creditGrants = pgTable('credit_grants', {
  id: id(),
  businessId: biz(),
  dogId: uuid('dog_id')
    .notNull()
    .references(() => dogs.id),
  packageId: uuid('package_id').references(() => packages.id),
  membershipId: uuid('membership_id'),
  invoiceId: uuid('invoice_id'),
  credits: jsonb('credits').$type<Partial<Wallet>>().notNull(),
  /** What is left of this grant; visits spend the soonest-expiring grant first. */
  remaining: jsonb('remaining').$type<Wallet>().notNull(),
  note: text('note'),
  expiresAt: ts('expires_at'),
  createdAt: created(),
});

export const memberships = pgTable('memberships', {
  id: id(),
  businessId: biz(),
  dogId: uuid('dog_id')
    .notNull()
    .references(() => dogs.id),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => owners.id),
  packageId: uuid('package_id')
    .notNull()
    .references(() => packages.id),
  status: text('status').$type<'active' | 'past_due' | 'cancelled'>().notNull(),
  currentPeriodEnd: ts('current_period_end').notNull(),
  failures: integer('failures').notNull().default(0),
  nextAttemptAt: ts('next_attempt_at'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  cancelledAt: ts('cancelled_at'),
  createdAt: created(),
});

export type Fulfilment =
  | { type: 'package'; packageId: string; dogId: string }
  | { type: 'membership'; membershipId: string }
  | { type: 'training'; enrollmentId: string };

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    businessId: biz(),
    number: integer('number').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    dogId: uuid('dog_id').references(() => dogs.id),
    visitId: uuid('visit_id'),
    category: text('category')
      .$type<'daycare' | 'boarding' | 'packages' | 'walks' | 'training' | 'retail' | 'other'>()
      .notNull(),
    lines: jsonb('lines').$type<BillLine[]>().notNull(),
    totalCents: integer('total_cents').notNull(),
    status: text('status').$type<'open' | 'paid' | 'refunded' | 'partially_refunded' | 'void'>().notNull(),
    /** What to hand over once paid (credits for a pack, a membership month). Done once. */
    fulfilment: jsonb('fulfilment').$type<Fulfilment | null>(),
    fulfilledAt: ts('fulfilled_at'),
    /** Local day the bill is due; null means due on receipt with no reminders. */
    dueDate: date('due_date'),
    memo: text('memo'),
    /** First time it was emailed or texted, and first time the pay page was opened. */
    sentAt: ts('sent_at'),
    viewedAt: ts('viewed_at'),
    remindersSent: integer('reminders_sent').notNull().default(0),
    lastReminderAt: ts('last_reminder_at'),
    paidAt: ts('paid_at'),
    createdAt: created(),
  },
  (t) => [uniqueIndex('invoices_number').on(t.businessId, t.number)],
);

/**
 * Prospective customers: an inquiry from the website form, a phone call, a
 * walk-in. Worked through stages until they become an owner (won) or not (lost).
 */
export const leads = pgTable(
  'leads',
  {
    id: id(),
    businessId: biz(),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    dogName: text('dog_name'),
    dogBreed: text('dog_breed'),
    source: text('source').$type<'website' | 'phone' | 'walk_in' | 'referral' | 'social' | 'other'>().notNull(),
    interest: jsonb('interest').$type<string[]>().notNull().default([]),
    stage: text('stage').$type<'new' | 'contacted' | 'tour' | 'trial' | 'won' | 'lost'>().notNull(),
    message: text('message'),
    lostReason: text('lost_reason'),
    /** Local day of the next follow-up; the morning list and reminders read it. */
    followUpOn: date('follow_up_on'),
    /** Local day the follow-up push last went out, so it goes once a day. */
    remindedOn: date('reminded_on'),
    assignedTo: uuid('assigned_to').references(() => users.id),
    /** The owner record this lead became. */
    ownerId: uuid('owner_id').references(() => owners.id),
    createdAt: created(),
    updatedAt: ts('updated_at'),
  },
  (t) => [index('leads_business_stage').on(t.businessId, t.stage)],
);

/** Everything that happened with a lead: notes, calls, texts, emails, stage moves. */
export const leadActivities = pgTable(
  'lead_activities',
  {
    id: id(),
    businessId: biz(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    kind: text('kind').$type<'note' | 'call' | 'text' | 'email' | 'stage' | 'tour'>().notNull(),
    body: text('body').notNull(),
    by: text('by').notNull(),
    at: created(),
  },
  (t) => [index('lead_activities_lead').on(t.leadId)],
);

/** Each time an invoice went out, by email or text, and whether it got there. */
export const invoiceSends = pgTable(
  'invoice_sends',
  {
    id: id(),
    businessId: biz(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    channel: text('channel').$type<'email' | 'sms'>().notNull(),
    kind: text('kind').$type<'invoice' | 'reminder' | 'receipt'>().notNull(),
    to: text('to').notNull(),
    status: text('status').$type<'sent' | 'failed' | 'skipped'>().notNull(),
    error: text('error'),
    sentBy: text('sent_by').notNull(),
    createdAt: created(),
  },
  (t) => [index('invoice_sends_invoice').on(t.invoiceId)],
);

export const payments = pgTable('payments', {
  id: id(),
  businessId: biz(),
  invoiceId: uuid('invoice_id')
    .notNull()
    .references(() => invoices.id),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => owners.id),
  method: text('method').$type<'card' | 'cash' | 'link'>().notNull(),
  amountCents: integer('amount_cents').notNull(),
  feeCents: integer('fee_cents').notNull().default(0),
  refundedCents: integer('refunded_cents').notNull().default(0),
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  cardLabel: text('card_label'),
  status: text('status').$type<'succeeded' | 'failed'>().notNull(),
  failureMessage: text('failure_message'),
  takenBy: text('taken_by').notNull(),
  createdAt: created(),
});

/** A pay-by-link page for an open invoice; only the token's hash is kept. */
export const paymentLinks = pgTable('payment_links', {
  id: id(),
  businessId: biz(),
  invoiceId: uuid('invoice_id')
    .notNull()
    .references(() => invoices.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: created(),
});

export const walkTypes = pgTable('walk_types', {
  id: id(),
  businessId: biz(),
  name: text('name').notNull(),
  minutes: integer('minutes').notNull(),
  priceCents: integer('price_cents').notNull(),
  active: boolean('active').notNull().default(true),
});

export const walks = pgTable('walks', {
  id: id(),
  businessId: biz(),
  dogId: uuid('dog_id')
    .notNull()
    .references(() => dogs.id),
  walkTypeId: uuid('walk_type_id').references(() => walkTypes.id),
  walkerId: uuid('walker_id').references(() => users.id),
  scheduledAt: ts('scheduled_at').notNull(),
  status: text('status').$type<'requested' | 'scheduled' | 'in_progress' | 'done' | 'cancelled'>().notNull(),
  startedAt: ts('started_at'),
  endedAt: ts('ended_at'),
  meters: integer('meters'),
  durationMs: integer('duration_ms'),
  pee: boolean('pee'),
  poop: boolean('poop'),
  report: text('report'),
  priceCents: integer('price_cents').notNull(),
  invoiceId: uuid('invoice_id'),
  createdAt: created(),
});

export const walkPoints = pgTable(
  'walk_points',
  {
    id: id(),
    walkId: uuid('walk_id')
      .notNull()
      .references(() => walks.id, { onDelete: 'cascade' }),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    at: ts('at').notNull(),
    accuracy: real('accuracy'),
  },
  (t) => [index('walk_points_walk').on(t.walkId, t.at)],
);

/** Manager ↔ staff chat. Internal only: owners never see it. */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: id(),
    businessId: biz(),
    /** `team` for the group channel, otherwise the two user ids sorted and joined by `:`. */
    channel: text('channel').notNull(),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: created(),
  },
  (t) => [index('chat_channel').on(t.businessId, t.channel, t.createdAt)],
);

export const chatReads = pgTable(
  'chat_reads',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    readAt: ts('read_at').notNull(),
  },
  (t) => [uniqueIndex('chat_reads_user_channel').on(t.userId, t.channel)],
);

/** Every text to or from an owner, automatic or typed. */
export const smsMessages = pgTable('sms_messages', {
  id: id(),
  businessId: biz(),
  ownerId: uuid('owner_id').references(() => owners.id),
  direction: text('direction').$type<'out' | 'in'>().notNull(),
  to: text('to').notNull(),
  body: text('body').notNull(),
  kind: text('kind').$type<'pickup' | 'manual' | 'payment_link' | 'invoice' | 'walk_report' | 'reminder' | 'lead' | 'inbound'>().notNull(),
  status: text('status').$type<'queued' | 'sent' | 'failed' | 'received' | 'skipped'>().notNull(),
  providerId: text('provider_id'),
  error: text('error'),
  sentBy: text('sent_by'),
  createdAt: created(),
});

export const timePunches = pgTable('time_punches', {
  id: id(),
  businessId: biz(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  inAt: ts('in_at').notNull(),
  outAt: ts('out_at'),
});

export const shifts = pgTable('shifts', {
  id: id(),
  businessId: biz(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
});

export const staffRequests = pgTable('staff_requests', {
  id: id(),
  businessId: biz(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  kind: text('kind').$type<'time_off' | 'swap' | 'other'>().notNull(),
  fromDate: date('from_date'),
  toDate: date('to_date'),
  hours: real('hours'),
  note: text('note'),
  status: text('status').$type<'pending' | 'approved' | 'denied'>().notNull(),
  decidedBy: text('decided_by'),
  createdAt: created(),
});

export const certifications = pgTable('certifications', {
  id: id(),
  businessId: biz(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  expiresOn: date('expires_on'),
});

export const expenses = pgTable('expenses', {
  id: id(),
  businessId: biz(),
  category: text('category').notNull(),
  vendor: text('vendor').notNull(),
  amountCents: integer('amount_cents').notNull(),
  dueDate: date('due_date').notNull(),
  paidAt: ts('paid_at'),
  note: text('note'),
  createdAt: created(),
});

export const budgets = pgTable(
  'budgets',
  {
    id: id(),
    businessId: biz(),
    category: text('category').notNull(),
    /** `YYYY-MM`. */
    month: text('month').notNull(),
    amountCents: integer('amount_cents').notNull(),
  },
  (t) => [uniqueIndex('budgets_cat_month').on(t.businessId, t.category, t.month)],
);

/**
 * Training: group classes (a course of weekly sessions with a capacity) and
 * private lessons (one dog, one trainer, one session at a time).
 */
export const trainingPrograms = pgTable('training_programs', {
  id: id(),
  businessId: biz(),
  name: text('name').notNull(),
  description: text('description'),
  kind: text('kind').$type<'class' | 'private'>().notNull(),
  /** Sessions in the course; 1 for a private lesson. */
  sessionCount: integer('session_count').notNull().default(1),
  sessionMinutes: integer('session_minutes').notNull().default(60),
  capacity: integer('capacity').notNull().default(1),
  priceCents: integer('price_cents').notNull(),
  trainerId: uuid('trainer_id').references(() => users.id),
  /** Skills tracked for progress, e.g. ["Sit", "Down", "Loose-leash walking"]. */
  skills: jsonb('skills').$type<string[]>().notNull().default([]),
  sellOnline: boolean('sell_online').notNull().default(true),
  active: boolean('active').notNull().default(true),
  createdAt: created(),
});

export const trainingSessions = pgTable(
  'training_sessions',
  {
    id: id(),
    businessId: biz(),
    programId: uuid('program_id')
      .notNull()
      .references(() => trainingPrograms.id),
    trainerId: uuid('trainer_id').references(() => users.id),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    location: text('location'),
    /** For private lessons: the one dog booked into it. */
    dogId: uuid('dog_id').references(() => dogs.id),
    status: text('status').$type<'scheduled' | 'done' | 'cancelled'>().notNull().default('scheduled'),
    notes: text('notes'),
  },
  (t) => [index('training_sessions_time').on(t.businessId, t.startsAt)],
);

export const trainingEnrollments = pgTable('training_enrollments', {
  id: id(),
  businessId: biz(),
  programId: uuid('program_id')
    .notNull()
    .references(() => trainingPrograms.id),
  dogId: uuid('dog_id')
    .notNull()
    .references(() => dogs.id),
  status: text('status').$type<'pending_payment' | 'enrolled' | 'completed' | 'dropped'>().notNull(),
  invoiceId: uuid('invoice_id'),
  createdAt: created(),
});

export const trainingAttendance = pgTable(
  'training_attendance',
  {
    id: id(),
    businessId: biz(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => trainingSessions.id),
    dogId: uuid('dog_id')
      .notNull()
      .references(() => dogs.id),
    attended: boolean('attended').notNull(),
    note: text('note'),
  },
  (t) => [uniqueIndex('training_attendance_once').on(t.sessionId, t.dogId)],
);

/** A trainer's mark on one skill for one dog. The latest per skill is the dog's level. */
export const trainingProgress = pgTable('training_progress', {
  id: id(),
  businessId: biz(),
  dogId: uuid('dog_id')
    .notNull()
    .references(() => dogs.id),
  programId: uuid('program_id').references(() => trainingPrograms.id),
  skill: text('skill').notNull(),
  /** 0 not started · 1 learning · 2 with help · 3 reliable · 4 mastered */
  level: integer('level').notNull(),
  note: text('note'),
  homework: text('homework'),
  sharedWithOwner: boolean('shared_with_owner').notNull().default(true),
  author: text('author').notNull(),
  createdAt: created(),
});

/**
 * Waivers and liability forms a manager writes and can require.
 *
 * Editing the text makes a new version; a signature is for one version and
 * keeps a copy of the exact text signed, so what an owner agreed to never
 * changes under them.
 */
export const waivers = pgTable('waivers', {
  id: id(),
  businessId: biz(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  version: integer('version').notNull().default(1),
  /** Owners must sign before booking or check-in. */
  required: boolean('required').notNull().default(true),
  /** `owner` signs once per account; `dog` once per dog (e.g. a behaviour release). */
  scope: text('scope').$type<'owner' | 'dog'>().notNull().default('owner'),
  active: boolean('active').notNull().default(true),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  createdAt: created(),
});

export const waiverSignatures = pgTable(
  'waiver_signatures',
  {
    id: id(),
    businessId: biz(),
    waiverId: uuid('waiver_id')
      .notNull()
      .references(() => waivers.id),
    version: integer('version').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id),
    dogId: uuid('dog_id').references(() => dogs.id),
    title: text('title').notNull(),
    bodySigned: text('body_signed').notNull(),
    bodySha256: text('body_sha256').notNull(),
    signedName: text('signed_name').notNull(),
    /** The drawn signature as an SVG path or PNG data URL from the app. */
    signatureImage: text('signature_image'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** Who collected it: the owner in the app, or staff on the front-desk tablet. */
    collectedBy: text('collected_by').notNull(),
    signedAt: ts('signed_at').notNull(),
  },
  (t) => [index('waiver_sigs_owner').on(t.ownerId)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    businessId: biz(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    detail: text('detail').notNull(),
    at: created(),
  },
  (t) => [index('audit_business_at').on(t.businessId, t.at)],
);

export const schema = {
  businesses,
  users,
  sessions,
  pushTokens,
  owners,
  authorizedPeople,
  paymentMethods,
  dogs,
  vaccines,
  yards,
  kennels,
  bookings,
  visits,
  visitNotes,
  careTasks,
  addOns,
  inventoryItems,
  packages,
  creditGrants,
  memberships,
  invoices,
  payments,
  paymentLinks,
  invoiceSends,
  leads,
  leadActivities,
  walkTypes,
  walks,
  walkPoints,
  chatMessages,
  chatReads,
  smsMessages,
  timePunches,
  shifts,
  staffRequests,
  certifications,
  expenses,
  budgets,
  trainingPrograms,
  trainingSessions,
  trainingEnrollments,
  trainingAttendance,
  trainingProgress,
  waivers,
  waiverSignatures,
  auditLog,
};
