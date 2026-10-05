---
name: live-supply-source
description: 'Onboard a new live travel supply source (flights, hotel rooms, cruise) into the EasyTrip API as a LiveRateSource adapter: qualifying a provider, choosing inline vs pre-warm, the settlement-vs-upstream currency cache contract, registry wiring, and end-to-end proof. Use when adding or replacing a rate source, wiring a paid or zero-key travel API (trvl, Kiwi Tequila, SerpApi, Amadeus, a partner feed), debugging a quote with a null or wrong sourceId, or when a live price never reaches search.'
argument-hint: '(source name or slug, e.g. "trvl" or "london-international-flight")'
user-invocable: true
---

# Onboard a Live Supply Source

Project-scoped workflow for the **live rate** layer. Load this before touching
`apps/api/src/modules/supply/`.

## When to use

- Adding, replacing, or evaluating a source that returns **real fares or rates**.
- A quote shows a null, a stale, or an unexpected `sourceId`.
- A warmed price exists in Redis but the shopper still sees the seeded price.
- Deciding whether a source can be called inline or must be pre-warmed.

## Not this skill

| Need | Go to |
| --- | --- |
| Airports, POIs, cities, holidays, names | `SupplySource` importer, `supply-import.ts` |
| Live aircraft positions / ADS-B | `realtime-flight.ts`, no pricing |
| Bug in an existing domain after the source is wired | [`verify-the-change`](../verify-the-change/SKILL.md) |
| Env/Prisma/Fastify surprises | [`repo-playbook`](../repo-playbook/SKILL.md) |

`docs/supply-sources.md` states the dividing line: **"Prices and availability are
never imported — only identity and geometry."** Never write a price into
`TicketType.basePriceCents`. That column is the price a previous order was priced
against.

## Load these first

1. [`repo-playbook`](../repo-playbook/SKILL.md) — `existsSync`, env, and currency traps.
2. `docs/supply-sources.md` — the mandate this skill implements.
3. [`verify-the-change`](../verify-the-change/SKILL.md) — for the final gate.

---

## Phase 1 — Qualify before you write a line of adapter code

This phase is **mandatory and blocking**. `docs/supply-sources.md`:

> Never import a dataset whose freshness you have not verified against the source
> itself.

A route adapter was once written against a dataset dead since 2014 because nobody
opened the deprecation notice. Probe, do not infer.

Record all five findings before coding. Each becomes a row in
`docs/supply-sources.md` and a comment in the adapter header.

| Question | How to answer it | Reject if |
| --- | --- | --- |
| Does it answer at all? | Probe the real endpoint, quote the raw response | Dead or 404 |
| Is it credentialed? | Probe without a key | Key-gated and unobtainable |
| What are the terms? | Read the upstream README, not a blog post | ToS forbids automated use |
| What is the licence? | SPDX string you can defend | Share-alike you cannot honour |
| **What does one call cost, really?** | Time the exact call shape you intend to ship | Anything that cannot sit inside a shopper's request budget |

Prefer a batched/calendar-shaped call over repeated single queries. This is often
a larger win than any adapter work: trvl went from **24.6 s for one date** to
**0.61 s for thirty dates** purely by changing the query shape, and the repo's
own conclusion is worth quoting — *"the constraint was never the provider's quota,
it was the shape of the query."*

Search breadth matters. GitHub `topics/flight-search` and `topics/travel-api` are
more productive than guessing vendor names — the first pass over the obvious
names wrongly concluded nothing usable existed, and trvl was found only via topic
search.

**Two tool traps that produced wrong conclusions before:**

- A web-fetch tool mangles `&` in URLs. It cannot test a multi-parameter API.
- A fetch tool reporting "could not extract content" does **not** mean the
  endpoint is dead. Use `curl`.

Refuse to continue on an unlicensed or ToS-ambiguous source. `TRVL_ENABLED`
defaults to `false` precisely because the licence risk sits with the operator,
not the author.

## Phase 2 — Decide inline vs pre-warm

Measure the latency of the exact call shape you plan to ship. It decides the
architecture. The test is whether it fits inside a shopper's request budget —
not a round number of seconds.

| Latency of the intended call | Shape |
| --- | --- |
| Comfortably inside the request budget | `getRates` calls the source directly |
| Cannot sit inside the request budget | Background warmer + Redis; adapter is **cache-only** |

A pre-warmed adapter's `getRates` must never spawn the upstream. On a miss it
returns `[]`, and the resolver falls back to `TicketType.basePriceCents` — the
intended degradation, not an error.

Measured trvl numbers, from `trvl-warmer.ts`:

```text
HKG -> DXB              6689 ms, 21 dates
JFK -> DXB               831 ms, 21 dates
DXB -> DXB             56116 ms, 0 dates
"HKG,DXB,JFK" -> DXB   11560 ms, 0 dates
```

Lessons encoded there: a batched calendar call (`dates`) beat 30 single-date
calls; `dates` is **single-origin**; same-airport routes cost 56 s and price
nothing; concurrency stays sequential because upstreams rate-limit on cadence.
*"A batch that prices nothing is worse than no batch — it looks like coverage."*

