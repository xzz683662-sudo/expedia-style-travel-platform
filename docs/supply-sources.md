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
| `adsb-lol` | live ADS-B positions, registration, type, squawk | `api.adsb.lol/v2/callsign/{cs}`, `/v2/point/{lat}/{lon}/{radiusNm≤250}` | none | HTTP 200, second-level fresh traffic around London |
| `opensky-network` | live ADS-B state vectors | `opensky-network.org/api/states/all?lamin=…` (bbox) | none (anonymous quota) | HTTP 200, fresh bbox traffic; **fallback only** |
| `adsbdb` | registration → aircraft type, owner, photo | `api.adsbdb.com/v0/aircraft/{reg}` | none | HTTP 200 (`G-XLEA` → A380-841, British Airways); candidate, not wired |

Evaluated and **not** wired:

- `airplanes.live` — HTTP 403; access requires emailing them a project
  description first. Revisit if a second radius source is ever needed.
- `aviationstack` — alive but key-gated; the free tier is too small to be a
  dependable fallback.

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

Real-time positions never feed pricing or inventory. Schedule, fare and seat
inventory remain governed by the rule above: they cannot come from open data,
and the pricing/inventory engines derive them.

## Interface

`apps/api/src/modules/supply/source.ts` defines `SupplySource`. One adapter per row
above. `booking/*` never imports it.
