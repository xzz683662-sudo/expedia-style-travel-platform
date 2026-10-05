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

### API contract gotchas

- The `PaymentChannel` enum values are **UPPERCASE** (`CARD`). Sending `'card'` fails zod with 422.
- `api.login(body)` / `api.register(body)` take an object, not positional args.
- `/auth/me` returns `role` — frontend permission checks depend on it.
- `api.me()` includes a `transactions` array in the loyalty payload.

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

## Conventions

- Money goes through `apps/api/src/utils/money.ts`; IDs through `utils/ids.ts`; encryption via
  `utils/crypto.ts`; JWT via `utils/jwt.ts`; Redis via `utils/redis.ts`; errors via `utils/errors.ts`.
- Routes live in `apps/api/src/routes/*.routes.ts`; business logic in `apps/api/src/modules/<domain>/`.
- Auth/role gates are added in `apps/api/src/plugins/auth.ts` — check it before adding a new protected route.
- Prisma client singleton: `apps/api/src/lib/prisma.ts`. Env schema: `apps/api/src/config/env.ts`.
- Verify changes with `scripts/smoke-test.sh` (and `realtime-test.mjs` for the realtime module).
  `pnpm verify` runs typecheck → audit:schema → supply:contract → smoke → realtime → mobile in one shot and must exit **0**.
  Baselines re-verified 2026-10-04: typecheck clean on both packages, `audit:schema` reports
  "No dead columns found" (70 models / 542 scalar columns), smoke **92/92**, realtime **18/18**,
  mobile **40/40**.
