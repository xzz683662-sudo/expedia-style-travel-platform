# EasyTrip

An Expedia-style, **self-owned product** travel marketplace. Attractions, tours, hotel
rooms and transfers — all sold, priced, ticketed and redeemed through one in-house
platform.

> **Scope, deliberately.** This connects to the *data layer only*. There are no GDS/NDC
> feeds, no hotel CRS or channel-manager contracts, no fleet/car-rental vendor
> interfaces, and no supplier price or inventory synchronisation. Products, inventory,
> prices and availability are first-party records. That constraint is what makes the
> booking, pricing and ticketing engines meaningful here — every rule is exercised
> end-to-end instead of being proxied to somebody else's API.
>
> Target markets are **Europe and North America**, so the seed catalogue, pricing
> currencies, locales and destinations are all USD/EUR and EN-first.

---

## What's implemented

All eight domains are live, not sketched:

| Domain | Highlights |
| --- | --- |
| **Products & pricing** | `Product → TicketType` uniform model. Nine rule types (date range, day-of-week, season, lead time, length of stay, occupancy, quantity break, flash sale, early bird) with percent/fixed/multiply/set adjustments. `admin/pricing/simulate` explains any quote. |
| **Inventory & availability** | `(ticketType, serviceDate, timeSlot)` rows with `capacityTotal / Held / Sold`, optimistic `version` column, hold→consume→release lifecycle, TTL sweeper, and a 90-day availability calendar. |
| **Booking & payment** | Guest and signed-in carts, multi-line checkout, inventory holds only after checkout begins, idempotent payment intents, `PaymentGateway` interface with a deterministic `mock` adapter and a real Hyperswitch adapter. Tiered cancellation quoting and refunds. |
| **Ticketing & redemption** | Signed QR payloads, printable A4 PDF passes, S3/MinIO or local-disk persistence, gate scanner with dry-run vs. admit modes, double-scan rejection. |
| **Reviews & social** | Verified-purchase reviews, rating breakdown, merchant replies, helpful votes, save/remove journeys in the signed-in wishlist. |
| **Loyalty & marketing** | Tiered points programme, earn on booking, redeem for credit, coupons (`WELCOME10`, `SAVE25`, `FIRSTTIMEBIG`), and **bilingual promo banners** an operator can create, schedule and place on the storefront without a deploy. |
| **Itinerary & map** | Multi-day trip plans with geolocated stops, timezone-aware; customers can create plans and add confirmed bookings from their account. |
| **Accounts & wallets** | Email-verified registration (a 6-digit code, stored only as a hash, single-use and attempt-capped; checkout is gated on it). Stored-value wallet with **top-up and withdrawal**, each writing a `WalletTransaction` so the balance is always explained by its statement. Saved payment methods are *references* — brand and last four, never a card number. |
| **Operations backend** | Three separate surfaces (customer / operations / support), KPI dashboard, order/inventory tables, double-entry ledger (`GROSS_SALES`, `TAX_PAYABLE`, `PLATFORM_FEE`, `MERCHANT_PAYABLE`, `REFUNDS`, `MARKETING_FEE`), audit log. |

The API smoke suite covers the booking lifecycle—search → detail → calendar → checkout →
hold → pay → issue → scan → redeem → cancel → refund—and exercises guest carts, multi-line
checkout, wishlist management, and adding confirmed bookings to trip plans. Run
`bash scripts/smoke-test.sh` to verify it against the configured development database.

