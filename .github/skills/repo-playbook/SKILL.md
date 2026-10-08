---
name: repo-playbook
description: 'Workspace facts, verified commands, and hard-won pitfalls for the expedia-style-travel-platform monorepo (pnpm workspace: apps/api Fastify+Prisma, apps/web Next.js). Use when building, running, seeding, debugging, or deploying this project, when touching its Prisma schema, ticketing, payments, or i18n, or before starting any task in this repository.'
argument-hint: '(area, e.g. "prisma", "i18n", "ticketing")'
user-invocable: true
---

# expedia-style-travel-platform — Playbook

Project-scoped companion to the global `~/.copilot/copilot-instructions.md`. Load when the task touches this repo.

## Layout

```text
apps/api    Fastify + Prisma + Zod, TypeScript, run via tsx (dev) / node dist (prod)
apps/web    Next.js App Router, TypeScript, Tailwind
scripts/    smoke-test.sh, preview.sh, realtime-test.mjs, mobile-check.sh
docker-compose.yml  postgres + redis
```

pnpm workspace (`pnpm-workspace.yaml`, `pnpm-lock.yaml`). Root `package.json` holds shared scripts.

## Before you run anything

1. `configure_python_environment` is irrelevant here — this is TypeScript. Use `run_task` / `run_in_terminal`.
2. Never run `run_in_terminal` in parallel with another tool; batch only read-only file tools.
3. Read `README.md` and the relevant `scripts/*.sh` before assuming a command shape.

## Cold start on a fresh workspace (verified 2026-10-04)

