-- ---------------------------------------------------------------------------
-- Search indexes for `SearchDocument`.
--
-- Why this is a `.sql` file and not a `@@index()` in schema.prisma
-- ---------------------------------------------------------------------------
-- Prisma cannot express these three things:
--
--   1. `gin (... gin_trgm_ops)`  — a trigram operator class
--   2. `unaccent(lower(title))`  — a functional index over an extension function
--   3. `create extension`        — Prisma does not manage extensions at all
--
-- So they live here, applied by `pnpm db:indexes` (idempotent — every statement
-- is `if not exists`/`or replace`), and wired into `pnpm setup`.
--
-- Why a trigram index and NOT a tsvector one
-- ------------------------------------------
-- Measured on this catalogue (230 rows, 2026-10-05):
--
--   to_tsvector('simple', title || ' ' || body) @@ to_tsquery(...)   ->  54 ms, Seq Scan
--   body LIKE '%私享向导%'  with a trigram index                     ->   1 ms, Bitmap Index Scan
--   title ILIKE '%x%'      with no index                             ->   1 ms, Seq Scan
--
-- The tsvector plan was *slower than no index at all*, because the expression
-- has to be recomputed over the whole `title || body` concatenation per row.
-- Worse, FTS cannot tokenise Chinese here at all:
--
--   to_tsvector('simple', '伦敦私享向导一日') = '伦敦私享向导一日':1
--
-- The entire string becomes one lexeme (it needs zhparser or PGroonga, which
-- Postgres does not ship). Since a Chinese shopper types a contiguous substring,
-- and `LIKE '%substring%'` is the definition of substring matching, the trigram
-- index is simultaneously simpler, faster, and correct for both languages.
--
-- See docs/search-index-design.md for the full evidence table.
-- ---------------------------------------------------------------------------

create extension if not exists pg_trgm;

-- `unaccent` is installed but NOT indexed by default: `unaccent(text)` is
-- STABLE, not IMMUTABLE (it reads a dictionary table), so an expression index
-- over it fails with "functions in index expression must be marked IMMUTABLE".
-- The wrapper below is the standard fix from the Postgres wiki. Only one row in
-- the catalogue carries a diacritic today (`Sagrada Família`), so if you would
-- rather not carry a wrapper function, querying with `unaccent()` and no index
-- is a defensible trade — it is 230 rows.
create extension if not exists unaccent;

create or replace function search_unaccent(text)
  returns text
  language sql
  immutable
  parallel safe
  strict
as $$ select public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- ---------------------------------------------------------------------------
-- The indexes themselves
-- ---------------------------------------------------------------------------
-- `title` is short and high-selectivity: the worst case for a Seq Scan and the
-- best case for a trigram index.
create index if not exists search_document_title_trgm
  on "SearchDocument" using gin (title gin_trgm_ops);

-- `body` is the workhorse. Every multi-word and every Chinese query resolves
-- through it, because the service matches all non-tag terms against `body`.
create index if not exists search_document_body_trgm
  on "SearchDocument" using gin (body gin_trgm_ops);

-- Diacritic-insensitive title matching: lets "Familia" find "Família".
create index if not exists search_document_title_unaccent_trgm
  on "SearchDocument" using gin (search_unaccent(lower(title)) gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Inventory feed: `ScrapedInventory` (staged third-party rows)
-- ---------------------------------------------------------------------------
-- The review queue and any operator search over staged rows resolve through
-- `name`, exactly like `SearchDocument.title` above — a plain `ILIKE '%term%'`
-- backed by a trigram index. This is the "index layer reads the database"
-- property: a row that lands in `ScrapedInventory` is searchable with no extra
-- pipeline, no search engine, and no reindex step.
--
-- Deliberately NO index over the scraped `priceCents`: a scraped price is
-- evidence, not a query dimension. Indexing it would invite sorting or
-- filtering a listing by it, which is the exact confusion the staging design
-- exists to prevent.
create index if not exists scraped_inventory_name_trgm
  on "ScrapedInventory" using gin (name gin_trgm_ops);

-- Operator search is usually scoped to a destination ("hotels in Amsterdam"),
-- so the city filter should not fall back to a scan once the catalogue grows.
-- Column is `citySlug`, not `city_slug`: Prisma uses the field name verbatim
-- unless a model opts into `@map`, and this schema does not.
create index if not exists scraped_inventory_city_trgm
  on "ScrapedInventory" using gin ("citySlug" gin_trgm_ops);

