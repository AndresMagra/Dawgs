# Putting Dawgs online

## A demo to try (test cards only, no real money)

The `Dockerfile` builds one server that runs the API and both websites:
the pet-owner site at `/`, the staff site at `/staff`, the API at `/api`.
It starts `apps/api/dist/demo.js`, which loads the demo daycare and refuses to
start if real Stripe keys are present.

On Railway:

1. New project → Deploy from GitHub repo → `AndresMagra/Dawgs`. Railway finds `railway.json`.
2. In the project, add a **PostgreSQL** database.
3. On the Dawgs service → Variables, add:
   - `DAWGS_DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `DAWGS_SECRET` = any 40+ random characters
   - `DAWGS_PUBLIC_URL` = the service's public address (Settings → Networking → Generate domain), e.g. `https://dawgs-production.up.railway.app`
4. Deploy. Open the address for the owner app and `/staff` for the staff app.
   Password for every demo login: `dawgs-demo-2026` (manager `priya@happytails.test`,
   staff `marco@happytails.test`, owner `dana@example.com`).

Optional: `RESEND_API_KEY` and `DAWGS_MAIL_FROM` to really send invoice emails.

## Production (later)

Same image, start command `node apps/api/dist/main.js`, plus `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_PUBLISHABLE_KEY`
from the Dawgs platform Stripe account. Production never loads demo data.