A workspace holding only the **root** `node_modules` (just `typescript`) cannot typecheck, and
`apps/api/tsconfig.json` reports `找不到"node"的类型定义文件`. That error is a **symptom, not the cause**.
Fix in this order — nothing compiles until the first three are done:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
(cd apps/api && set -a && . ../../.env && set +a && npx prisma generate)
docker compose up -d
(cd apps/api && set -a && . ../../.env && set +a && npx prisma db push --skip-generate --accept-data-loss)
(cd apps/api && set -a && . ../../.env && set +a && npx tsx prisma/seed.ts)
```

### An empty Prisma Client still *looks* generated

`node_modules/.prisma/client/index.d.ts` **exists** even when generation failed, because the
`@prisma/client` postinstall runs at the repo root where it cannot find `apps/api/prisma/schema.prisma`
and only warns about it. The stub is ~110 lines. Symptoms:

- `error TS2305: Module '"@prisma/client"' has no exported member '<AnyEnum>'`
- a flood of `TS7006: Parameter 'x' implicitly has an 'any' type` in route callbacks — Prisma delegate
  args lost their types, so every callback parameter degrades. Do **not** annotate them one by one.
- Check: `grep -c TicketStatus node_modules/.prisma/client/index.d.ts` → `0` means broken. A healthy
  client runs to tens of thousands of lines.

### `node-linker=hoisted`

`.npmrc` sets `node-linker=hoisted` + `shamefully-hoist=true`, so per-package `node_modules` stay
**empty** and everything hoists to the repo root. `apps/api/node_modules/@types/node` not existing is
correct here — look in the root `node_modules/@types/`.

### mobile-check needs a build and a server at the same time

`scripts/mobile-check.sh` asserts against the **built CSS** (`.next/static/css/*.css`) *and* **live
server-rendered HTML** (`WEB_URL`, default :3000). `next dev` deletes `.next` on boot, so dev mode makes
the script exit 1 with `no built CSS found` right after a successful build. Working sequence:

```bash
pkill -f 'next dev'; pkill -f next-server          # free :3000
(cd apps/web && rm -rf .next/types && pnpm --filter @easytrip/web build)
(cd apps/web && npx next start -p 3000 &)          # next start does NOT wipe .next
pnpm check:mobile
```

`000000` HTTP codes there mean **connection refused** (server not running), not a route regression.
smoke and realtime need :4000; mobile-check needs :3000 — start all three before `pnpm verify`.

**It reads *every* stylesheet, not the first one.** The script used to run
`ls .next/static/css/*.css | head -1`. Adding `next/font` made the build emit a second CSS
file (278 KB of `@font-face`) whose name sorts first, so **21 selector checks reported
"missing"** while nothing was broken. The signature of this trap: *every* CSS assertion
fails, but "built CSS present" passes with a suspiciously large byte count. It now cats
all of them into one scratch file — if you add another CSS-emitting plugin, that is the
line to keep correct.

### Long-running servers need `setsid`, not `nohup &`

`(setsid nohup <cmd> > /tmp/x.log 2>&1 < /dev/null &)` detaches the process from the terminal
session. Plain `nohup cmd &` does **not** — the child is still a job of the invoking shell and gets
reaped when that shell / agent turn ends, so the service silently dies and later checks report
`HTTP 000`. Never claim a server is "still running" without re-probing it in a *later* command;
assert the port, not the absence of an error.

### The build was never exercised

Dev runs on `tsx src/index.ts`, which type-checks on the fly and **never touches `outDir`**. So the
build script, the emitted `dist/` layout, and `pnpm start` can all be broken while every dev-mode
signal stays green. After changing `tsconfig.json`, `package.json#main`, or anything touching
module resolution, prove it end to end:

```bash
(cd apps/api && rm -rf dist && npx tsc -p tsconfig.json)
ls apps/api/dist/index.js && (cd apps/api && node -e "require('./dist/index.js')")
```

## Hard-won pitfalls (verified in this repo)

### Fastify

- `Fastify({ logger: false })` turns `request.log.error` into a no-op → silent 500s. The error
  handler in `apps/api/src/plugins/error-handler.ts` uses its own logger for this reason.
- A plugin added via `app.register()` must **not** be placed in `{ preHandler: [plugin] }`.
- **A synchronous `preHandler` hook hangs forever.** Fastify treats a sync hook returning `undefined` as
  callback-style and waits for a `done` that never arrives. Throwing still works, so the symptom is:
  unauthenticated requests return 401 instantly, authenticated requests hang with nothing in the logs.
  Fix: make the hook `async` (`requireRole()` already is). Fastest diagnosis:
  `curl -w "%{time_total}"` per endpoint to compare timings.

### dotenv / env

- Loading a non-existent `.env` fails **silently**; the error surfaces much later as Prisma's
  "Environment variable not found: DATABASE_URL". Resolve `.env` by walking up parent directories rather
  than hardcoding a relative depth — `__dirname` is the process cwd under `tsx` but the source dir under
  `node dist`.
- `.env.example` lives at the repo root.
- **The Prisma CLI cannot see the root `.env`.** The walk-up in `config/env.ts` is runtime-only;
  `prisma db push` resolves `env("DATABASE_URL")` itself and only looks at `apps/api/.env`.
  For CLI runs: `(cd apps/api && set -a && . ../../.env && set +a && npx prisma db push …)`.
- **`prisma db push` hangs in a non-TTY terminal** when it shows a data-loss warning
  (e.g. adding a `@unique` column): it blocks on `? Do you want to ignore the warning(s)?`
  with no output. Not a network problem. Always pass `--accept-data-loss` non-interactively.
- A **stale `tsx watch` from an earlier session can still own port 4000**. A fresh
  `pnpm dev:api` then logs `EADDRINUSE` while `/ready` returns 200 from the *old* build, so
  smoke tests can pass against stale code. `pkill -f 'tsx watch'` before restarting.

### Prisma 5

- `@@unique([a,b,c])` **cannot include a nullable field** — `c` is generated as non-null `string`.
  Workaround: `c String @default("")` and use `""` to mean "all day / no time slot"
  (code maps `?? null` → `?? ''`).

### Money / refunds

- A refund amount of `0` is a **valid** result. Never use `refundBps === 0 ? … : …` as an
  "not computed" sentinel — use a separate flag.
- The mock payment gateway must return `CAPTURED` (auto-capture model), otherwise `initiatePayment`
  never confirms the order.

### Currency: one settlement currency (USD), FX happens at resolve time

- The whole catalogue is USD. `seed-cities.ts` sets `currency: 'USD'` for all 34 cities and
  `seed-global.ts`'s `FX` table is `{ USD: 1 }`. Upstreams answer in *their* currency —
  trvl is EUR-only and ignores `--currency` (measured) — so `utils/fx.ts` converts.
- **Never rewrite `TicketType.basePriceCents`.** It is the price a *previous* order was
  priced against. Conversion belongs in `pickOffer` (offer currency → `query.currency`),
  and settlement stays in `TicketType.currency`.
- `seed.ts`'s `ticketType.upsert` must list `currency` in **both** `create` and `update`.
  It only had it in `create`, so changing the currency config and re-seeding left 288 rows
  in EUR — a seed that cannot re-apply its own config is not idempotent.
- Verify with `prisma.ticketType.groupBy({ by: ['currency'] })` → expect only `USD`.
- `cacheSet` writes are best-effort and return `void`; the warmer reads back to confirm.

### Live supply cache

- **A warmed entry must be exactly `LiveOffer[]`.** `LiveRateFinder.resolve()` reads the
  cache *before* consulting any source, so warmer rows are consumed verbatim. A row missing
  `sourceId` yields `quote.sourceId === undefined`, which silently reaches
  `SearchHit.live.sourceId` as null. Use the exported `TRVL_SOURCE_ID` / `TRVL_NATIVE_CURRENCY`.
- The warmer must key by the **settlement** currency (what the resolver asks with), while the
  stored row keeps the **upstream** currency (converted on read). Keying on EUR meant a USD
  request never found a warmed entry — a full cache and zero hits.
- `trvl dates` is single-origin only: a comma-joined origin returns 0 rows for 11–30 s.
  A same-airport route (`DXB→DXB`) cost 56 s for nothing. Both are filtered out.
- **`TRVL_BINARY_PATH` must be `existsSync`-checked.** It points into a scratch dir and
  `/tmp` does not survive a restart. A non-empty path that does not exist produced one
  `spawn ENOENT` per route per pass — 34 identical lines, 15 minutes apart. Note
  `execFile` reports a missing binary as a *callback error*, not a throw, so only a
  caller-side check prevents the storm.

### Search: Postgres is the engine; `pnpm db:indexes` owns the trigram indexes

- OpenSearch is **off by default** and behind `profiles: ["search"]`. If `OPENSEARCH_NODE`
  is non-empty but unreachable, *every* search request burns a failed round-trip and falls
  back. `config.search.enabled` is `Boolean(OPENSEARCH_NODE)`.
- The trigram indexes are **not in `schema.prisma`** (Prisma cannot express `gin_trgm_ops`
  or a functional index). They live in `apps/api/prisma/indexes.sql`, applied by
  `pnpm db:indexes`, wired into `pnpm setup`. `db push` will not remove them.
- `$executeRawUnsafe` rejects multi-statement SQL with
  `42601 cannot insert multiple commands into a prepared statement` — `apply-indexes.ts`
  splits on statement boundaries and tracks `$$` regions.
- `unaccent(text)` is STABLE, not IMMUTABLE, so an expression index needs the
  `search_unaccent()` wrapper or Postgres refuses to build it.
- Measured on 230 rows: `to_tsvector` was **54 ms vs 1 ms** for a plain trigram-backed
  `LIKE`, and `to_tsvector('simple', …)` cannot segment Chinese at all. FTS is a net loss
  here — see `docs/search-index-design.md`. Do not "upgrade" search to FTS without re-measuring.
- **`CANDIDATE_LIMIT` caps how many results search can report, silently.** `total` is
  `Math.min(count, hits.length)`, and `hits` comes from a `take: CANDIDATE_LIMIT` query. At
  400 against a 468-product catalogue the last 70 listings vanished from *every* search,
  including an unfiltered one — no error, just a result count that stopped growing. The
  same class of bug as a `take` on `/destinations` (which hid Sydney and Melbourne). The
  constant is now 2000 and logs `search.candidates_truncated` if the catalogue outgrows it.

### Connections / flight schedules

- **`CONNECTING_ITINERARIES` is keyed by the exact route string**, so it only schedules the
  itineraries someone remembered to add. Generating routes against a hand-kept table drifts:
  three connecting products (`HKG→DXB→LAX`, `SIN→DXB→LAX`, `LAX→DXB→JFK`) were seeded with
  **null** leg times. `segmentsFor` now falls back to `synthesisedSchedule`, which derives a
  deterministic 5–13 h block time per leg and the same 3 h 25 m hub layover the table uses.
- **A null layover is not filterable, and that is a user-visible bug.** `withinLayoverBounds`
  deliberately passes an itinerary whose gap cannot be computed ("a filter the data cannot
  answer must not hide every result"), so a schedule-less itinerary survived
  `maxLayoverMinutes=1` — a shopper asking for a tight connection was shown a journey of
  unknown length. The smoke assertion `an impossible layover cap excludes everything` is what
  catches this; it fails with `(3 of 9)` when a connecting route has no times.
- **`routeSignature` must include the timestamps.** Comparing airports only treats "no times"
  and "times" as identical, so adding a schedule re-runs the backfill, reports the itinerary
  unchanged, and leaves the null legs in place. Same lesson as `segmentCount` vs airports:
  the comparison has to cover everything the fix changes.
- Repairing the extension tables does not need a full re-seed (which spends ~6 min on 214k
  inventory rows). `npx tsx prisma/backfill-extensions.ts` runs just the backfill; it is
  idempotent by comparison. Expect `{"flight":3,...}` for the case above.

### Ticketing

- Seeding with a raw `prisma.ticket.create()` skips `generateTicketArtifacts`, leaving QR/PDF `null`.
  Seed via the real issuer, plus the `backfillTicketArtifacts()` self-heal for old rows.
- Tickets are written under `apps/api/storage/tickets/TKT-XXXX-XXXX-XXXX/`.

### i18n (`apps/web/src/lib/i18n/dictionaries.ts`)

- `as const` on the `en` dictionary freezes literals and produces hundreds of type errors in `zh`.
  Recursive mapped types are worse (TS2536/TS2322/TS2345).
  The only working shape: **no `as const` on `en`**, **no type annotation on `zh`**, validated by
  `satisfies Record<LocaleCode, typeof en>`.
- Dictionary values may be functions; `t('key', n)` calls them — functions are required for correct
  pluralization and word order.
- **A missing key renders as its own name.** `translate()` falls back to returning the key string, so
  `t('nav.signIn')` (the real key was `common.signIn`) shipped the literal text `nav.signIn` to the
  page. `tsc` cannot see it — the key is an opaque string at the call site. Run `pnpm check:i18n`,
  which also asserts `en`/`zh` have identical key sets.
- **The API must not send display copy.** `search/service.ts` returned
  `badge: 'Priority entry'`, which put English words on Chinese cards. It now returns a closed union
  (`badgeCode: SearchBadgeCode`) that the dictionaries translate. Anything a shopper reads follows
  this rule.
- **Native controls follow the *browser* locale.** `<input type="date">` shows its format placeholder
  in the browser's language, so an English page in a `zh-CN` browser rendered `yyyy/mm/日期`. The fix
  is `lang={htmlLang(locale)}` on the input (`lib/i18n/config.ts`); verified in Chromium that
  `lang="en-US"` yields `yyyy/mm/dd`. To reproduce, set the app locale by cookie *and* the browser
  locale separately — otherwise the whole page turns Chinese and the case disappears.

### Seed media (`apps/api/prisma/seed-*.ts`)

- **A hard-coded image URL is an unchecked URL.** 13 of 61 `images.unsplash.com/photo-<id>` links had
  silently 404'd, which is why destination tiles rendered as grey boxes for the life of the project.
  Nothing in `tsc`, smoke or realtime could see it. Run `pnpm check:images` after any seed-media edit.
- The container *can* reach the image hosts, so a 404 is a data bug, not a network one.
- Replacements come from Wikipedia. **Never hand-build a Wikimedia thumb URL** — the host, hash path
  and width segments must be exactly what the API issued (`thumb.wikimedia.org/.../1280px-<File>`);
  a hand-written `upload.wikimedia.org/.../1200px-<File>` returns 400.
  `scripts/resolve-replacement-images.mjs` resolves *and* verifies.
- **A failed image is not just a hole.** Cards that overlay text on a photo become unreadable when
  the photo never loads (white text on the light-grey card). `.product-media` and
  `.destination-media` back their images with a dark background plus a gradient scrim for this
  reason, and `SafeImage` swaps in a fallback rather than showing a broken-image icon.
- **No two products may share a photograph, and `pnpm check:media` enforces it.** The catalogue
  used to draw every product from a pool of **three or four** images per category: 459 media rows
  held 62 distinct URLs, and one Rome Colosseum frame was on 30 cards. `seed-global.ts`'s
  `claimImage` now hands each image out **at most once** across the whole catalogue, drawing from
  `photo-pools.ts` (per category) and `city-images.ts` (per city). If a pool runs dry `claimImage`
  **throws** — a silent wrap-around is exactly how the original duplication got in, so grow the
  pool with `pnpm images:build` instead of loosening the check.
- **`pnpm images:build` needs throttling and retries, and that is not optional.** Wikimedia
  rate-limits anonymous clients. Without a pause the later categories came back with **zero**
  candidates — the API had started answering `429` and the build read it as "no results", which is
  how a pool can silently end up empty while looking like it succeeded. `jsonFetch` now pauses,
  honours `Retry-After`, and retries `429`/`5xx`; keep it that way.
- **A pool saturates long before its target.** Commons caps one search response, so the pool grows
  by following the API's `gsroffset` cursor (`PAGES_PER_QUERY`), not by asking for a bigger page.
  With ~20 terms per category, 6 pages each and a 2 MP floor the yield is ~2,300 images; the
  subject de-duplication (`subjectKey`) is what stops a batch upload of one scene filling the pool.
- **Place categories are illustrated from the city; thing categories from the category.**
  `GUIDED_TOUR` / `ATTRACTION_TICKET` / `ACTIVITY` show a *place*, so they take that city's own
  photographs first (a Paris attraction must not show a Roman amphitheatre). `FLIGHT` /
  `HOTEL_ROOM` / `CRUISE` show a *thing*, so the city is irrelevant.
- **A generated product carries one image, not a gallery.** The pool of genuinely distinct,
  correctly-licensed photographs is bounded and `claimImage` refuses to reuse one — one unique
  picture is worth more than two that repeat something else. `catalogue-report.ts` asserts *one*
  for this reason; it used to demand two, which is the shape the duplication came from.
- **Hand-authored galleries are de-duplicated at load time, not by hand.** `dedupeFeaturedMedia`
  in `seed-products.ts` keeps the first use of each picture and swaps any later one for the next
  unused photograph *of the same city*. The nine offending slots appear in `FEATURED_PRODUCTS`
  because their images were chosen individually over a long period; patching them by hand would
  leave the trap for the next edit.
- **The home page must not show one product twice.** The rails are independent queries
  (`trending` by popularity, `top-rated` by rating, two by nothing), so they overlap freely — one
  product came first in all four and its photograph appeared four times down the page. `page.tsx`
  claims each product for the first rail that renders it. Verify with
  `node scripts/ux-audit/verify-home-images.mjs`, which reads the **rendered DOM** at both
  breakpoints; counting `<img>` tags in the server HTML only proves the markup, not the page.

### Catalogue scale: `LISTINGS_BY_TIER` and the name rotation

- **Cities are sized by tier, not uniformly.** `LISTINGS_BY_TIER` in `seed-global.ts` gives a
  global capital ~80 listings and a small town ~34, which is what makes a city page feel stocked.
  `CITY_TIER` maps each slug explicitly — an index-based split off `CITIES` is possible but wrong,
  because that array is grouped by *region*, so it would put Bath in the top tier and Tokyo in the
  bottom. A city missing from `CITY_TIER` **throws** rather than silently building at zero.
- **Every name template list must be at least as long as the largest tier's count for that
  category.** `pickDistinct` rotates a list by the ordinal, so a 4-entry `HOTEL_NAMES` against 16
  hotels wrapped and named three Paris hotels "Paris Palace — Premier Suite". `FLIGHT_NAMES` now
  has 6 entries for this reason, and `SETTINGS` has 20. `catalogue-report.ts` fails on a duplicate
  name within one city+category, which is the assertion that catches this.
- **Rotate on a *fixed per-city base*, never on a per-listing seed.** `pickDistinct(list, family, n)`
  is a rotation and cannot collide; `pickDistinct(list, seedIncludingOrdinal, n)` is n independent
  hashes and can. The same mistake on the cruise departure month produced two identical sailings
  out of one city.
- **A second axis must rotate slower than the first.** Flights rotate the carrier on the ordinal
  and the hub once per full carrier cycle (`Math.floor(ordinal / carriers.length)`), giving
  `carriers × hubs` distinct pairs; rotating both on the ordinal gives only `coprime` pairs.
- **When a name genre runs out of variation, add a *real* discriminator.** A cruise is a dated
  departure, so its name carries a sailing month; pretending otherwise means inventing numbers.
- Seeding 1,715 products writes ~5,100 ticket types and ~780k inventory rows, so a full
  `db:seed` takes tens of minutes. `npx tsx prisma/backfill-extensions.ts` repairs the category
  extension tables without paying that cost.

### API contract gotchas

- The `PaymentChannel` enum values are **UPPERCASE** (`CARD`). Sending `'card'` fails zod with 422.
- `api.login(body)` / `api.register(body)` take an object, not positional args.
- `/auth/me` returns `role` — frontend permission checks depend on it.
- `api.me()` includes a `transactions` array in the loyalty payload.
- **`Payment.orderId` is required**, so a standalone charge has nowhere to live. A wallet top-up
  therefore *cannot* reuse the order payment path; it is a `WalletTransaction` (`TOP_UP` /
  `WITHDRAWAL`) written by `modules/wallet/ledger.ts`, the single place a balance changes. Attaching
  a card charge to a top-up is a payments-rail integration, not a wallet concern.
- `postWalletEntry` rejects a zero amount and refuses to go negative (a negative balance reads as
  "the shopper owes us", which the storefront cannot explain or settle).

### Support chat (`modules/support/chat.ts`)

- A load must state its perspective:
  `getConversationWithMessages({ as: { kind: 'customer', userId } | { kind: 'staff' } })`. The
  customer branch filters by `userId`, so a guessed id returns 404 rather than another shopper's
  thread. `pnpm support-chat:contract` asserts this offline.
- Realtime **pushes**; Postgres **records**. The socket (`support.message`, addressed to
  `user:<id>` and `role:SUPPORT|ADMIN`) only refreshes the UI — a reload re-reads the same rows.
- Unread counters live on the conversation and are maintained on write, so the widget badge and the
  console queue are one indexed read rather than a `COUNT(*)` over messages.

### Storefront CSS

- **Do not overlay text on a card photo.** `.product-ribbon` (a white label) sat on
  `.product-media`; mobile media is **96×96** while the ribbon stayed 88×44, so it covered **42%**
  of the image across three wrapped lines (desktop: 7%). It was removed rather than restyled — the
  same fact is now a chip in the card body, legible at every width and never hiding the image.
  Measure this rather than eyeballing it: `node scripts/ux-audit/diagnose-card-ribbon.mjs`.
- `.with-rail` switches to `flex-direction: column` below 860px and **must** also set
  `align-items: stretch`. Leaving the base `flex-start` sizes each child to its *max-content*, so a
  rail item containing a 7-column calendar computes ~540px on a 393px phone — and because `body`
  sets `overflow-x: hidden`, the excess is silently clipped instead of scrollable.
- `document.documentElement.scrollWidth` is useless as an overflow probe here for that same reason;
  measure `document.body.scrollWidth`.
- Bash history expansion eats `!` inside `node -e`. Write a `.mjs` file instead of fighting it.

### Next.js App Router

- A nested layout **cannot** render `<html>`.
- The root layout cannot hide header/footer per route — use `body:has(.marker)` CSS instead, and
  re-add any hidden functionality (e.g. the language switcher) in the new location.
- Stale route types in `.next/types` cause TS2307 — after changing routes run `rm -rf .next/types`.

### TypeScript

- `Record<string,string|undefined> & {page:number}` is invalid (index signature vs concrete property).
  Use `Record<string, string|number|undefined> & {page:number}`.
- `ignoreDeprecations: "6.0"` is a TS6 value and errors (TS5103) under TS 5.9.
- **`rootDir` must match `include`, and the emitted entry must match `package.json#main`.**
  `apps/api` now uses `rootDir: "src"` with `include: ["src/**/*.ts"]`, so the artifact is
  `dist/index.js` and `pnpm start` / `render.yaml`'s `startCommand` resolve correctly.
  When it was `rootDir: "."` with `prisma/**/*.ts` included, tsc emitted `dist/src/index.js`
  while `main`/`start` pointed at `dist/index.js` — **production start crashed** and nothing in
  dev ever noticed, because `tsx` runs `src/index.ts` directly. Prisma scripts are fine outside the
  build: `db:seed` and `supply:import` invoke them via `tsx`, and no `src/` file imports them.
