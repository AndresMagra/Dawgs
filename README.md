# Dawgs

Software for dog daycares and boarding: a staff app (web, iPad/iPhone, Android),
a customer app for pet owners (web, iPhone, Android), and one backend they share.
Sold to daycares as a service; each daycare connects its own Stripe and Twilio.

```
packages/core   business rules: pricing, credits, vaccines, kennels, memberships, walks, payroll
packages/db     Drizzle schema, migrations, PGlite (dev/tests) or Postgres
apps/api        Fastify API used by every app
apps/staff      (coming) Expo app: website + iOS + Android for managers and staff
apps/customer   (coming) Expo app: website + iOS + Android for pet owners
```

```bash
pnpm install
pnpm build
cd packages/core && npx vitest run
```

The clickable prototype that serves as the spec lives at
https://claude.ai/artifact/PebtKMKGWRVGFjqLoPF8BU.
