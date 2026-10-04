import { readCsv } from '../../utils/csv';
import type {
  ExternalRef,
  SupplyAvailability,
  SupplyDestination,
  SupplyOrigin,
  SupplyProduct,
  SupplyRate,
  SupplySource,
} from './source';

/**
 * ---------------------------------------------------------------------------
 * OurAirports
 * ---------------------------------------------------------------------------
 *
 * Real airports with real coordinates, from
 * `github.com/davidmegginson/ourairports-data` (public domain).
 *
 * Chosen as the first adapter because it is genuinely useful and genuinely
 * public: unlike Overture or OSM it carries no share-alike obligation, so
 * importing it does not constrain how this database is redistributed.
 * `docs/supply-sources.md` records that reasoning, and it is why this dataset
 * is the one wired up rather than the richer ones.
 *
 * Identity and geometry only. There is no price and no seat count in this file,
 * and inventing either would be worse than deriving it — see
 * {@link getRates} and {@link getAvailability}.
 */

export const OURAIRPORTS_URL =
  'https://davidmegginson.github.io/ourairports-data/airports.csv';

/** Public domain: attribution is appreciated, not required. */
const LICENSE = 'public-domain';

/**
 * Upstream record types, as documented at
 * `https://ourairports-data.readthedocs.io/en/latest/airports.html`.
 *
 * The 86k-row extract splits into `small_airport` (42.8k), `heliport` (23.2k),
 * `closed` (13.6k), `medium_airport` (4.1k), `seaplane_base`, `large_airport`
 * (1.2k) and `balloonport`. All three `*_airport` sizes are real airports —
 * matching on the literal type `airport`, which is not a value this dataset
 * ever uses, filtered out all 86158 rows and made the import report a silent
 * zero.
 *
 * `heliport` / `balloonport` / `seaplane_base` are excluded even though many
 * carry a valid IATA code: none is somewhere a traveller books a flight to.
 * `closed` is excluded because a closed airport in a live booking path is an
 * outage waiting to happen.
 */
const BOOKABLE_TYPES = new Set(['small_airport', 'medium_airport', 'large_airport']);

export class OurAirportsSource implements SupplySource {
  readonly id = 'ourairports';
  readonly origin: SupplyOrigin = 'OPEN_DATASET';
  readonly license = LICENSE;

  constructor(private readonly url: string = OURAIRPORTS_URL) {}

  /**
   * Every airport that has a scheduled service.
   *
   * `scheduled_service` is upstream's own flag for "has regular airline
   * service", which is the closest thing to "a place a traveller could fly to"
   * and is a better filter than airport type alone — plenty of `airport` rows
   * are private strips with a code and no service.
   */
  async *listDestinations(): AsyncIterable<SupplyDestination> {
    for (const row of await this.fetchRows()) {
      const iata = (row.iata_code ?? '').trim().toUpperCase();
      if (!iata) continue;
      if (!BOOKABLE_TYPES.has(row.type)) continue;
      if ((row.scheduled_service ?? '').trim().toLowerCase() !== 'yes') continue;

      const latitude = Number.parseFloat(row.latitude_deg ?? '');
      const longitude = Number.parseFloat(row.longitude_deg ?? '');
      const isoCountry = (row.iso_country ?? '').trim().toUpperCase();

      yield {
        ref: { sourceId: this.id, externalId: `airport:${iata}` },
        name: (row.name ?? iata).trim(),
        countryCode: isoCountry.length === 2 ? isoCountry : null,
        // A coordinate that failed to parse must not be written as 0: that is
        // Null Island in the Gulf of Guinea, and it would silently pass any
        // "is this in Europe" filter.
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
      };
    }
  }

  /**
   * Airports carry no product identity — an airport is where a flight goes,
   * not something sold. This yields nothing by design; a caller that needs
   * products must pair this source with one that sells them.
   */
  async *listProducts(): AsyncIterable<SupplyProduct> {}

  /** Always empty: this dataset has no prices. Derive them with `modules/pricing`. */
  async getRates(_ref: ExternalRef): Promise<SupplyRate[]> {
    return [];
  }

  /** Always empty: this dataset has no seat counts. Derive them with `modules/inventory`. */
  async getAvailability(_ref: ExternalRef, _from: string, _to: string): Promise<SupplyAvailability[]> {
    return [];
  }

  /** IATA and ICAO codes the importer needs but {@link SupplyDestination} does not carry. */
  async *listAirportCodes(): AsyncIterable<SupplyAirportCodes> {
    for (const row of await this.fetchRows()) {
      const iata = (row.iata_code ?? '').trim().toUpperCase();
      if (!iata) continue;
      if (!BOOKABLE_TYPES.has(row.type)) continue;
      if ((row.scheduled_service ?? '').trim().toLowerCase() !== 'yes') continue;

      const icao = (row.icao_code ?? '').trim().toUpperCase();
      yield {
        iata,
        icao: icao.length === 4 ? icao : null,
        municipality: (row.municipality ?? '').trim() || null,
        name: (row.name ?? iata).trim(),
      };
    }
  }

  private async fetchRows(): Promise<Record<string, string>[]> {
    const response = await fetch(this.url);
    if (!response.ok) {
      throw new Error(`ourairports: HTTP ${response.status} for ${this.url}`);
    }
    return [...readCsv(await response.text())];
  }
}

/**
 * Row shape the importer needs beyond the generic {@link SupplyDestination}.
 *
 * Kept separate rather than widening `SupplyDestination`: `icaoCode` and
 * `municipality` are airport-specific, and putting them on the shared interface
 * would force every future source to answer questions only airports have.
 */
export interface SupplyAirportCodes {
  iata: string;
  icao: string | null;
  municipality: string | null;
  name: string;
}