> **Inventory feed (opt-in, off by default).** A staging-only importer can pull third-party
> hotel rows from an Apify actor into `ScrapedInventory`. Nothing there is sellable: an operator
> must promote a row by hand into a first-party product, priced from our own cost basis. The
> feature is flag-gated off (`INVENTORY_FEED_ENABLED=false`), so the first-party scope above is
> unchanged — see [`docs/adr/0001-inventory-feed-positioning.md`](./docs/adr/0001-inventory-feed-positioning.md).
> `pnpm inventory:contract` enforces, offline, that the ingest path cannot touch anything the
> booking engine prices from.
>
> **Credentials: data access ≠ transaction.** Every supply source is classified in
> `apps/api/src/modules/supply/credentials.ts` as `PUBLIC` / `API_KEY` / `SUPPLIER` /
> `BOOKING` / `SETTLEMENT`, and the last two are *transaction* credentials. This stage is
> bounded to **read-only supply** — `pnpm credentials:contract` asserts that no enabled source
> can book or settle. The account centre (`/account`) stores payment methods as **references
> only** (a gateway token + brand + last four; never a card number), and the PayPal and TRC20
> rails are **sandbox-only** and refuse `live` outright. See
> [`docs/supply-sources.md`](./docs/supply-sources.md#credential-classification).

---

## Quickstart

```bash
cp .env.example .env          # defaults work as-is for local dev
pnpm install
pnpm setup                    # docker compose up + prisma push + seed
pnpm dev                      # API on :4000, web on :3000
```

Open <http://localhost:3000>.

### Public preview

In a GitHub Codespace only **one** forwarded port is needed:

```bash
bash scripts/preview.sh          # print the URL, verify both services answer
bash scripts/preview.sh --open   # ...and open the storefront

gh codespace ports visibility 3000:public -c "$CODESPACE_NAME"
```

The storefront proxies `/api/v1`, `/media` and `/health` to the API
(`apps/web/next.config.ts`), so the browser stays on a single origin.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | *(empty)* | The **browser** calls its own origin. Only set this when the API genuinely lives elsewhere — doing so re-introduces CORS. |
| `API_INTERNAL_URL` | `http://localhost:4000` | Server-side API origin, used by SSR *and* as the proxy target. |
| `API_PUBLIC_URL` | — | Public **storefront** origin, added to the API's CORS allowlist. Only relevant if you bypass the proxy. |

**Why same-origin rather than two tunnels.** A second forwarded port is one more
thing that can silently drop, and it forces CORS to be correct forever.
Proxying keeps SSR on the internal network (no round-trip through the tunnel),
keeps the browser on one origin, and makes the allowlist a non-issue.

> The API still enforces CORS for direct callers: an unlisted origin gets no
> `access-control-allow-origin` header, so the browser blocks the response even
> when the request itself succeeds. Ports 5432 (Postgres) and 6379 (Redis) must
> stay **private** — never expose them.

### Free-tier deployment (demo / preview only)

This repository includes a Render Blueprint at [`render.yaml`](./render.yaml) that creates
the API and a PostgreSQL database in the same region. For a free public preview:

1. Push the deployment changes to GitHub. In Render, create a **Blueprint** from this
   repository and deploy the resources listed in `render.yaml`. `JWT_SECRET` and
   `PAYMENT_WEBHOOK_SECRET` are generated by Render; do not replace them with the
   development defaults.
2. Once the API service is live, copy its public `https://…onrender.com` URL.
3. Import the repository into Vercel. Set **Root Directory** to `apps/web`. Add
   `API_INTERNAL_URL` with the Render API URL (no trailing slash) for both Preview and
   Production environments, then redeploy. Next's rewrite proxies `/api/v1`, `/media` and
   `/health` to the API.
4. Set up the Render database schema from a trusted machine: put the Render database URL
   in the git-ignored root `.env` as `DATABASE_URL`, then run `pnpm db:push`. Remove that
   URL from `.env` when finished. On a **new, empty database only**, populate the first-
   party product catalog without demo accounts or orders using
   `SEED_DEMO_DATA=false pnpm --filter @easytrip/api db:seed`. Verify the API's `/ready`
   endpoint and the storefront. Provision any staff accounts only through a trusted
   process. Do not run the default development seed against an internet-facing database.

The free Render API sleeps after inactivity and its filesystem is ephemeral; ticket PDFs
and QR images written to local storage can disappear on sleep/redeploy. Free databases
are limited to 1 GB and expire 30 days after creation (after a further 14-day upgrade
grace period, Render deletes the database); they have no backups. This setup is for
evaluation, not real bookings or customer data. The configured payment gateway is the
**mock** gateway; it does not charge cards. Never seed an internet-facing instance with
the development demo accounts and shared passwords listed below. For a production
service, use paid, durable hosting, persistent object storage, real payment-provider
configuration, backups, and a secure staff-account bootstrap process.

### Individual steps

```bash
pnpm infra:up                # postgres + redis
pnpm db:generate             # generate the Prisma client
pnpm db:push                 # sync the schema
pnpm db:seed                 # catalogue, inventory, demo orders, staff accounts
pnpm dev:api                 # Fastify on :4000
pnpm dev:web                 # Next.js on :3000
pnpm smoke                   # end-to-end API test suite
pnpm audit:schema            # find columns written but never read
pnpm supply:import          # import airports from open data (~4,000)
pnpm typecheck               # both packages
```

### Optional services

OpenSearch and MinIO are behind compose profiles, because they aren't needed to run the
platform — the API degrades gracefully without them:

```bash
docker compose --profile search  up -d    # OpenSearch  → real faceted search
docker compose --profile storage up -d    # MinIO        → real object storage
```

Without OpenSearch, search falls back to Postgres full-text. Without MinIO, ticket
artefacts are written to `apps/api/storage/` and served by the API's `/media` route.

---

## Demo accounts

All use the password **`Password123!`**.

| Email | Role | What they can see |
| --- | --- | --- |
| `traveler@easytrip.test` | Customer | Bookings, e-tickets, points, reviews |
| `admin@easytrip.test` | Admin | Everything: dashboard, ledger, coupons, audit, catalogue, gate scanner at `/admin/scan` |
| `support@easytrip.test` | Support | Live chat inbox, customer lookup, wallet adjustments, goodwill refunds, coupon verification |

The login page has one-click fill buttons for these accounts.

> **There are exactly two staff roles, and two staff consoles.** `OPERATOR` (gate
> scanning) and `MERCHANT` (a partner's products) were folded into `ADMIN`: gate scanning
> is an operations capability, and a partner merchant is a *data model* (`Merchant` still
> owns inventory and settles commissions) rather than a permission. See
> [`docs/adr/0002-two-staff-surfaces.md`](./docs/adr/0002-two-staff-surfaces.md).
>
> **Support sits *below* admin on purpose.** The cheapest way to stop an agent from
> breaking pricing is to never let them reach it: `SUPPORT` cannot touch the catalogue,
> pricing rules, inventory or staff accounts. Every support mutation writes an
> `AuditLog` row, and money movement additionally writes a `WalletTransaction` — so
> support activity stays reconstructable after the fact.

## Test cards

The mock gateway is deterministic, so checkout can be exercised without a processor:

| Card | Result |
| --- | --- |
| `4242 4242 4242 4242` | Approved |
| `4000 0000 0000 0002` | Declined |
| `4000 0000 0000 0119` | Processing failure |
| `4000 0000 0000 3220` | Requires 3-D Secure |

---

## Architecture

```text
apps/
  api/                    Fastify 5 + Prisma 5 + PostgreSQL
    prisma/schema.prisma  ~60 models
    src/modules/
      pricing/            rule engine → Quote
      inventory/          hold / consume / release / expire
      booking/            order lifecycle, refunds
      payments/           PaymentGateway (mock | hyper)
      ticketing/          QR, PDF, S3-or-disk persistence
      search/             Postgres FTS ⇄ OpenSearch
    src/routes/           11 route modules, ~75 endpoints
  web/                    Next.js 15 (App Router, RSC) + React 19
    src/app/              storefront routes + (console)/admin + (console)/support
    src/lib/api.ts        fully typed API client
    src/lib/session.ts    token in localStorage *and* a readable cookie
    src/lib/i18n/         locale config + EN/ZH dictionaries
    src/components/       booking panel, calendar, checkout, ticket wallet, consoles
```

### Decisions worth knowing about

**Money is always integer minor units.** Every amount is `number` cents plus an ISO
currency code. Percentages are basis points. `allocate()` splits a total across lines
without ever creating or losing a cent, so a $100.00 order divided three ways still sums
to exactly $100.00.

**Prices never mutate.** An `OrderItem` snapshots the full pricing decision — base price,
each rule that fired, markup, tax, fee — plus a `ruleTrace` JSON blob. A price change
tomorrow can never alter what someone paid today, and support can always explain a
number.

**Holds start at checkout, not carting.** Shopping carts persist selected products without
blocking inventory. Starting checkout places a TTL hold (15 min by default); payment
consumes it, and abandonment or a background sweep releases it. A sweeper runs every
60 s, so abandoned checkouts don't leak inventory.

**One product shape for everything sellable.** Attraction tickets, hotel rooms, tours and
transfers are all `Product → TicketType`. The booking engine has exactly one code path,
which is why adding a category doesn't mean adding a subsystem.

**Hotel stays are priced and held per night, not per booking.** Supplying `checkOutDate` on
a cart item turns it into a stay: nights = `checkOut − checkIn`, the line total becomes
`rate × rooms × nights`, and every night in the range is held. A 3-night booking is one
`InventoryHoldGroup` owning three `InventoryHold` rows — one per night — so checkout,
payment and expiry each act on the whole set while `releaseHold`/`consumeHold` keep the
signatures they always had. Holds are **all-or-nothing**: if any night is unavailable the
group is discarded and no night stays blocked. `ProductStay.policies` carries `minNights` /
`maxNights`, enforced before a hold is placed.

**Packages are not booked — they are expanded.** A `ProductBundle` lists component
`TicketType`s with an optional `startOffsetDays`, so "flight + 3 nights" is one purchasable
thing. Adding one to a cart writes its components as separate lines (the flight as a
single-date line, the hotel as a 3-night stay) and the package itself never becomes a line —
otherwise checkout would bill for the bundle *and* its parts. Checkout then holds and prices
them as one order, so a package is all-or-nothing across categories. The headline price is
derived from live component prices at read time rather than stored, so it cannot drift when a
component reprices.

**One shape for the spine, category tables for the depth.** `Product → TicketType → OrderItem`
stays the single transactional path. On top of it, `ProductStay`, `ProductFlight`,
`ProductSailing` and `ProductVehicle` carry the structure a flat column cannot express — a
room grid, ordered flight segments, cabin categories, sailing ports. They are 1:1 extensions
keyed on `productId`, so nothing in the booking path had to change to adopt them.

`GET /products/:slug` returns whichever of `stay` / `flight` / `sailing` / `vehicle` / `bundle`
applies, and `null` for the rest — a hotel does not report a ship. A stay carries its room
grid, check-in/check-out times and policies; a flight its ordered segments, cabins and fare
families; a cruise its ship, sailing ports and cabin categories; a package its components
but deliberately no stored price. Expect `null` inside these blocks for anything a supplier
feed has not supplied: a carrier code, a port, a sail date. Absent means "unknown", not zero.

Inventory carries a `dimensionKey` alongside the existing `timeSlot`, so a hotel can hold
stock per room type and a cruise per cabin without a new inventory table. Existing rows keep
`dimensionKey = ""` and behave exactly as before.

`/search` exposes the derived facets — `starRating` and `boardBasis` for hotels, `carrierName`
and `routeSummary` for flights, `shipName` for cruises — as both response fields and
CSV filters (`?type=HOTEL_ROOM&stars=4,5`). They are backfilled from the flat columns by
`seed-category-extensions.ts`, which is idempotent and marks every value it could not derive
as `null` rather than inventing one. Treat those nulls as "not yet supplied by a feed", not
as real data.

**Graceful degradation everywhere.** Redis → in-memory; OpenSearch → Postgres; S3 → local
disk. The platform boots and works with only Postgres running, which keeps onboarding and
CI honest.

**Auth uses a readable cookie as well as localStorage.** Server components can then
pre-render `/orders/[id]` with real content instead of a skeleton. The client component
re-fetches on mount, so a stale cookie can't strand anyone.

---

## Three surfaces, one app

The platform ships as three visually and logically distinct surfaces:

| Surface | Route | Who | Cannot see |
| --- | --- | --- | --- |
| **Storefront** | `/`, `/search`, `/products/*`, `/cart`, `/checkout`, `/orders`, `/tickets`, `/wishlist`, `/itineraries`, `/loyalty` | Customers | Anything staff-related |
| **Operations** | `/admin`, `/admin/finance`, `/admin/scan`, `/admin/promo` | Admin | — |
| **Support** | `/support/inbox`, `/support`, `/support/orders`, `/support/coupons`, `/support/audit` | Support, Admin | Catalogue, pricing rules, inventory, staff accounts |

Each console gets its own colour identity (admin = brand blue, support = teal) so an
operator working across a handover can tell at a glance which surface they are in — the
cheapest possible guard against acting in the wrong system.

**A customer never sees a staff entry point.** This is enforced in three places, because
one is not enough:

1. `Header.tsx` gates its links through a `STAFF_ROUTES` role map.
2. `Footer.tsx` has no staff column at all (it used to leak `/admin`, `/admin/scan` and
   `/admin/finance`).
3. Every console route is guarded server-side by `requireRole(...)`, and `ConsoleShell`
   re-checks the role before rendering any data view.

> **Note on isolation.** `/admin` and `/support` are routes inside the same Next.js app,
> so a *signed-in staff member* navigating directly by URL will reach the console — that
> is intended. What is guaranteed is that a customer account cannot (`403`), and that no
> customer-visible page advertises the URL. True network-level separation — separate
> hostnames, separate deploys, no shared bundle — is a different architecture.

---

## Internationalisation

The UI ships in **English and Chinese**, switchable from the header on every page and
from inside each console.

**Server-rendered locale, not a client context.** `resolveServerLocale()` reads a
`easytrip_lang` cookie and falls back to `Accept-Language`. Most of this site is
server-rendered, so a client-side locale provider would leave the *common* case rendering
in the previous language until the next navigation. Switching locale writes the cookie and
calls `router.refresh()`, which re-renders on the server in the new language.

**English is the source of truth.** The `en` object defines the shape; `zh` is validated
against it with `satisfies Record<LocaleCode, typeof en>`. A missing or misspelled Chinese
key is therefore a **compile error**, not a blank string in production. Values may be
functions, so counts and currency interpolate per language rather than concatenating
English grammar.

**Dates, money and weekday names go through `Intl`.** `formatMoney`, `formatDate` and
`relativeDay` all take a locale; the availability calendar derives its weekday headers and
month names from `Intl.DateTimeFormat` instead of a hard-coded array.

**Content is localised at the edge, not in the client.** `GET /promo/banners?locale=zh`
resolves the language server-side and returns one `title` / `body` / `ctaLabel`, so the
component renders what it is given and never has to know a fallback exists.

---

## Promotional banners

Operators place merchandising on the storefront without a deploy:

- `/admin/promo` — bilingual editor (separate EN and ZH title, body and CTA), theme
  picker, start/end schedule, active toggle, sort order, market and locale targeting.
- The homepage renders an eligible banner via `<PromoStrip slot="home" />`, revalidating
  every 5 minutes rather than reading through on every request.
- Clicks are counted with a fire-and-forget `POST /promo/banners/:id/click`.

Seed data ships three banners so the strip is visible immediately after `pnpm db:seed`.

---

## Support tooling

The support console is deliberately narrower than admin:

- **Customer lookup** by name, email or phone, plus a full profile view (orders, wallet
  ledger, loyalty).
- **Profile corrections** — name, phone, locale, country, marketing opt-in, wallet
  enablement, points and tier. `email`, `password` and `role` are **excluded**: those are
  account-takeover and privilege-escalation vectors, and belong in a separate, audited flow.
- **Wallet adjustments** with a mandatory reason. Signed amounts, and a debit that would
  take a balance negative is refused.
- **Goodwill refunds** against a paid order. The refund lands as wallet credit, writes a
  `REFUNDS`/`DEBIT` ledger pair and a `Refund` row. Guest orders (`userId: null`) are
  rejected, because there is no account to credit.
- **Coupon verification** (read-only — creating coupons changes revenue, so that stays in
  admin).
- **Audit trail** for every support action.

---

## API reference

Base URL `/api/v1`. Auth via `Authorization: Bearer <token>`.

**Discovery** — `GET /search`, `/destinations`, `/collections/:slug`,
`/search/connections`, `/search/connections/points`,
`/search/airports`, `/search/airports/:iata/source`,
`/search/flights/live`, `/search/flights/:callsign/live`
Category facet filters: `stars`, `carriers`, `carrierCodes`, `ships`,
`destinationPorts`, `boardBasis` (comma-separated). Values
outside the valid range are dropped rather than rejected, so a bad chip value degrades to
"no filter" instead of a 4xx.

`/search/connections?airport=DXB&requireChange=true` answers "which itineraries
stop at DXB" from the `FlightSegment` table, with optional `minLayoverMinutes`
/ `maxLayoverMinutes` / `maxDurationMinutes`. `requireChange` is what separates
*via* DXB from *to* DXB — without it the first leg of every DXB departure counts
as a connection. `/search/connections/points` summarises every intermediate
airport the catalogue actually routes through, with the median layover. It is
empty rather than fabricated when no product has a second leg.

`/search/airports` serves the airport directory imported from open data
(`pnpm supply:import`, ~4,000 airports with IATA/ICAO codes and coordinates).
`near=lat,lng&radiusKm=N` ranks by real great-circle distance.
`/search/airports/:iata/source` returns the provenance and licence of an
imported row, so attribution is answerable from the data. See
[`docs/supply-sources.md`](./docs/supply-sources.md).

`/search/flights/live?lat=&lng=&radiusNm=` and
`/search/flights/:callsign/live` answer "where is this aircraft right now"
from community ADS-B networks. These are live queries, never imports:
positions live in a short cache and are never persisted, and the source that
answered travels on every item. See
[`docs/supply-sources.md`](./docs/supply-sources.md) ("Real-time sources").
**Products** — `GET /products/:slug`, `/products/:slug/availability`, `/products/:slug/nearby`
**Auth** — `POST /auth/register`, `/auth/login`; `GET|PATCH /auth/me`; `POST /auth/travelers`
**Email verification** — `POST /auth/verify-email` (6-digit code), `POST /auth/resend-verification`.
Registration issues a code; a signed-in but unverified account is refused at
`POST /orders` with `403 EMAIL_NOT_VERIFIED`.
**Account & wallet** — `GET /account/overview`, `/account/payment-methods`,
`/account/payment-channels`; `POST /account/payment-methods`.
`GET /account/wallet` (balance + statement), `POST /account/wallet/top-up`,
`POST /account/wallet/withdraw`. Amounts are integer minor units; both movements
append a `WalletTransaction`.
**Support chat** — `POST /support/conversations`, `GET /support/conversations/mine`,
`GET /support/conversations/:id`, `POST /support/conversations/:id/messages` (shopper);
`GET /support/inbox`, `/support/inbox/:id`, `POST /support/inbox/:id/messages`,
`/support/inbox/:id/assign`, `/support/inbox/:id/close`, `/support/inbox/:id/reopen` (staff).
**Orders** — `POST /orders`, `GET /orders`, `/orders/:id`, `/orders/lookup`,
`POST /orders/:id/pay`, `GET /orders/:id/cancellation-quote`, `POST /orders/:id/cancel`
**Cart** — `GET /cart`, `POST /cart/items`, `PATCH|DELETE /cart/items/:id`,
`POST /cart/checkout` (guest carts use the returned `X-Cart-Token`; inventory is held only at checkout).
Add `checkOutDate` alongside `serviceDate` to book a stay — the item records `nights`,
and order lines come back with `checkInDate` / `checkOutDate` / `nightlyPriceCents`.
**Payments** — `POST /webhooks/payment`
**Tickets** — `GET /tickets`, `/tickets/:ticketNumber`, `POST /tickets/:ticketNumber/transfer`,
`/tickets/transfer/:token/accept`, `/tickets/recover`
**Gate** — `POST /scan/verify`, `/scan/redeem`; `GET /scan/stats`
**Social** — `GET|POST /products/:slug/reviews`, `POST /reviews/:id/helpful`,
`GET|POST /wishlist`, `DELETE /wishlist/:productId`
**Loyalty** — `GET /loyalty/program`, `/loyalty/account`; `POST /loyalty/redeem`
**Itinerary** — `GET|POST /itineraries`, `POST /itineraries/:id/items`
**Admin** — `GET /admin/dashboard`, `/admin/products`, `/admin/orders`, `/admin/inventory`,
`/admin/finance/ledger`, `/admin/coupons`, `/admin/merchants`, `/admin/reviews`,
`/admin/audit`; `POST /admin/inventory/adjust`, `/admin/pricing/simulate`,
`/admin/search/reindex`, `/admin/finance/settle`, `/admin/bootstrap`
**Promotions** — `GET /promo/banners` (public, locale-resolved), `POST /promo/banners/:id/click`;
`GET|POST|PATCH|DELETE /admin/promo/banners[/:id]`
**Support** — `GET /support/customers`, `/support/customers/:id`,
`GET /support/orders/lookup`, `GET /support/coupons/:code/verify`, `GET /support/audit`;
`PATCH /support/customers/:id`, `POST /support/customers/:id/wallet`,
`POST /support/orders/:id/refund`
**Artefacts** — `GET /media/tickets/:ticketNumber/{qr.png,ticket.pdf}`

Every route accepts a `locale` query parameter (`en`, `zh`) and falls back to
`Accept-Language`, then the user's stored locale, then `en-US`.

Operations: `GET /health`, `GET /ready` (per-dependency readiness).

---

## Testing

```bash
bash scripts/smoke-test.sh    # 102 checks, requires both services running
bash scripts/mobile-check.sh  # 41 checks, responsive layer regression guard
bash scripts/schema-audit.sh  # finds columns a seed writes but no route reads
node scripts/check-images.mjs # every seed image URL must answer 200
node scripts/check-i18n-keys.mjs # en/zh key parity, and no dangling t('…') keys
pnpm typecheck                # strict TS across api + web
pnpm --filter @easytrip/web build
pnpm verify                   # typecheck + schema audit + contracts + smoke + realtime + mobile
```

The smoke suite is end-to-end against a live stack — it registers, verifies the emailed
code, books a real order, pays it, redeems the ticket at the gate, and asserts the second
scan is rejected. It also asserts that an **unverified** account is refused at checkout
and that a customer token cannot reach the staff support inbox.

`pnpm verify` runs an offline contract gate per subsystem before the live suites:
`supply:contract`, `inventory:contract`, `auth:contract` (a verification code is never
stored in the clear; one failure message; checkout gating) and `support-chat:contract`
(customer reads are always scoped by the token's user).

Two cheaper gates guard failure modes that are invisible to `tsc`:

- **`check:images`** HEAD-checks every image URL the seed writes. Thirteen of sixty-one
  had silently 404'd, which is why destination tiles rendered as grey boxes; nothing in
  the type system or the test suite could see it.
- **`check:i18n`** asserts the `en` and `zh` dictionaries have identical key sets, and
  that every `t('…')` literal in `app/` and `components/` exists. `translate()` falls back
  to returning the key itself, so a typo renders as literal `nav.signIn` on the page —
  visible to a human, invisible to the compiler.

### Browser audit and end-to-end chain

```bash
pnpm ux:audit:app        # renders the storefront at 1440x900 and 393x844, fails on defects
pnpm e2e:web             # register → verify → search → reserve → pay → ticket
pnpm ux:audit:reference  # the same audit against expedia.com (reports, never gates)
```

These are **not part of `pnpm verify`**: `verify` must stay deterministic and offline,
while this suite needs a running API and web server (and, for the reference spec, the
public internet). It checks for broken images, horizontal overflow, collapsed content and
unnamed controls, and distinguishes a same-origin asset that failed (a defect) from a
blocked third-party CDN (environmental). See
[`scripts/ux-audit/README.md`](./scripts/ux-audit/README.md) — it also lists the two real
defects this suite has already caught.

`schema-audit.sh` mechanises a failure mode this codebase kept hitting: a seed
or backfill writes a column, and no route ever reads it, so it reads like a
feature that exists. It parses `schema.prisma`, then checks every scalar column
against the seeds that write it and the code under `apps/api/src` that reads it.
Foreign keys are excluded (Prisma often puts `@relation` on the following line),
as are relation fields and array filters. The run fails if it managed to inspect
implausibly few columns — a previous version silently checked zero and reported
success, which is the exact bug it exists to catch.

`mobile-check.sh` reads the **built** CSS at `apps/web/.next/static/css/*.css`, so run
`pnpm --filter @easytrip/web build` first. `next dev` deletes that directory, which is why
the check fails with "no built CSS found" if the dev server is the last thing that ran —
run the build, then `next start`.

---

## Mobile

The storefront is built mobile-first and targets iOS Safari and Chrome on Android.
`pnpm check:mobile` asserts the responsive layer survives future edits.

**One breakpoint scale.** 960 / 860 / 640 / 400 / 380px. Layout shells collapse at
**860px**, which is where a rail can no longer sit beside content without squeezing it.

**Page shells use `.with-rail`, not inline widths.** Every page pairs a main column with a
rail (filters, booking panel, order summary). The rail drops below the content on narrow
screens, defined in exactly one place.

**Cards stack rather than shrink.** Ticket passes put the QR above the details on a phone
and widen it to 160px — a gate scanner needs a big, high-contrast target.

**Touch targets are ≥44px.** Filter disclosure, tab rows and the mobile nav are all sized
for a thumb, not a cursor.

**16px inputs.** Anything smaller makes iOS Safari zoom the viewport on focus, which
strands the shopper mid-form.

**Zoom stays available** (`maximum-scale=5`). Pinching to read a booking reference is a
real need; accidental zoom is prevented with `touch-action` instead of by blocking pinch.

**Notched devices.** The sticky booking CTA adds `env(safe-area-inset-bottom)` padding, so
the primary action never sits under the home indicator.

**No sideways scroll.** `overflow-x: hidden` is a backstop only — wide tables scroll inside
`.table-scroll` and long strings use `overflow-wrap: anywhere`, so content is never
trapped off-screen.

**Accessible.** Skip link, `:focus-visible` rings, `aria-expanded` on both disclosures,
and full `prefers-reduced-motion` support.

**JS stays optional where it can.** The filter form is a plain server-rendered
`<form method="get">`; only the collapse behaviour needs JavaScript, and it degrades to
always-open if the script never loads.

---

## Configuration

Everything is environment-driven with working defaults; see `.env.example`.

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://easytrip:easytrip@localhost:5432/easytrip` | |
| `REDIS_URL` | `redis://localhost:6379` | Falls back to memory if absent |
| `PAYMENT_PROVIDER` | `mock` | `hyper` for Hyperswitch |
| `INVENTORY_HOLD_MINUTES` | `15` | Checkout hold TTL |
| `MARKUP_BPS` | `1200` | Platform markup, in basis points |
| `OPENSEARCH_URL` | — | Empty ⇒ Postgres FTS |
| `S3_ENDPOINT` / `S3_BUCKET` | — | Empty ⇒ local disk |
| `JWT_SECRET` | dev value | **Must** be set in production |

---

## License

MIT.
