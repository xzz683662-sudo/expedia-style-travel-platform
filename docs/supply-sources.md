# Supply sources

Registry for a first-party supply network: real geography and product identity
from open datasets, prices/availability synthesised by the pricing and inventory
engines. Booking reads only the canonical tables (`Product` / `TicketType` /
`InventoryRecord`) and never knows which source wrote a row.

`origin` maps to `InventorySource` (`PLATFORM` | `MERCHANT_FEED` | `MANUAL`) plus
the two added by this registry (`OPEN_DATASET`, `SYNTHETIC`).

## Implemented

`ourairports` is wired up. Everything else below is a candidate.

```bash
pnpm supply:import                      # full import, ~4,000 airports
pnpm --filter @easytrip/api supply:import -- --limit=500   # smoke run
```

| piece | where |
| --- | --- |
| adapter | `apps/api/src/modules/supply/ourairports.ts` |
| import job | `apps/api/src/modules/supply/import.ts` |
| CLI | `apps/api/prisma/supply-import.ts` |
| provenance | `SupplySourceRecord` (schema) |
| airport directory | `Destination` rows at `level = AIRPORT` |
| read API | `GET /api/v1/search/airports`, `GET /api/v1/search/airports/:iata/source` |

The import is idempotent: airports upsert on `iataCode` and provenance upserts on
`(sourceId, externalId)`, so a monthly refresh updates rows in place. It never
writes price or stock — those belong to `modules/pricing` and `modules/inventory`,
and an import that set them would silently override the pricing engine.

Imported airports are what make connection search useful beyond the hubs the
platform happens to sell: `/search/connections` can now be asked about an airport
with no inventory of its own.

## Sources

| id | data | repo / entry point | license | fields used | refresh |
| --- | --- | --- | --- | --- | --- |
| `ourairports` | airports, IATA/ICAO codes | `github.com/davidmegginson/ourairports-data` | public domain | `ident`, `iata_code`, `name`, `latitude_deg`, `longitude_deg`, `iso_country` | monthly |
| `openflights-routes` | airline route graph | `github.com/jpatokal/openflights` (`data/routes.dat`) | data ODbL, code AGPL | airline, src/dst IATA, stops | **DEAD — forbidden, see below** |
| `overture-places` | POIs (heavily deduped OSM + Meta + Microsoft + Amazon) | `github.com/OvertureMaps/overturemaps-py` | per-theme: CDLA-Permissive-2.0 / ODbL | `names`, `categories`, `geometry`, `addresses` | monthly (release) |
| `osm-pois` | POI, roads, transit | planet / `download.geofabrik.de`; `github.com/osm-search/Nominatim` | ODbL (share-alike) | tags by category | weekly |
| `fsq-os-places` | ~100M POIs w/ categories | `huggingface.co/datasets/foursquare/fsq-os-places` | Apache-2.0 | `name`, `category`, `latitude`, `longitude` | static release |
| `geonames` | places, admin hierarchy | `download.geonames.org/export/` | CC-BY 4.0 | `name`, `country_code`, `lat`, `lng`, `feature_code` | daily |
| `wikidata` | names, descriptions, images | `dumps.wikimedia.org`; `github.com/Wikidata/Wikidata-Toolkit` | data CC0 | labels, `P18` image, sitelinks | weekly |
| `gtfs-<agency>` | transit schedules | `github.com/MobilityData/mobility-database-catalogs` | per feed | stops, routes, trips | per feed |
| `holidays` | public holidays | `github.com/vacanza/holidays` | MIT | country, date, name | yearly |
| `faker` | synthetic names / addresses / contacts | `github.com/faker-js/faker` | MIT | names, addresses, phone | n/a |

## Origin semantics

| origin | written by | `ProductContract.commissionBps` |
| --- | --- | --- |
| `OPEN_DATASET` | import job from the table above | `0` (platform sells as principal) |
| `SYNTHETIC` | pricing + inventory engines | `0` |
| `PLATFORM` | in-repo seed | `0` |
| `MERCHANT_FEED` | external partner feed | from feed |

## Rules

- **`openflights-routes` is forbidden. Do not write an adapter for it.**
  Upstream states in its own `data.php`: *"The third-party that OpenFlights uses
  for route data ceased providing updates in June 2014. The current data is of
  historical value only."* The upstream was one person's server; it died, and
  OpenFlights has had no route updates since. The toolchain is still Python 2.
  `airports.dat` / `airlines.dat` *are* still refreshed — only `routes.dat` is
  dead — but a schedule without routes is not a schedule.