- **`tsc` emits JS even when type errors exist** (`noEmitOnError` defaults to false). A script with
  `|| true` can therefore ship incomplete code. `apps/api` sets `noEmitOnError: true`.
- When enabling `noUnusedLocals` / `noUnusedParameters`, inspect each hit before deleting.
  An unused **interface parameter that implements a contract** (`capture(_id)` on a gateway) must be
  renamed with a leading underscore, not removed. Dead *values* are a different matter —
  `booking/engine.ts` computed `taxTotal`/`feeTotal` that were never read because the persisted
  `taxCents`/`feeCents` are re-derived per line against the **post-discount** base on purpose
  (never charge tax on money the customer did not pay). Deleting the two totals was safe; the
  comments claiming "all four totals must agree" were the misleading part.
- Prove a deletion is safe by **exhaustively grepping the pre-change file**, not by reading the
  nearby lines: `git show HEAD:<path> | grep -n '<symbol>'`. A symbol appearing only on its
  declaration lines across the enclosing function's full range is genuinely unread.
- `incremental` + `--noEmit` (the `typecheck` script) does **not** speed up typechecking — tsc still
  re-analyses the program. The cache mainly pays off for emit builds. `tsBuildInfoFile` must live in
  the `exclude`d `outDir` so it never lands in git. Note `apps/web/tsconfig.tsbuildinfo` is
  **tracked** by the Next.js template — pre-existing repo noise, not something to "fix" casually.
