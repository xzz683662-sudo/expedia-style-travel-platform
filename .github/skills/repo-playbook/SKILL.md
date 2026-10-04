---
name: repo-playbook
description: 'Workspace facts, verified commands, and hard-won pitfalls for the expedia-style-travel-platform monorepo (pnpm workspace: apps/api Fastify+Prisma, apps/web Next.js). Use when building, running, seeding, debugging, or deploying this project, when touching its Prisma schema, ticketing, payments, or i18n, or before starting any task in this repository.'
argument-hint: '[area, e.g. "prisma", "i18n", "ticketing"]'
user-invocable: true
---

# expedia-style-travel-platform — Playbook

Project-scoped companion to the global `~/.copilot/copilot-instructions.md`. Load when the task touches this repo.

## Layout

```
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

### Terminal
- The tool simplifies `cd X && cmd` and the real cwd does not change — wrap in `(cd /abs/path && cmd)`.
- Long inline `node -e` scripts display truncated but execute correctly.

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
  `pnpm verify` runs typecheck → smoke → realtime → mobile in one shot. Baseline as of
  2026-10-02: smoke **55/55**, realtime **18/18**, mobile **40/40**. `mobile-check.sh` reads the
  **built** CSS, so run `pnpm --filter @easytrip/web build` first (`next dev` deletes `.next`).