- **Never import a dataset whose freshness you have not verified against the
  source itself.** A "static" note in this table is not evidence. Read the
  upstream README, the file's last commit, or a freshness field. This rule
  exists because a route adapter was written against exactly that dataset before
  its deprecation notice was read.

- **Schedule, fare and seat inventory cannot come from open data at all.** They
  are regulated commercial assets airlines distribute through GDS/NDC partners;
  there is no free, licence-clean, commercially redistributable source. The
  architecture assumes this — `SupplyOrigin` carries `MERCHANT_FEED` and
  `SYNTHETIC`, and every open-data adapter returns `[]` from `getRates()` /
  `getAvailability()` with a comment saying the pricing and inventory engines
  derive those instead.

- `origin` is written at sync time and is queryable; it is never inferred at read time.
- Prices and availability are never imported — only identity and geometry. They are
  derived by `modules/pricing` and `modules/inventory`.
- A source's `license` is stored alongside its rows so attribution can be produced
  from data, not from memory.
- ODbL (OSM, OpenFlights) is share-alike: derived database must be redistributed
  under ODbL. Prefer Overture / FSQ / OurAirports where a permissive license fits.

## Real-time sources

A second kind of source, deliberately separate from the import registry above:
live query APIs that answer "where is this aircraft right now" and **never write
a row**. Positions are seconds-fresh and ephemeral — they live in a 30s Redis
cache and nowhere else, so no Prisma model, no seed, and no provenance table is
involved. Because nothing is stored or redistributed, upstream licence terms are
consumed transiently; **verify a source's terms before ever persisting or
redistributing its data.**

Adapter: `apps/api/src/modules/supply/realtime-flight.ts` (enumerated chain,
first source that answers wins, per-source failure falls through, all sources
down → 503). Read API: `GET /api/v1/search/flights/live?lat=&lng=&radiusNm=`
and `GET /api/v1/search/flights/:callsign/live`.

Every source below was probed live on **2026-10-04** before being wired in,
per the freshness rule above.

| id | data | endpoint | auth | verified |
| --- | --- | --- | --- | --- |
| `adsb-lol` | live ADS-B positions, registration, type, squawk | `api.adsb.lol/v2/callsign/{cs}`, `/v2/point/{lat}/{lon}/{radiusNm≤250}` | none | `/v2/point/51.47/-0.45/20` → 200, 9 aircraft, 6 with callsigns. `/v2/route/…` → **503** |
| `opensky-network` | live ADS-B state vectors | `opensky-network.org/api/states/all?lamin=…` (bbox) | none (anonymous quota) | HTTP 200, fresh bbox traffic; **fallback only** |
| `adsbdb` | registration → aircraft type, owner, photo | `api.adsbdb.com/v0/aircraft/{reg}` | none | HTTP 200 (`G-XLEA` → A380-841, British Airways). **Not usable for catalogue content** — see below |

Evaluated and **not** wired:

- `airplanes.live` — HTTP 403; access requires emailing them a project
  description first. Revisit if a second radius source is ever needed.
- `aviationstack` — alive but key-gated; the free tier is too small to be a
  dependable fallback.

## Live rate sources (commercial terms)

A third kind of source: **paid inventory and rates**. Adapter chain lives in
`apps/api/src/modules/supply/live-adapters.ts`, contract in
`modules/supply/live.ts`, and search consumes it via `applyLiveRates` in
`modules/search/service.ts`.

Every endpoint below was probed with `curl` on **2026-10-05**. The responses are
quoted verbatim because the difference between them is the whole story:

| id | endpoint | probed response | meaning |
| --- | --- | --- | --- |
| `kiwi.tequila` | `tequila-api.kiwi.com/v2/search?fly_from=SFO` | `403 {"error_code":403,"message":"'apikey' header is required"}` | **Alive, credential enforced.** Partner registration is by email magic link, not self-service |
| `amadeus` | `api.amadeus.com/v1/security/oauth2/token` | `200` + `{"errorCode":"15","description":"This request was blocked by our security service"}` | Endpoint exists, but the **self-service portal was decommissioned 2025-07-17**; access is now an enterprise sales agreement |
| `kiwi.v2` | `api.kiwi.com/v2/search` | `Could not resolve host` | No such hostname — the v2 API is not served there |
| `serpapi` | `serpapi.com/search?engine=google_flights&api_key=test` | `401 {"error":"Invalid API key…"}` | Alive, key-gated. Configured but **not wired** — see below |

