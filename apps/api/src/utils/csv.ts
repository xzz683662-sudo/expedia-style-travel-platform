/**
 * ---------------------------------------------------------------------------
 * RFC 4180 CSV reader
 * ---------------------------------------------------------------------------
 *
 * The supply import reads open datasets (OurAirports and friends) that ship as
 * CSV, and none of them quote consistently: OurAirports quotes every field,
 * GeoNames quotes only when the value contains a comma, and a city called
 * `Côte d'Ivoire` or an airport called `Haikou, Meilan` will break a naive
 * `split(',')`.
 *
 * A streaming reader, because the full OurAirports extract is ~12MB / 76k rows
 * and a country import must not materialise it. `readCsv` is a generator so a
 * caller can stop as soon as it has what it needs.
 *
 * Kept here rather than pulled from npm: the whole surface is 60 lines, and a
 * supply import is exactly where a subtly-wrong parser would silently corrupt
 * every row it touches.
 */

/** One parsed record: column name -> value. Unquoted values stay strings. */
export type CsvRow = Record<string, string>;

/**
 * Parse CSV text into rows keyed by the header line.
 *
 * Yields nothing for a file with no header. A short row yields `undefined` for
 * the missing columns rather than dropping it, so a malformed upstream row is
 * visible to the caller as a missing field instead of vanishing.
 */
export function* readCsv(text: string): Generator<CsvRow> {
  const rows = parseRows(text);
  if (rows.length === 0) return;

  const header = rows[0];
  for (let r = 1; r < rows.length; r += 1) {
    const values = rows[r];
    if (values.length === 1 && values[0] === '') continue; // trailing newline
    const row: CsvRow = {};
    for (let c = 0; c < header.length; c += 1) {
      row[header[c]] = values[c];
    }
    yield row;
  }
}

/**
 * Split CSV text into arrays of raw fields.
 *
 * Exported for tests; callers want {@link readCsv}.
 */
export function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAnyChar = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      sawAnyChar = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
      sawAnyChar = true;
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawAnyChar = false;
    } else if (char !== '\r') {
      field += char;
      sawAnyChar = true;
    }
  }

  // A file with no trailing newline still has a final row.
  if (sawAnyChar || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}