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
| `openflights-routes` | airline route graph | `github.com/jpatokal/openflights` (`data/routes.dat`) | data ODbL, code AGPL | airline, src/dst IATA, stops | static (data ends 2014) |
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

- `origin` is written at sync time and is queryable; it is never inferred at read time.
- Prices and availability are never imported — only identity and geometry. They are
  derived by `modules/pricing` and `modules/inventory`.
- A source's `license` is stored alongside its rows so attribution can be produced
  from data, not from memory.
- ODbL (OSM, OpenFlights) is share-alike: derived database must be redistributed
  under ODbL. Prefer Overture / FSQ / OurAirports where a permissive license fits.

## Interface

`apps/api/src/modules/supply/source.ts` defines `SupplySource`. One adapter per row
above. `booking/*` never imports it.