### What `kiwi.tequila` does and does not do

Wired as the first adapter in the chain. It is a **metasearch aggregator**: its
prices are what Kiwi found across the OTA landscape, not stock this platform
holds. Three limits are load-bearing and must not be quietly dropped:

- **No availability.** Tequila publishes no per-date allotment, so
  `getAvailability` returns `[]` by design. `InventoryRecord` and
  `InventoryHold` remain the only authority on sellability. Inventing a capacity
  from a nightly price would sell seats nobody confirmed.
- **Sellability is `null`, never `0`.** Every offer reports "the source did not
  say". `bookable: false` is the one negative signal Kiwi gives, and only that
  becomes a real zero.
- **No confirmed booking.** A Tequila price moves the number the shopper is
  quoted. It does **not** create a supplier reservation, because no supplier
  relationship exists behind it. Tequila is not an inventory holder and must not
  be presented as one.

Prices enter as `computeQuote`'s `basePriceCents` — a cost, never a retail price —
so platform markup, tax and fee stay owned by `modules/pricing`.

### Why SerpApi is configured but not wired

`SERPAPI_API_KEY` is read by `config/env.ts` so the credential can be added
without a code change, but no adapter consumes it yet. It returns Google Flights
and Google Hotels results by scraping Google. That is technically straightforward
and commercially unclean: it is not an authorised redistribution channel, and
nothing in this repo's licensing currently permits it. Wiring it is a business
decision, not a technical one — record the decision here first.

### trvl — zero-key, and the only source measured to return real prices

`MikkoParkkola/trvl` (MIT, `v1.25.0`, cosign-signed single binary). Found via
`github.com/topics/flight-search`, after an earlier pass over the obvious names
had wrongly concluded nothing usable existed.

Measured on 2026-10-05 against the real binary:

```text
$ trvl flights JFK LHR 2026-11-15 --format json
  { "success": true, "count": 125,
    "flights": [{ "price": 244.64, "currency": "EUR",
                  "provider": "skiplagged", "legs": [...] }] }

$ trvl hotels "Tokyo" --checkin 2026-11-15 --checkout 2026-11-18 --format json
  { "count": 123, "total_available": 2428,
    "hotels": [{ "price": 42.37, "nightly_price": 42.37,
                 "taxes_and_fees": 23.91, "room_types": [...],
                 "image_url": "https://pix8.agoda.net/..." }] }
```

Prices vary by date on the same route (186.60 / 244.64 / 258.92 EUR for Oct /
Nov / Jan), so this is a real price structure rather than a fixture. Hotels also
carry a usable image URL, which answers the product-media question without
storing image URLs against products.

Four limits, all measured:

- **24.6 s per invocation.** Fatal inside a request. It is wired as a *pre-warm*
  source: `trvl-warmer.ts` runs it on a schedule and writes Redis;
  `trvl-source.ts` only ever reads that cache. A miss returns `[]`, so the
  shopper sees the seeded price.
- **`--currency` does not work.** Asked for USD, GBP, AUD or JPY it returned EUR
  every time at an identical price. The repo has no FX table, and `pickOffer`
  deliberately refuses to convert, so only EUR-selling routes are warmed —
  288 of 676 ticket types. Adding conversion here would mean the platform
  quietly acquiring FX it has never had, in the one place designed to reject it.
- **Terms.** The README states it is a personal-use tool and that "automated
  access may violate some providers' Terms of Service — you are responsible for
  compliance in your jurisdiction." `TRVL_ENABLED` therefore defaults to false.
  Telemetry is disabled on the child process (`TRVL_NO_TELEMETRY=1`) rather than
  left to the operator's memory.
- **No cruise.** There is a `ground` command covering bus, train and ferry, but
  no cruise search.

End-to-end proof (warmer → Redis → resolver), on a real EUR flight:

```text
✓ cold read: null (falls back to seeded price)
✓ warm: wrote cache entry
✓ warm read: {"netPriceCents":40089,"currency":"EUR","fromCache":true}
```

Reproduce with `prisma/verify-trvl-warm.ts`.

### Rejected after inspection

- **LetsFG** (2110 stars) — the most active project found, and wrong for this
  platform. It is a consumer affiliate site: onboarding requires connecting a
  card through a 0.00 Revolut setup, `letsfg.co` is "human-only by default"
  behind Cloudflare Turnstile, and booking captures a payment from the shopper.
  That is the affiliate model this project explicitly is not.