## Phase 3 — Implement the adapter

Create `apps/api/src/modules/supply/NAME-source.ts`. The contract in `live.ts`
is small and every field is **required**:

```ts
export interface LiveOffer {
  sourceId: string;
  externalId: string;      // namespace with the slug so sources cannot collide
  netPriceCents: number;   // cost of ONE unit, minor units of `currency`
  currency: string;
  sellable: number | null; // null = source did not say. 0 = confirmed sold out.
  fetchedAt: number;
}

export interface LiveRateSource {
  readonly id: string;      // must match a row in docs/supply-sources.md
  readonly license: string;
  readonly categories: readonly LiveCategory[];
  getRates(query: LiveRateQuery): Promise<LiveOffer[]>;
  getAvailability(query: LiveRateQuery): Promise<LiveAvailability[]>;
}
```

Non-negotiables while mapping an upstream payload:

- **Integers only.** `Math.round(price * 100)`; reject non-finite and negative.
  Real payloads carry values like `244.6428571428571`.
- **`sellable: null`, never `0`.** `0` asserts sold-out. The repo's recurring bug
  class is treating `0` as "unset".
- **Return `[]` from `getAvailability` unless the upstream reports real
  capacity.** Inventing capacity from a nightly price sells seats never confirmed.
- **Throw nothing.** Every failure is `[]` or `null`. One flaky upstream must not
  make a category unbuyable — the resolver already try/catches per source.
- **Respect upstream quality signals** rather than discarding them. trvl's
  `confidence.label === 'low'` is a different proposition from `'high'`.
- Carry a provenance comment in the file header with the date and the verbatim
  probed response.

## Phase 4 — The currency and cache-key contract

This is the highest-risk part of the work, and it is now guarded by
`pnpm supply:contract` inside `pnpm verify`.

`LiveRateFinder.resolve()` reads the cache **before** consulting any source, so
whatever is at the key is consumed as `LiveOffer[]` verbatim. Two rules follow.

**Rule 1 — key by settlement currency, store upstream currency.**

```text
key   = warmKeyFor(slug, serviceDate, SETTLEMENT_CURRENCY)  // what the resolver asks with
row   = { ..., currency: UPSTREAM_CURRENCY }                 // converted on read by pickOffer
```

Keying on the upstream currency meant a USD request never found a warmed entry —
a full cache and zero hits. `SETTLEMENT_CURRENCY` is `config.booking.defaultCurrency`;
`TRVL_NATIVE_CURRENCY` is `'EUR'`. Export both as constants so the warmer and the
adapter cannot drift.

**Rule 2 — mirror `cacheKey()` exactly.**

```ts
['live:rate', slug, category, serviceDate, checkOutDate ?? '',
 String(quantity), currency, freshness].join(':')
```

A drifted key is invisible: writes land, reads miss, tests still pass.
`checkout` has TTL `0` by design — never cache a price the shopper agreed to.

Conversion is `pickOffer`'s job alone, via `convertMinorUnits` from
`utils/fx.ts`. **Never rewrite stored money** to make a price match; let the
resolver convert. `pickOffer` rejects a failed conversion rather than passing a
raw number through, so "100 EUR" can never be read as "100 USD".

## Phase 5 — Wire it in

In order. No factory, no DI container, no fixtures.

1. **`config/env.ts`** — add a `supply` entry for the source using the repo's
   parsers: `str('X', 'false') === 'true'` for booleans, `int('X', fallback)` for
   numbers. The env var family is `SUPPLY_LIVE_*`, not `LIVE_*`. Mind the existing
   naming: the SerpApi key is `SERPAPI_API_KEY`, not `SERPAPI_KEY`.
2. **`.env.example`** — document it, including the business reason for the
   default. New sources with an unresolved licence ship **off**.
3. **`live-adapters.ts`** — append to `liveRateSources` **before**
   `NoCommercialRateSource`. Array order *is* fallback order; the sentinel stays
   last so `degraded` can tell "nothing answered" from "the layer is off".
4. **Warmer only** — `NAME-warmer.ts` exporting
   `startNameWarmer(): NodeJS.Timeout | null`, called from `index.ts` after
   `startBackgroundJobs()`, and cleared in `shutdown`.
   - `existsSync` the binary in **both** the adapter and the warmer. `execFile`
     reports a missing binary as a *callback error*, not a throw, so only a
     caller-side check stops the log storm.
   - Inject child-process env vars such as `TRVL_NO_TELEMETRY: '1'` **in code**,
     never leave them to the operator.
   - `cacheSet` returns `void` — read back with `cacheGet` if the count must be
     honest.
   - Offset the first run (`setTimeout(…, 15_000)`) so it does not race the hold
     sweeper.
5. **`prisma/live-rate-probe.ts`** — add a `PROBES` entry when the source has an
   endpoint. *"Every entry must be something the code actually calls, or the probe
   becomes a health check of nothing."*