- Probe an option's real effect rather than trusting it: append a deliberate
  `const __probe: number = "x"` to a source file and confirm `noEmitOnError` yields exit 1 **and no
  emitted JS**, then restore. Remember to `grep -c __probe` afterwards so the probe cannot leak.

### Terminal

- The tool simplifies `cd X && cmd` and the real cwd does not change — wrap in `(cd /abs/path && cmd)`.
- Long inline `node -e` scripts display truncated but execute correctly.
- Seeding logs `search.index_push_failed {"reason":"fetch failed"}` once per product when the search
  engine is not running. **Non-fatal** — seeding still finishes with `seed.done`.

### Date/time helpers (`apps/api/src/utils/date.ts`)

- `hoursBetween(a, b)` returns `b - a` — always pass `(earlier, later)`. Reversed args make
  "N hours in advance" logic never match.
- `new Date(8_000_000_000_000_000)` exceeds the JS Date range (±8.64e15) → `Invalid Date` → `NaN`
  poisons a `reduce` seed value.

### Inventory feed (Apify Expedia Hotels — staged, never sold)

- **Positioning is option A: first-party.** Scrape → an operator promotes a row by hand into a
  real `Product` priced from *our* cost basis. The README's first-party scope note stands; see
  `docs/adr/0001-inventory-feed-positioning.md`. Do not change it without re-reading the ADR.
