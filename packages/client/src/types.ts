/** Shapes the API returns. Kept by hand next to the routes in apps/api. */

export type Role = 'manager' | 'staff' | 'owner';
export type Wallet = { daycare: number; night: number; walk: number; bath: number; training: number };

export interface User {
  id: string;
  businessId: string;
  role: Role;
  name: string;
  email: string;
  phone: string | null;
  ownerId: string | null;
  jobTitle: string | null;
}

export interface PriceList {
  halfDay: number;
  fullDay: number;
  hourly: number;
  latePickupPerMinute: number;
  suiteNight: number;
  runNight: number;
  boarderPlay: number;
  lateCheckout: number;
}

/** What a staff member may do beyond the basics; managers can do all of it. */
export interface StaffPermissions {
  refund: boolean;
  discount: boolean;
  void: boolean;
  seeMoney: boolean;
  export: boolean;
  editSchedule: boolean;
}

export interface Business {
  id: string;
  slug: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  timezone: string;
  logoUrl: string | null;
  brandColor: string;
  prices: PriceList;
  hours: { closesAt: string; checkoutBy: string; halfDayLimitMinutes: number; hourlyMinimumMinutes: number };
  requiredVaccines: string[];
  bookingPolicy?: Pick<Policies, 'cancelWindowHours' | 'lateCancelFeeCents' | 'noShowFeeCents' | 'onlineBooking'>;
}

export interface Flag {
  tone: 'bad' | 'warn' | 'info' | 'ok' | '';
  text: string;
}

export interface VaccineStatus {
  name: string;
  state: 'ok' | 'due_soon' | 'expired' | 'missing';
  expiresAt?: number;
}

export interface Dog {
  id: string;
  name: string;
  breed: string | null;
  sex: 'male' | 'female' | null;
  birthDate: string | null;
  weightLb: number | null;
  color: string | null;
  photoUrl: string | null;
  feeding: string | null;
  allergies: string[];
  medications: { name: string; dose: string; when: string }[];
  behaviour: { escapeRisk?: boolean; leashReactive?: boolean; eatsAlone?: boolean; notes?: string };
  ownerId: string;
  owner: { id: string; name: string; phone: string | null; email: string | null; address?: string | null };
  vaccines: VaccineStatus[];
  vaccineState: VaccineStatus['state'];
  vaccinesAwaitingReview: number;
  canEnter: boolean;
  waiversMissing: string[];
  wallet: Wallet;
  flags: Flag[];
  lastVisitAt: number | null;
  visitCount: number;
  card: { id: string; brand: string; last4: string } | null;
  active: boolean;
  defaultYardId: string | null;
}

export interface Owner {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  emergencyName: string | null;
  emergencyPhone: string | null;
  vetName: string | null;
  vetPhone: string | null;
  smsOptIn: boolean;
  /** Asked not to get campaigns; pickup texts and invoices still go out. */
  marketingOptOut: boolean;
  notes: string | null;
}

