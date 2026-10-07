# Browser audit & end-to-end harness

Driven by Playwright. **Deliberately not part of `pnpm verify`**: `verify` must
stay deterministic and offline, while this suite drives a real browser against a
running API and web server (and, for the reference spec, the public internet).

## Prerequisites

```bash
pnpm dev:api                                     # API on :4000
(cd apps/web && pnpm build && npx next start -p 3000)   # built web on :3000
```

The web app must be a **production build**, not `next dev`: `next dev` serves
unstyled HTML for the audit's purposes and wipes `.next` on boot.

A long browser run makes far more requests per minute than a human shopper, so
raise the API's ceiling for it:

```bash
RATE_LIMIT_MAX=5000 pnpm dev:api
```

Without that, unrelated requests start failing with `429` part-way through a run
and it looks like a product bug.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm ux:audit:app` | Render audit of `/`, `/search`, `/login`, `/register`, `/cart`, and one product page, at 1440×900 and 393×844. Fails on `error`-severity findings. |
| `pnpm e2e:web` | The full purchase chain: register → verify the emailed code → search → reserve → pay → ticket. |
| `pnpm ux:audit:reference` | Same render audit against expedia.com. Reports; never gates. |

Reports are written to `docs/ux-audit-app-<viewport>.md` and
`docs/ux-audit-reference.md`; screenshots go to `artifacts/ux-audit/` (gitignored).

## How findings are graded

| Severity | Examples | Effect |
| --- | --- | --- |
| `error` | A broken **same-origin** image; a container whose content overflows horizontally | Fails the run |
| `warning` | Collapsed (zero-height) content; a control with no accessible name; an **external** image host that did not answer | Reported |
| `info` | A tap target under 32px; an `alt` string sharing no word with nearby copy | Reported, needs a human |

The cross-origin distinction matters: in a sandboxed CI container outbound
requests to image CDNs are commonly blocked, and a blocked CDN is not an
application defect. Ticket QR images are served from our own origin through
`/media/...`, so a genuinely missing artefact is still an `error`.

## Diagnostic tools

When a run fails, these answer *why* rather than *that*:

```bash
node scripts/ux-audit/diagnose-overflow.mjs [path] [width]       # outermost offender, shallowest first
node scripts/ux-audit/diagnose-wide-block.mjs [path] [width]     # grid/flex blocks whose min-content is too wide
node scripts/ux-audit/diagnose-probe-fix.mjs [path] [width]      # try candidate CSS patches, report which one fixes it
node scripts/ux-audit/diagnose-checkout-pay.mjs                  # drive checkout and log every API request/response
```

`diagnose-probe-fix.mjs` is the one worth reaching for first: it settles
flexbox-min-content questions by asking the browser instead of reasoning about
the spec. It measures `document.body.scrollWidth`, not `documentElement`'s —
`body` sets `overflow-x: hidden`, so the document element always reports the
viewport width and proves nothing.

## Defects this suite has already found

- **`/checkout` CTA dropped the product slug.** The product page's primary
  "Reserve & continue to payment" button pushed `/checkout?ticketTypeId=…`
  without `slug`, so the route redirected to `/search` and the shopper silently
  lost their date, ticket type and quantity. `e2e:web` covers it.
- **Clipped content on mobile product pages.** `.with-rail` flips to
  `flex-direction: column` at ≤860px but kept `align-items: flex-start`, so rail
  children sized to their *max-content* (~540px on a 393px viewport) and `body`'s
  `overflow-x: hidden` hid the excess instead of scrolling it. Fixed at the root
  with `align-items: stretch` in the same media query.
