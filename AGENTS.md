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
| `apps/api/src/modules/<domain>/` | Business logic: `pricing`, `inventory`, `booking`, `payments`, `ticketing`, `search`, `realtime`, `mail`, `wallet`, `support` |
| `apps/api/src/utils/` | Money, IDs, crypto, JWT, Redis, errors, dates — use these, don't hand-roll |
| `apps/api/src/plugins/auth.ts` | Authentication + role gates (`requireRole`) |
| `apps/api/prisma/schema.prisma` | ~60 models, single source of truth |
| `apps/web/src/app/` | Storefront + `(console)/admin` + `(console)/support` routes |
| `apps/web/src/lib/` | `api.ts` (typed client), `session.ts`, `i18n/`, `realtime.ts` |
| `scripts/` | `smoke-test.sh`, `realtime-test.mjs`, `mobile-check.sh`, `schema-audit.sh`, `check-images.mjs`, `check-i18n-keys.mjs` |
| `scripts/ux-audit/` | Playwright render audit + end-to-end chain (see its `README.md`) |
| `apps/api/prisma/live-contract-check.ts` | Offline live-rate contract gate (`pnpm supply:contract`) |
| `apps/api/prisma/auth-contract-check.ts` | Offline email-verification gate (`pnpm auth:contract`) |
| `apps/api/prisma/support-chat-contract-check.ts` | Offline chat-authorization gate (`pnpm support-chat:contract`) |

## Commands

```bash
cp .env.example .env && pnpm install
pnpm setup        # docker compose up + prisma generate/push + seed
pnpm dev          # API :4000, web :3000
pnpm verify       # typecheck → schema audit → i18n keys → contracts → smoke → realtime → mobile (the real gate)
pnpm typecheck    # both packages
pnpm audit:schema # flags columns written but never read
pnpm check:images # every seed image URL must answer 200
pnpm check:i18n   # en/zh key parity, and no dangling t('…') keys
pnpm ux:audit:app # browser render audit (needs api + a built web on :3000)
pnpm e2e:web      # register → verify → search → reserve → pay → ticket
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
  against the current code passes. Recorded baseline (2026-10-07): smoke **102/102**,
  realtime **20/20**, mobile **41/41**, `pnpm verify` exits **0**.
- **Browser work needs a production build and a raised rate limit.** `pnpm ux:audit:app`
  and `pnpm e2e:web` require the API plus `next start` on :3000 (not `next dev`, which
  serves unstyled HTML for audit purposes and wipes `.next`). Start the API with
  `RATE_LIMIT_MAX=5000` — a browser pass makes far more requests per minute than a human
  shopper, and the resulting 429s look like product bugs. See
  [`scripts/ux-audit/README.md`](./scripts/ux-audit/README.md).
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
- **Exactly two staff roles, and two staff consoles.** `ADMIN` (`/admin`) and `SUPPORT`
  (`/support`). `OPERATOR` and `MERCHANT` were retired — gate scanning is an ADMIN
  capability and a partner merchant is a *data model*, not a permission. A new staff
  capability belongs on one of the two surfaces; see
  [`docs/adr/0002-two-staff-surfaces.md`](./docs/adr/0002-two-staff-surfaces.md).
- **The API never sends display copy.** It returns a stable *code* (e.g.
  `SearchBadgeCode`) and the dictionaries decide how to say it — otherwise hard-coded
  English lands on Chinese pages. Same rule for anything a shopper reads.
- **i18n:** `en` is the source of truth, `zh` is validated with
  `satisfies Record<LocaleCode, typeof en>` in `apps/web/src/lib/i18n/dictionaries.ts`.
  No `as const` on `en`, no type annotation on `zh`. Values may be functions (pluralisation).
  Run `pnpm check:i18n`: `translate()` returns the *key* on a miss, so a typo ships as
  literal `nav.signIn` on the page and no compiler will catch it.
- **Seed image URLs must be reachable.** Run `pnpm check:images` after touching seed
  media — 13 of 61 URLs had silently 404'd, which is why tiles rendered as grey boxes.
- **Native controls follow the *browser* locale, not the page.** A `<input type="date">`
  needs `lang={htmlLang(locale)}` or an English page shows `年月日` in a Chinese-locale
  browser. See `apps/web/src/lib/i18n/config.ts`.
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
| `.github/skills/apify-toolkit/SKILL.md` | Router for the 28 globally installed Apify skills — pick the right one before scraping |
| `.github/agents/easytrip-verifier.agent.md` | Implement + prove a change against the real gates |
