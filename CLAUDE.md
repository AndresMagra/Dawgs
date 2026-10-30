# Dawgs — working notes for Claude

Software for dog daycares and boarding, sold to many daycares as a service.
The owner (am) gives it free to a friend's daycare (the first tenant) and plans
to sell it to others. US market, English UI, US dollars.

The clickable prototype is the spec for screens and behaviour:
https://claude.ai/artifact/PebtKMKGWRVGFjqLoPF8BU

## Shape

```
packages/core   business rules, no I/O: pricing/bill, credits, vaccines, kennels,
                memberships (retry 3 days, cancel after 4), GPS walks, payroll (OT > 40 h)
packages/db     Drizzle schema + migrations; PGlite for dev/tests, Postgres in prod
apps/api        Fastify API. Every app uses only these routes.
packages/client typed API client + formatting, shared by both apps
packages/ui     React Native components (web too): theme, Sheet, Pick, SignaturePad, RouteMap
apps/staff      Expo app (web + iOS + Android) for managers and staff
apps/customer   Expo app (web + iOS + Android) for pet owners; also hosts /pay/<token>
```

Run an app: `cd apps/staff && npx expo start --web` (API URL from
`EXPO_PUBLIC_API_URL`, default http://localhost:3001). Typecheck with
`npx tsc --noEmit`; `npx expo export --platform web` builds the website.
`expo install` cannot reach Expo's servers from cloud sessions: pin versions from
`node_modules/expo/bundledNativeModules.json`.

## Build and test

```bash
pnpm install
pnpm --filter @dawgs/core --filter @dawgs/db build   # api reads their dist/
cd packages/core && npx vitest run
cd apps/api && npx tsc --noEmit -p tsconfig.json && npx vitest run
node apps/api/dist/server.js   # dev server :3001, seeds demo daycare "happy-tails"
```

Demo logins (password `dawgs-demo-2026`): manager `priya@happytails.test`,
staff `marco@happytails.test` (also jess, tasha, leo), owners
`dana@example.com`, `sam@example.com`, `alex@example.com`, `jordan@example.com`,
`riley@example.com`.

- Schema change: edit `packages/db/src/schema.ts`, add new tables to the `schema`
  object, then `cd packages/db && npx drizzle-kit generate`. Never edit a
  migration that has been pushed (while nothing is deployed, 0000 may be regenerated).
- `apps/api/src/main.ts` is production and never seeds; `server.ts` is dev.

## Rules that matter

- **Tenancy:** every row has `businessId`; every handler loads rows and checks
  them with `sameBusiness` (staff) or `myDog`/`ownerId` (customer routes in
  `routes/me.ts`). Routes are closed unless `config: { public: true }`.
- **Roles:** `manager` > `staff`; `owner` is a pet owner in the customer app.
  Pay rates, money, refunds, settings, waivers editing: managers only.
- **Money is integer cents.** Times are timestamptz; business-local days are
  `date` columns holding the LOCAL date. Use `@dawgs/core` time helpers with the
  business's IANA timezone, never server time.
- **Credits are grants** (`credit_grants.remaining`), spent soonest-expiring
  first; the wallet is derived. Never store a balance on the dog.
- **Invoices settle through `payInvoice`**; what a paid invoice hands over
  (pack credits, membership month, class enrollment) runs once in `fulfil.ts`.
- **Payments:** each daycare connects its OWN Stripe through Connect (OAuth,
  Standard). All Stripe calls carry `stripeAccount`. Without platform keys the
  whole server runs on `SimulatedGateway` (Stripe test-card names).
- **Texts:** each daycare's OWN Twilio; token AES-GCM encrypted with
  DAWGS_SECRET. Without it, `ConsoleSms` logs. Honour STOP/START.
- **Invoices out:** `invoicing.ts` emails (platform Resend key, daycare name as
  sender, daycare email as reply-to) and texts each invoice with a pay link;
  every attempt is an `invoice_sends` row. Reminders at 1/7/14 days overdue,
  claimed by bumping `reminders_sent`. Without RESEND_API_KEY + DAWGS_MAIL_FROM,
  `ConsoleMail` logs.
- **Leads:** `leads.ts`. Prospects from the public form (`/inquire/<slug>` in the
  customer site, honeypot + per-IP limit) or added by staff; every call, text,
  email and stage change is a `lead_activities` row. `won` only via convert
  (creates the owner and dog). Texts to leads honour STOP by reading inbound
  `sms_messages`; replies from a lead's number land on its timeline.
- **Add-ons:** `addons.ts`. Managers define them (any name, flat or per-day
  price, category, services, owner-bookable, daily limit); `pickup`/`dropoff`
  kinds are transport with a time and address. Booked ones are
  `booking_add_ons` rows (name and price copied), validated BEFORE the booking
  is written, billed automatically at check-out, and listed on the run sheet,
  where "on the way"/"done" push to the owner.
- **Policies:** `businesses.policies` (jsonb, read through `withPolicyDefaults`):
  sales tax, tips, multi-dog discount, cancel window with late-cancel and
  no-show fees, online-booking rules. `finishBill` in core applies them after
  `computeBill`: discounts, then tax, then tip. Check-out discounts are
  manager-only and need a reason; fees only on confirmed bookings, as an open
  `other` invoice, and a manager can waive them.
- **Pickup:** `authorized_people` per owner; a co-owner with an email who signs
  up joins the same owner record. Removing someone deactivates them and closes
  a co-owner's login. Check-out records `visits.picked_up_by`.
- **Vaccines** count only once staff verify them (owner uploads wait).
- **Waivers** are versioned; editing the text asks everyone to sign again; a
  signature stores the exact text and its SHA-256.
- The starter waiver is a template; a lawyer must review it before real use.

## Never

- Commit secrets or `.env`, or handle the owner's credentials (Stripe, Twilio,
  Apple, Google, GitHub). They enter those themselves.
