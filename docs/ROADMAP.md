# Dawgs: what's built, what competitors have, what's next

Compared against Gingr, PetExec, Revelation Pets, MoeGo, DaySmart Pet and
Time To Pet (their feature pages and buyer guides, November 2026).

## Already in Dawgs

Check-in board with timers, daycare/boarding/hourly pricing, kennels and play
yards, bookings with capacity and waitlist, weekly repeating bookings, online
booking rules, packs/credits and memberships with retries, invoices by email
and text with reminders, Stripe Connect per daycare, tips, sales tax,
multi-dog discount, late-cancel and no-show fees, add-ons and pet taxi with a
run sheet, vaccines (owner upload, staff verify), versioned e-signed waivers,
report cards (bulk send), incident notes, feeding/medication tasks, GPS walks,
training classes, staff time clock/schedule/payroll, team chat, two-way
texting with STOP, leads pipeline with a website form, campaigns and
referrals, review and birthday texts, checklists, staff permissions, reports
and CSV exports, retail stock, activity log, co-owners and authorized pickups.

## Added in this round

| Gap | Why it matters | Now |
| --- | --- | --- |
| Forgot password | Owners lock themselves out on day one | Email link, one hour, one use, signs out other devices; both apps |
| Sign-in brake, safety headers | Basic protection for a public site | 10 tries per email per 15 min; nosniff, frame, referrer, HSTS |
| Booking reminders | Standard in every competitor; cuts no-shows | Day-before text + push, settings toggle |
| Vaccine expiry reminders | Gingr/PetExec do it; keeps records current | Text + push N days before (default 14) |
| New-dog temperament evaluation | Industry norm before first daycare day | Policy switch; owners can't book until staff mark passed |
| Photo/document storage | Vaccine photos were stored inside database rows | S3/R2 storage, database fallback, `/files/<random>` links |
| Import from PetExec/Gingr | Switching cost is the #1 sales objection | CSV import with preview, matching and vaccine columns |
| Installable website (PWA) | Launch the website first, feel like an app | Manifest, real app icon, offline page, install prompt (iPhone + Android) |
| App icon | Apps still had Expo's placeholder icon | Paw icon for both apps, Android adaptive icon |
| Friendly 404 | The default page looked broken | "That page isn't here" with a way back |

## Still missing (suggested order)

1. **Deposits for boarding** at booking time (Gingr, MoeGo, Revelation). Needs a
   "deposit" invoice credited at check-out.
2. **Date pickers** instead of typed YYYY-MM-DD on the booking forms (native
   `<input type="date">` on the web, a picker on phones).
3. **Card on file from the website** (Stripe Elements / Payment Element) so
   owners can save a card and pre-pay online, plus card-fee recovery
   (surcharge) where state law allows.
4. **Webcam links** per play yard for owners (most daycares use a camera
   service; Dawgs only needs to show the stream link to checked-in dogs' owners).
5. **Pre-arrival check (Gingr "PreCheck")**: the day before, owners confirm
   belongings, meds and feeding in the app.
6. **Grooming appointments** with groomer calendars (today grooming is an add-on).
7. **QuickBooks Online export/sync** for the bookkeeper.
8. **Multi-location** daycares under one account (franchise buyers).
9. **Two-step sign-in** for managers (money and exports).
10. **Native store builds** (EAS) once the website has proven itself; push
    notifications then work on phones (the web uses texts and email).
