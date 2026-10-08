/**
 * One-shot: replace the dead Unsplash ids in the seed with verified Wikimedia
 * images. Kept in the repo as the record of what was swapped and why.
 *
 *   node scripts/apply-image-fixes.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const THUMB = 'https://thumb.wikimedia.org/wikipedia/commons/thumb';

/** dead Unsplash id -> verified replacement */
const MAP = {
  // --- city hero images (seed-data.ts) ---
  '1563191911-e65f8654eb29': `${THUMB}/0/08/Roman_Baths_in_Bath_Spa%2C_England_-_July_2006.jpg/1280px-Roman_Baths_in_Bath_Spa%2C_England_-_July_2006.jpg`,
  '1591183418715-eb6220a79b73': `${THUMB}/9/97/Lyon-part-dieu-2023.jpg/1280px-Lyon-part-dieu-2023.jpg`,
  '1543429776-2782fc586c70': `${THUMB}/3/3a/Firenze_-_Piazzale_Michelangelo%2C_Firenze%2C_Italy_-_April_6%2C_2015_02.jpg/1280px-Firenze_-_Piazzale_Michelangelo%2C_Firenze%2C_Italy_-_April_6%2C_2015_02.jpg`,
  '1558452998-6a7e6c7dbd03': `${THUMB}/1/14/Madrid_-_Sky_Bar_360%C2%BA_%28Hotel_Riu_Plaza_Espa%C3%B1a%29%2C_vistas_19.jpg/1280px-Madrid_-_Sky_Bar_360%C2%BA_%28Hotel_Riu_Plaza_Espa%C3%B1a%29%2C_vistas_19.jpg`,
  '1531210483974-4f8c1e33b0d1': `${THUMB}/a/af/Altstadt_Z%C3%BCrich_2015.jpg/1280px-Altstadt_Z%C3%BCrich_2015.jpg`,
  '1531118367732-6becb73e0dfe': `${THUMB}/1/14/Goldswil-Viadukt_Panorama_mit_Interlaken_im_Hintergrund_2.jpg/1280px-Goldswil-Viadukt_Panorama_mit_Interlaken_im_Hintergrund_2.jpg`,
  '1516550893923-42d6c67c6b71': `${THUMB}/5/5b/Schoenbrunn_philharmoniker_2012.jpg/1280px-Schoenbrunn_philharmoniker_2012.jpg`,
  '1555881400-69c0c3f8ba1b': `${THUMB}/e/e5/Puente_Don_Luis_I%2C_Oporto%2C_Portugal%2C_2012-05-09%2C_DD_13.JPG/1280px-Puente_Don_Luis_I%2C_Oporto%2C_Portugal%2C_2012-05-09%2C_DD_13.JPG`,
  // --- product gallery images (seed-products.ts), matched to each alt text ---
  '1591557328080-9f0b4b2b3b0f': `${THUMB}/e/ec/Tower_of_London_from_the_Shard_%288515883950%29.jpg/1280px-Tower_of_London_from_the_Shard_%288515883950%29.jpg`,
  '1577083552431-6e5fd01988f5': `${THUMB}/d/d7/Florence%2C_Italy_-_panoramio_%28125%29.jpg/1280px-Florence%2C_Italy_-_panoramio_%28125%29.jpg`,
  '1583779457094-ab6f77f7bf57': `${THUMB}/e/ef/SF_maig_2_cropped.jpg/1280px-SF_maig_2_cropped.jpg`,
  '1515894347712-4d9164b20e94': `${THUMB}/2/2f/Hollywood_sign_%288485145044%29.jpg/1280px-Hollywood_sign_%288485145044%29.jpg`,
  '1518552718881-7f1813701a86': `${THUMB}/b/bf/Ocean_drive_day_2009j.JPG/1280px-Ocean_drive_day_2009j.JPG`,
};

const FILES = ['apps/api/prisma/seed-data.ts', 'apps/api/prisma/seed-products.ts'];

let total = 0;
for (const relative of FILES) {
  const path = resolve(ROOT, relative);
  let text = readFileSync(path, 'utf8');
  let changed = 0;

  for (const [id, replacement] of Object.entries(MAP)) {
    // Matches both the plain id and the `?w=1200&q=80` query suffix.
    const pattern = new RegExp(`https://images\\.unsplash\\.com/photo-${id}(\\?[^'"\\s]*)?`, 'g');
    const before = text;
    text = text.replace(pattern, replacement);
    if (before !== text) changed += 1;
  }

  if (changed > 0) writeFileSync(path, text, 'utf8');
  total += changed;
  console.log(`  ${changed > 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[2m•\x1b[0m'} ${relative} — ${changed} replaced`);
}

console.log(`\n${total} replacement(s) applied.`);