- **Blast radius, enforced rather than documented.** `modules/inventory-feed/scraper.ts` writes
  only `ScrapedInventory`. Nothing that reads `Product` may read `ScrapedInventory`, and the
  ingest module must not import `pricing/`, `inventory/` or `booking/`. `pnpm inventory:contract`
  asserts all of this offline and is wired into `pnpm verify`. It strips comments before the
  identifier checks — the rule is explained *inside the file it guards*, so a comment-blind
  grep would fire on the documentation of the rule itself.
- **A scraped price never becomes a sellable price.** `promoteScrapedRow` writes `costCents`
  (typed by a person) and `basePriceCents` from the request, never from the scrape; both the
  scraped and the chosen figures land in `AuditLog`. `computeQuote` stays the only pricing path.
- **`ScrapedInventory.raw` is the backup.** The untouched, PII-stripped payload is stored so a
  feed schema change is a mapping edit plus a backfill from `raw`, never a paid re-scrape. The
  field mapping in `scraper.ts` is tolerant on purpose while a live calibration is pending.
- **`externalId` is `String @default("")`, not nullable.** Prisma cannot put a nullable field in
  a `@@unique`; `""` means "the feed gave none", and those rows are skipped before insert.
- **The actor fails often and costs money.** Measured 30-day stats (2026-10-06): **29 succeeded
  of 27,214 runs (0.107%)**, and it needs `FULL_PERMISSIONS` (a run 403s until approved in the
  console). An empty dataset is a normal outcome — `ingestApifyHotels` returns `fetched: 0` and
  never throws on it. `maxRowsPerRun` caps a batch and the planned count is logged *before* the
  run starts.
