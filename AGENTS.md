# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

**EasyTrip** — an Expedia-style, *self-owned* travel marketplace (attractions, hotel
rooms, packages, transfers). `apps/api` is Fastify 5 + Prisma 5 + PostgreSQL;
`apps/web` is Next.js 15 App Router (RSC) + React 19. pnpm workspace.

The domain model, architecture decisions and the full API reference are in
[`README.md`](./README.md). Read it — don't re-derive it.

## Layout

| Path | What |
| --- | --- |
| `apps/api/src/routes/*.routes.ts` | HTTP routes (~75 endpoints), base `/api/v1` |
| `apps/api/src/modules/<domain>/` | Business logic: `pricing`, `inventory`, `booking`, `payments`, `ticketing`, `search`, `realtime` |
| `apps/api/src/utils/` | Money, IDs, crypto, JWT, Redis, errors, dates — use these, don't hand-roll |
| `apps/api/src/plugins/auth.ts` | Authentication + role gates |
| `apps/api/prisma/schema.prisma` | ~60 models, single source of truth |
| `apps/web/src/app/` | Storefront + `(console)/admin` + `(console)/support` routes |
| `apps/web/src/lib/` | `api.ts` (typed client), `session.ts`, `i18n/`, `realtime.ts` |
| `scripts/` | `smoke-test.sh`, `realtime-test.mjs`, `mobile-check.sh`, `schema-audit.sh` |
| `apps/api/prisma/live-contract-check.ts` | Offline live-rate contract gate (`pnpm supply:contract`) |
| `apps/api/prisma/live-contract-check.ts` | Offline live-rate contract gate (`pnpm supply:contract`) |

## Commands

```bash
cp .env.example .env && pnpm install
pnpm setup        # docker compose up + prisma generate/push + seed
pnpm dev          # API :4000, web :3000
pnpm verify       # typecheck → schema audit → live supply contract → smoke → realtime → mobile (the real gate)
pnpm typecheck    # both packages
pnpm audit:schema # flags columns written but never read
```

## Before you start

- **Load the repo playbook skill** — [`.github/skills/repo-playbook/SKILL.md`](./.github/skills/repo-playbook/SKILL.md).
  It is the source of truth for verified commands and hard-won pitfalls: Fastify
  synchronous `preHandler` hooks hanging, the Prisma CLI not seeing the root `.env`,
  `db push` blocking on its non-TTY data-loss prompt, nullable `@@unique` fields, treating
  a refund of `0` as "unset", uppercase `PaymentChannel` values, the `en`/`zh` dictionary
  shape, and `hoursBetween(a, b)` argument order. If your assumption conflicts with the
  playbook, re-read it rather than overriding it.
- **Verify before claiming done** — use the
  [`verify-the-change`](./.github/skills/verify-the-change/SKILL.md) skill, or the
  `EasyTrip Verify-the-Change` agent. A change is only complete when a real command
  against the current code. Recorded baseline (2026-10-04): smoke **92/92**,
  realtime **18/18**, mobile **40/40**, `pnpm verify` exits **0**.
- Onboarding mistakes are documented; repeating them wastes a whole session. Check the
  playbook before running anything unusual.
- Never run a terminal command in parallel with another terminal tool; batch only
  read-only file tools.

## Conventions

- **Money** is integer minor units plus an ISO currency; percentages are basis points.
  Route every amount through `apps/api/src/utils/money.ts`. A refund of `0` is valid — use
  a separate flag, never `=== 0` as an "unset" sentinel.
- **Prices never mutate.** An `OrderItem` snapshots the full pricing decision plus a
  `ruleTrace`; a later price change must never alter what someone paid.
- **Holds start at checkout, not carting.** Carts persist selections without blocking
  inventory; checkout places a TTL hold and a sweeper releases abandoned ones every 60s.
- **Routes stay thin**; domain logic lives in `modules/<domain>/`.
- **Auth gates** are added in `apps/api/src/plugins/auth.ts` — check it before adding a
  protected route.
- **i18n:** `en` is the source of truth, `zh` is validated with
  `satisfies Record<LocaleCode, typeof en>` in `apps/web/src/lib/i18n/dictionaries.ts`.
  No `as const` on `en`, no type annotation on `zh`. Values may be functions (pluralisation).
- **Schema/seed changes:** a column with a writer but no reader is this repo's recurring
  bug. Run `pnpm audit:schema` before declaring the work done.
- **Prisma CLI needs the root env explicitly:**
  `(cd apps/api && set -a && . ../../.env && set +a && npx prisma …)`, and pass
  `--accept-data-loss` for non-interactive `db push`.

## Customizations in this repo

| File | Use |
| --- | --- |
| `.github/skills/repo-playbook/SKILL.md` | Project facts, verified commands, pitfalls — load first |
| `.github/skills/verify-the-change/SKILL.md` | Verification workflow for any change |
| `.github/skills/live-supply-source/SKILL.md` | Onboarding a live rate source (trvl, Kiwi, partner feed) |
| `.github/agents/easytrip-verifier.agent.md` | Implement + prove a change against the real gates |
