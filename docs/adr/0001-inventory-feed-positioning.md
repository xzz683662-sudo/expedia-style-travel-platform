# ADR-0001 — Inventory feed positioning

- **Status:** Accepted (2026-10-06)
- **Deciders:** platform owner
- **Context doc:** the Apify Expedia Hotels integration design (this ADR is its Step 0)

## Decision

The inventory feed is implemented under **option A: scrape once, verify by hand,
sell as first-party.**

- A third-party hotel row is staged in `ScrapedInventory`. It is **not** a
  listing and **cannot** be sold.
- An operator **promotes** a chosen subset into real `Product` / `TicketType`
  records with our own copy and **our own price**, typed by hand.
- The promoted product is first-party. The README's scope note ("Products,
  inventory, prices and availability are first-party records") therefore **stays
  true and is not rewritten.**

Option B — a live supplier feed that syncs price and availability on a schedule
and sells directly — was **rejected for now**. It would require a supplier
agreement and a fulfilment path that the platform does not have, and rewording
the README's scope claim is a product decision with legal consequences, not an
engineering one.

## Why

Three facts made A the only honest choice.

1. **A scraped price is not a price we may sell at.** It is another company's
   displayed rate — stale by minutes, already marked up, and covered by no
   contract permitting resale. Selling it puts the platform on the hook for a
   stay it cannot confirm.
2. **Fulfilment is the blocker, not data.** The platform's promise is that a
   confirmed order means issued tickets: `INSTANT_TICKET`, a real
   `InventoryRecord` held and consumed, a signed QR. A scraped hotel can honour
   none of that. Under option A the operator owns the inventory they promote, so
   the promise stays honest.
3. **The failure modes are asymmetric.** A staging-only design cannot corrupt
   pricing. A direct-sell design can: writing a scraped value into
   `TicketType.basePriceCents` would (a) let a scraper bug become a pricing bug
   at scale, (b) undermine `computeQuote`'s guarantees, and (c) corrupt the
   `OrderItem` snapshots that explain what a customer actually paid.

## Consequences

- **The ingest job is inert with respect to the sellable path.** It writes only
  `ScrapedInventory`; it does not import `pricing/`, `inventory/` or `booking/`;
  and nothing that reads `Product` may read `ScrapedInventory`. This is enforced
  offline by `pnpm inventory:contract`, wired into `pnpm verify`.
- **Promotion is audited and priced by a human.** `promoteScrapedRow` requires an
  explicit `costCents`, records both the scraped figure and the chosen one in
  `AuditLog`, and creates the product as `DRAFT`.
- **Fulfilment defaults to `CONFIRMATION`.** A promoted row carries no supplier
  confirmation, so the platform must not promise instant issuance.
- **Staleness does not pause promoted products.** Once promoted, a product is
  first-party; a quiet feed is irrelevant to it. (Under option B this clause
  would invert — a stale feed would pause the product instead of selling an old
  price.)
- **The feature is flag-gated off.** `INVENTORY_FEED_ENABLED=false` makes the
  `/admin/inventory-feed` routes 404 and starts no scheduler, so the default
  platform is bit-for-bit unchanged.

## Open items

- **Live row-shape calibration is blocked by upstream rate limiting.** The
  permission gate is cleared (the actor was approved 2026-10-06), and the probe
  now starts, but every run fails the same way:

  ```text
  ☢️ Proxy: <http://groups-RESIDENTIAL@10.0.93.255> (REQUIRED)
  ❌ HTTP Error 429: Too Many Requests
  ```

  A 12-attempt hunt over 7 cities and 5 portals (2026-10-06) returned **12/12
  `429`**, at a total cost of **$0.0006** — which confirms the billing is per
  platform usage (residential proxy), **not per row**. The actor's own 30-day
  stats (`SUCCEEDED 29 / TOTAL 27214`, 0.107%) show this is its normal state,
  not a misconfiguration on our side.

  Consequences, both already in the code:

  1. The field mapping in `scraper.ts` stays tolerant, and the untouched payload
     is stored in `ScrapedInventory.raw`. A successful row can be captured later
     and the mapping trimmed then — **no re-scrape of stored data is needed**.
  2. `ingestCityBatch` retries per city and reports `perCity`, so a partial fill
     is a reportable outcome rather than a failed command.

  To retry the calibration when the limit lifts:
  `APIFY_TOKEN=… node scripts/feed-test.mjs` (writes `docs/feed-sample-row.json`)
  or `POST /admin/inventory-feed/scrape-batch`.

- **No scheduler was wired.** The first runs are manual
  (`POST /admin/inventory-feed/scrape`, `/scrape-batch`). A nightly timer is a
  follow-up once the manual path is trusted — a bad first run on a timer is a
  bad run every night, and this actor runs bad far more often than not.

## Legal / commercial note (not a technicality)

Scraping generally breaches a site's terms. Hotel photography is copyrighted —
link, do not copy onto our storage. Reviews carry personal data — reviewer
identity is stripped on the way in. If a supplier agreement is ever signed,
revisit this ADR under option B and update the README scope in the same change.