- **No scheduler.** Runs are manual (`POST /admin/inventory-feed/scrape`) on purpose: a bad first
  run on a timer is a bad run every night. `POST /admin/inventory-feed/refresh-stale` is the
  explicit daily action instead of a tick on the 60 s sweeper.
- Routes 404 while `INVENTORY_FEED_ENABLED=false` — the flag *is* the rollback.
- **The index layer reads the staging table directly.** `ScrapedInventory.name` /
  `"citySlug"` carry trigram indexes in `prisma/indexes.sql`, so the admin search
  (`GET /admin/inventory-feed?q=`) resolves through the same `ILIKE`-backed plan as
  `SearchDocument` — no second store, no reindex. The column is `"citySlug"`, **not**
  `city_slug`: Prisma uses the field name verbatim and this schema has no `@map`.
  `SET LOCAL` outside a transaction is a no-op, so proving an index is used means
  running `SET` and `EXPLAIN` in one interactive transaction (`pnpm inventory:index`).
- **The actor is rate-limited to near-uselessness.** A live hunt measured **12/12
  `HTTP 429`** (Expedia throttling the actor's residential proxy), matching its own
  0.107% success rate. A single query is expected to fail, so population happens
  through `ingestCityBatch` (retries per city, reports `perCity`) — never a loop of
  one-shot calls. Billing is per platform usage, **not per row** ($0.0006 for 12 runs).

### Credentials: data-access vs transaction (never conflate)

- **Two different powers, audited separately.** `modules/supply/credentials.ts` classifies
  every source as `PUBLIC | API_KEY | SUPPLIER | BOOKING | SETTLEMENT`. The last two are
  *transaction* credentials. Reading a price is not permission to sell at it.
- **The stage boundary is a value, not a paragraph.** `STAGE_BOUNDARY` admits only
  `PUBLIC`/`API_KEY`/`SUPPLIER` for **read** use; `pnpm credentials:contract` (in `pnpm verify`)
  asserts **no enabled source can book or settle**, and that every transaction-capable source
  is marked unavailable — so "documented it" never drifts into "turned it on".
- **`available` is the line.** A source that is classed `BOOKING` but `available: false`
  (e.g. `cruise`) is *aspirational*: the class records what a real integration would need,
  which is not the same as having it.
- **Settlement rails refuse `live`; they do not merely lack config.** PayPal and TRC20
  adapters return `live_rail_out_of_scope` — a louder, more honest failure than an adapter
  that pretends to settle. Both are sandbox-only and selected per channel via
  `getGatewayForChannel()`.
- **Never store a card secret.** `PaymentMethod` holds a gateway token, a brand and the last
  four digits — no PAN, no expiry, no CVC. There is no such column and no such API field, and
  `pnpm credentials:contract` greps for both. TRC20 addresses are **base58check-validated**
  (double-SHA256), because an on-chain transfer is irreversible and a typo is a loss.
- **Account centre** (`/api/v1/account/*`, web `/account`): overview, saved methods CRUD,
  and a `payment-channels` endpoint that states each rail's `liveSettlement: false` as data.
  Support may list, set-default and **remove** a customer's method but never **add** one — an
  agent must not be able to introduce a payment credential.

## Conventions

- Money goes through `apps/api/src/utils/money.ts`; IDs through `utils/ids.ts`; encryption via
  `utils/crypto.ts`; JWT via `utils/jwt.ts`; Redis via `utils/redis.ts`; errors via `utils/errors.ts`.
- Routes live in `apps/api/src/routes/*.routes.ts`; business logic in `apps/api/src/modules/<domain>/`.
- Auth/role gates are added in `apps/api/src/plugins/auth.ts` — check it before adding a new protected route.
- Prisma client singleton: `apps/api/src/lib/prisma.ts`. Env schema: `apps/api/src/config/env.ts`.
- Verify changes with `scripts/smoke-test.sh` (and `realtime-test.mjs` for the realtime module).
  `pnpm verify` runs typecheck → audit:schema → supply:contract → inventory:contract → credentials:contract → smoke → realtime → mobile in one shot and must exit **0**.
  Baselines re-verified 2026-10-04: typecheck clean on both packages, `audit:schema` reports
  "No dead columns found" (70 models / 542 scalar columns), smoke **92/92**, realtime **18/18**,
  mobile **40/40**.