export interface Card {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

export interface Booking {
  id: string;
  dogId: string;
  service: 'daycare' | 'boarding';
  plan: 'half' | 'full' | 'hourly' | null;
  date: string | null;
  arrive: string | null;
  depart: string | null;
  kennelId: string | null;
  play: boolean;
  status: 'requested' | 'confirmed' | 'waitlist' | 'checked_in' | 'checked_out' | 'cancelled' | 'declined' | 'no_show';
  pickupTime: string | null;
  source: 'staff' | 'owner';
  notes: string | null;
  estimateCents: number | null;
  dog?: Dog;
  addOns?: BookingAddOn[];
  cancelFeeCents?: number;
}

export interface Visit {
  id: string;
  dogId: string;
  service: 'daycare' | 'boarding';
  plan: 'half' | 'full' | 'hourly' | null;
  kennelId: string | null;
  departDate: string | null;
  play: boolean;
  yardId: string | null;
  checkedInAt: string;
  plannedPickupAt: string | null;
  checkedOutAt: string | null;
  invoiceId: string | null;
}

export interface BillLine {
  text: string;
  amount: number;
  kind: 'service' | 'credit' | 'fee' | 'addon' | 'discount' | 'tax' | 'tip';
}

export interface Bill {
  lines: BillLine[];
  total: number;
  tipOptions?: { percent: number; cents: number }[];
}

export interface Invoice {
  id: string;
  number: number;
  ownerId: string;
  dogId: string | null;
  category: string;
  lines: BillLine[];
  totalCents: number;
  status: 'open' | 'paid' | 'refunded' | 'partially_refunded' | 'void';
  dueDate: string | null;
  memo: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  remindersSent: number;
  createdAt: string;
  paidAt: string | null;
  ownerName?: string;
}

export interface InvoiceSend {
  id: string;
  channel: 'email' | 'sms';
  kind: 'invoice' | 'reminder' | 'receipt';
  to: string;
  status: 'sent' | 'failed' | 'skipped';
  error: string | null;
  sentBy: string;
  createdAt: string;
}

export interface AuthorizedPerson {
  id: string;
  ownerId: string;
  name: string;
  relation: string | null;
  phone: string | null;
  email: string | null;
  photoUrl: string | null;
  coOwner: boolean;
  notes: string | null;
  active: boolean;
  hasLogin: boolean;
}

export interface PayOutcome {
  invoice: Invoice;
  paid: boolean;
  declined?: { message: string; code: string | null };
}

export interface Yard {
  id: string;
  name: string;
  capacity: number;
  maxWeightLb: number | null;
  note: string | null;
  count?: number;
}

export interface Kennel {
  id: string;
  name: string;
  type: 'suite' | 'run';
  active: boolean;
  occupiedBy?: string | null;
}

export interface CareTask {
  id: string;
  dogId: string;
  kind: 'feeding' | 'meds' | 'potty' | 'other';
  title: string;
  dueAt: string;
  doneAt: string | null;
  doneBy: string | null;
}

export interface Board {
  date: string;
  now: number;
  capacity: number;
  daycareBooked: number;
  inBuilding: {
    visit: Visit;
    dog: Dog;
    runningTotalCents: number;
    late: boolean;
    goesHomeToday: boolean;
    yard: string | null;
    kennel: string | null;
  }[];
  expected: { booking: Booking; dog: Dog }[];
  departing: Booking[];
  yards: Yard[];
  kennels: Kennel[];
  tasks: CareTask[];
}

export interface Package {
  id: string;
  name: string;
  credits: Partial<Wallet>;
  priceCents: number;
  expiresDays: number | null;
  recurring: boolean;
  rolloverMax: number;
  badge: string | null;
  sellOnline: boolean;
  active: boolean;
}

export interface Membership {
  id: string;
  dogId: string;
  ownerId: string;
  packageId: string;
  status: 'active' | 'past_due' | 'cancelled';
  currentPeriodEnd: string;
  failures: number;
  nextAttemptAt: string | null;
  packageName?: string;
  priceCents?: number;
  dogName?: string;
  ownerName?: string;
}

export interface WalkType {
  id: string;
  name: string;
  minutes: number;
  priceCents: number;
  active: boolean;
}

export interface Walk {
  id: string;
  dogId: string;
  walkTypeId: string | null;
  walkerId: string | null;
  scheduledAt: string;
  status: 'requested' | 'scheduled' | 'in_progress' | 'done' | 'cancelled';
  startedAt: string | null;
  endedAt: string | null;
  meters: number | null;
  durationMs: number | null;
  pee: boolean | null;
  poop: boolean | null;
  report: string | null;
  priceCents: number;
  dog?: Dog;
  walkerName?: string | null;
}

export interface GpsPoint {
  lat: number;
  lng: number;
  at: number;
  accuracy?: number | null;
}

export interface StaffMember extends User {
  active: boolean;
  onClock: boolean;
  payRateCents?: number | null;
  hiredOn?: string | null;
  ptoHours?: number;
  certifications?: { id: string; name: string; expiresOn: string | null }[];
}

export interface ChatChannel {
  channel: string;
  name: string;
  unread: number;
  lastAt: string | null;
}

export interface ChatMessage {
  id: string;
  channel: string;
  fromUserId: string;
  fromName: string;
  body: string;
  createdAt: string;
}

export interface Waiver {
  id: string;
  title: string;
  body: string;
  version: number;
  required: boolean;
  scope: 'owner' | 'dog';
  active: boolean;
  signedCurrent?: number;
}

export interface OwnerForm {
  waiverId: string;
  title: string;
  version: number;
  required: boolean;
  dog: { id: string; name: string } | null;
  signedAt: string | null;
  signedVersion: number | null;
  needsSignature: boolean;
}

export interface TrainingProgram {
  id: string;
  name: string;
  description: string | null;
  kind: 'class' | 'private';
  sessionCount: number;
  sessionMinutes: number;
  capacity: number;
  priceCents: number;
  trainerId: string | null;
  skills: string[];
  sellOnline: boolean;
  active: boolean;
  enrolled?: number | null;
  spotsLeft?: number | null;
  nextSessions?: TrainingSession[];
}

export interface TrainingSession {
  id: string;
  programId: string;
  trainerId: string | null;
  startsAt: string;
  endsAt: string;
  location: string | null;
  dogId: string | null;
  status: 'scheduled' | 'done' | 'cancelled';
}

export interface CalendarEvent {
  type: 'daycare' | 'boarding' | 'walk' | 'training' | 'shift';
  id: string;
  title: string;
  status?: string;
  date?: string | null;
  start?: string | null;
  end?: string | null;
  startsAt?: string;
  endsAt?: string;
}

export interface ReportCard {
  id: string;
  kind: 'report' | 'incident' | 'note';
  body: string;
  photoUrl: string | null;
  details?: { mood?: string; ate?: string; potty?: string; energy?: string; playmates?: string[] } | null;
  author: string;
  createdAt: string;
}

export interface SmsMessage {
  id: string;
  direction: 'out' | 'in';
  to: string;
  body: string;
  kind: string;
  status: string;
  error: string | null;
  sentBy: string | null;
  createdAt: string;
  ownerName?: string | null;
}

export type LeadStage = 'new' | 'contacted' | 'tour' | 'trial' | 'won' | 'lost';
export type LeadSource = 'website' | 'phone' | 'walk_in' | 'referral' | 'social' | 'other';

export interface Lead {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  dogName: string | null;
  dogBreed: string | null;
  source: LeadSource;
  interest: string[];
  stage: LeadStage;
  message: string | null;
  lostReason: string | null;
  followUpOn: string | null;
  assignedTo: string | null;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface LeadActivity {
  id: string;
  kind: 'note' | 'call' | 'text' | 'email' | 'stage' | 'tour';
  body: string;
  by: string;
  at: string;
}

export interface AddOn {
  id: string;
  code: string;
  name: string;
  description: string | null;
  kind: 'extra' | 'pickup' | 'dropoff';
  category: string | null;
  priceCents: number;
  pricing: 'flat' | 'per_day';
  durationMinutes: number | null;
  services: ('daycare' | 'boarding')[];
  ownerBookable?: boolean;
  needsTime: boolean;
  dailyLimit?: number | null;
  sort: number;
  active: boolean;
}

export interface BookingAddOn {
  id: string;
  bookingId: string;
  addOnId: string;
  kind: AddOn['kind'];
  name: string;
  code: string;
  unitCents: number;
  quantity: number;
  date: string;
  time: string | null;
  address: string | null;
  notes: string | null;
  status: 'scheduled' | 'on_way' | 'done' | 'cancelled';
  doneBy?: string | null;
  doneAt: string | null;
}

/** What a booking form sends for each chosen add-on. */
export interface AddOnRequest {
  addOnId: string;
  quantity?: number;
  time?: string | null;
  address?: string | null;
  notes?: string | null;
}

export interface Policies {
  salesTaxBps: number;
  taxServices: boolean;
  taxAddOns: boolean;
  tipsEnabled: boolean;
  tipChoices: number[];
  multiDogPercent: number;
  cancelWindowHours: number;
  lateCancelFeeCents: number;
  noShowFeeCents: number;
  onlineBooking: { enabled: boolean; autoApprove: boolean; daysAhead: number };
  reviewRequests: { enabled: boolean; url: string; everyDays: number };
  birthdayTexts: boolean;
  reportCardTexts: boolean;
  /** Daycare credits for a client whose referral becomes a client; 0 turns rewards off. */
  referralRewardCredits: number;
}