6. **`docs/supply-sources.md`** — a dated row: `id | endpoint | probed response |
   meaning`. Verbatim response, not a paraphrase.

An adapter with no credential returns `[]` rather than checking `enabled` at the
call site. The chain stays free of conditionals; a blank key is simply "this
source carries no data".

## Phase 6 — Prove it end to end

`pnpm verify` now runs **`pnpm supply:contract`** (`prisma/live-contract-check.ts`),
which pins the layer's contracts offline: cache-key parity, verbatim row
consumption, conversion, the `sellable` rejections, and registry order. Keep it
green — it needs no binary, no credential and no network, so it runs on a fresh
clone and in CI.

What that gate deliberately does **not** do is talk to a real upstream. It writes a
row and reads it back; it never proves a fare was fetched. For that, run the
warmer end to end by hand:

```bash
pnpm --filter @easytrip/api supply:contract            # offline, in pnpm verify
(cd apps/api && set -a && . ../../.env && set +a \
  && TRVL_ENABLED=true TRVL_BINARY_PATH=/tmp/trvltest/trvl \
     npx tsx prisma/verify-trvl-warm.ts)               # real binary, manual
```

Expected output from the manual run:

```text
✓ cold read: null (falls back to seeded price)
✓ warm: wrote cache entry
✓ warm read: {"netPriceCents":40089,"currency":"EUR","fromCache":true}
```

The **cold read must be `null`**. If it is not, something other than the warmer
is populating the cache and the test proves nothing. That script may exit `124`
because `$disconnect()` hangs — the printed verdict is still valid.

Adapt the same three-step shape to a new source, and confirm:

| Assertion | Failure means |
| --- | --- |
| cold read is `null` | a second writer exists |
| warm read is non-null | warmer key drifted from `cacheKey()` |
| `quote.currency === TicketType.currency` | conversion skipped |
| `Number.isInteger(netPriceCents) && > 0` | rounding or parsing broke |
| `quote.sourceId` is the source id, not `undefined` | a trimmed cache row |

Add the same three-step shape as assertions in `live-contract-check.ts` when you
add a source, so `pnpm verify` carries the contract forward.

Then the repo gate:

```bash
pnpm verify   # baseline: smoke 92/92, realtime 18/18, mobile 40/40, exit 0
```

Two things `pnpm verify` still will not catch, because they are not offline
properties: whether a warmer is actually running (it needs the binary), and
whether an upstream is still alive. For those use `supply:contract` with a real
credential, and `supply:probe`.

Kill stale watchers first — `pkill -f 'tsx watch'` — or smoke passes against old
code. A fresh `pnpm dev:api` logging `EADDRINUSE` while `/ready` returns 200 is
the stale-code signature.

## Pitfall index

| Symptom | Cause |
| --- | --- |
| Warm cache full, zero hits | keyed by upstream currency instead of settlement |
| `sourceId: undefined` in a quote | trimmed cache row; the shape must be exactly `LiveOffer` |
| A warm read returns the wrong source | the cache is consulted *before* any source, so a stale key beats live data |
| `degraded` stays false when nothing answered | an earlier cached row short-circuited the chain; clear the key between cases |
| Price treated as sold out | `sellable: 0` written where "unknown" was meant |
| `spawn ENOENT` storm | binary path non-empty but missing; add `existsSync` |
| 100 EUR read as 100 USD | conversion bypassed; let `pickOffer` convert |
| Nothing changes in search | `SUPPLY_LIVE_ENABLED` still false, or no credential |
| Bulk warm returns nothing | batched a single-origin endpoint |
| `TS2322` on nested `orderBy`/`take` | ordering inside the `ProductFlight.segments` **Json** column — query `FlightSegment` instead |

## Completion checks

1. Freshness, licence, terms, latency, and credential recorded with a date and a
   verbatim response.
2. `LiveOffer` rows complete; `sellable` is `null` or a real count, never a guess.
3. Cache key matches `cacheKey()` byte for byte, keyed by settlement currency.
4. Registered before `NoCommercialRateSource`; no call site changed.
5. `cold → warm → warm read` proved through the real resolver, with `sourceId`
   asserted.
6. `pnpm supply:contract` green — the offline contract gate inside `pnpm verify`.
7. `pnpm verify` exits `0`, with stale watchers cleared first.
8. `docs/supply-sources.md` and the adapter header both carry the provenance.

## Suggested prompts

- "Evaluate SerpApi as a live rate source and record the freshness evidence."
- "Onboard the Amadeus feed as a pre-warmed adapter and prove it end to end."
- "Warmed prices exist in Redis but search shows the seeded price — diagnose."
- "Debug a live quote with the wrong `sourceId`."

## Related

- [`repo-playbook`](../repo-playbook/SKILL.md) — env, currency, and `existsSync` traps.
- [`verify-the-change`](../verify-the-change/SKILL.md) — the final gate workflow.
- `docs/supply-sources.md` — the mandate and every recorded source.
- `docs/realtime-supply-plan.md` — the design this implements.