- **flightclaw** — hosted MCP at `mcp.flightclaw.com`. Every path (`/mcp`,
  `/sse`, `/api`, `/docs`, `/openapi.json`) returns 401. Needs a key, so it is
  not the zero-key option it is advertised as.
- **stayingapi/hotel-api** — 3 stars, last pushed 2026-07.
- **aviasales-mcp** — 13 stars, GPL-3.0. Its upstream was probed directly:
  `api.travelpayouts.com/v1/prices/cheap` → 401, `/v2/routes/latest` → 404.
- **OctoTrip/flights** — repository exists; not wired because the flightclaw and
  LetsFG results showed this niche is dominated by credentialed or affiliate
  endpoints, and an unverified MCP server is not worth the audit cost.

### Cruise

**No source is available, and none is stubbed.** Google has no cruise aggregator,
trvl has no cruise command, and each operator (Royal Caribbean, MSC, Carnival…)
sells through its own agency channel. `CRUISE` prices come from
`TicketType.basePriceCents` and search says nothing false about them. This is a
known gap, not an oversight — a per-operator scraper would cost far more in
maintenance than the category currently earns.

### Open endpoints carry no commercial terms

Re-probed alongside the above, all reachable, none usable for rates:

```text
opensky-network.org/api/states/all  -> 200 (positions)
api.adsb.lol/v2/point/...            -> 503 at time of check
api.open-meteo.com/v1/forecast      -> 200 (weather; no fare or allotment)
en.wikipedia.org/api/rest_v1/...     -> 200 (descriptive content only)
```

Content-real-time work uses the last two. They inform what a product page *says*,
never what it *costs* or whether it can be sold.

### What the content sources cannot answer

Two limits were established by probing, and both constrain what "live content"
can mean here. Neither is a bug to be fixed later; they are properties of the
data.

**`/v2/callsign/{cs}` answers only aircraft airborne *right now*.** Re-probed
2026-10-04: `DAL112` returns `200` with `total: 0`. A 200 proves the endpoint
is reachable, not that it resolved a flight. Seeded, historical and synthetic
callsigns legitimately return empty, and empty is a valid answer, not a fault.
**A live position is therefore an enrichment, never a join key** — the platform
must not depend on one to render a product.

**`adsbdb` is keyed on registration, which the catalogue does not carry.**
`FlightSegment` has no `registration` column; it stores `aircraft` as an IATA
type code (`B77W`) and `flightNumber` on only 12 of 40 rows. `adsbdb` accepts
neither. It is a useful research tool for enriching a *known* airframe and
cannot enrich this catalogue.

Where the platform does carry usable keys, the realistic join is geographic:
`Product.latitude` / `longitude` are populated for all 34 `FLIGHT` products, so
`near()` is the only content path with a real join. Note that the seeded
`marketingCarrierCode` and `flightNumber` disagree (e.g. carrier `BA` on flight
`EK001`), so callsign construction from catalogue columns is not reliable either.

Verified quirks that shape the chain:

- **OpenSky's anonymous `/states/all` ignores its `callsign` parameter.** The
  2026-10-04 probe with `?callsign=DAL112` returned unfiltered global states
  (Utah, India), not the requested flight. A fallback that returns the wrong
  aircraft is worse than no fallback, so OpenSky does not participate in the
  by-callsign chain — `adsb-lol` serves it alone, and its `/v2/callsign/{cs}`
  endpoint was verified to filter correctly.
- OpenSky answers a bounding *square*; the API contract is a circle, so the
  adapter applies a great-circle filter after the bbox query.
- adsb.lol's `alt_baro` is feet *or* the string `"ground"` — the normaliser
  branches on the type rather than trusting the number.
- adsb.lol refuses the runtime's default `User-Agent` (`node`) with HTTP 403
  "User-Agent too generic; include valid contact info" (verified 2026-10-04).
  The adapter therefore sends a project-identifying UA on every request;
  without it the primary source is unreachable and every query silently
  degrades to OpenSky's anonymous quota.

Real-time positions never feed pricing or inventory. Schedule, fare and seat
inventory remain governed by the rule above: they cannot come from open data,
and the pricing/inventory engines derive them.

## Interface

`apps/api/src/modules/supply/source.ts` defines `SupplySource`. One adapter per row
above. `booking/*` never imports it.
