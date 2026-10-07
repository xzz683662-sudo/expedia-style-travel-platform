# Storefront render audit — desktop

Automated pass over the running storefront (desktop viewport).

`error` = a broken image or a horizontal overflow; `warning` = collapsed content or an
unnamed control; `info` = a small tap target or an alt/copy mismatch candidate for a
human to review. Only `error` fails the run.

**Summary:** 0 error(s), 6 warning(s), 0 informational.

| Page | Errors | Warnings | Info | Screenshot |
| --- | ---: | ---: | ---: | --- |
| home | 0 | 4 | 0 | `artifacts/ux-audit/desktop/home.png` |
| search | 0 | 2 | 0 | `artifacts/ux-audit/desktop/search.png` |
| login | 0 | 0 | 0 | `artifacts/ux-audit/desktop/login.png` |
| register | 0 | 0 | 0 | `artifacts/ux-audit/desktop/register.png` |
| cart | 0 | 0 | 0 | `artifacts/ux-audit/desktop/cart.png` |
| product | 0 | 0 | 0 | `artifacts/ux-audit/desktop/product.png` |

## home

- URL: `http://localhost:3000/`
- Title: EasyTrip — Flights, hotels, cruises and curated experiences worldwide

- **warning** · `external-image-unreachable` — cross-origin https://images.unsplash.com/photo-1543429776-2782fc586c70?w=1200&q=80 — naturalWidth=0 (alt="")
- **warning** · `external-image-unreachable` — cross-origin https://images.unsplash.com/photo-1558452998-6a7e6c7dbd03?w=1200&q=80 — naturalWidth=0 (alt="")
- **warning** · `external-image-unreachable` — cross-origin https://images.unsplash.com/photo-1521727857535-28d2047619b6?auto=format&fit=crop&w=1200&q=80 — naturalWidth=0 (alt="")
- **warning** · `unnamed-control` — input.input


## search

- URL: `http://localhost:3000/search`
- Title: Search global journeys | EasyTrip

- **warning** · `external-image-unreachable` — cross-origin https://images.unsplash.com/photo-1543841464-62e3ac6436ac?auto=format&fit=crop&w=1200&q=80 — naturalWidth=0 (alt="")
- **warning** · `external-image-unreachable` — cross-origin https://images.unsplash.com/photo-1517821362941-f7f7532f7c5b?auto=format&fit=crop&w=1200&q=80 — naturalWidth=0 (alt="")


## login

- URL: `http://localhost:3000/login`
- Title: EasyTrip — Flights, hotels, cruises and curated experiences worldwide
- No findings.


## register

- URL: `http://localhost:3000/register`
- Title: EasyTrip — Flights, hotels, cruises and curated experiences worldwide
- No findings.


## cart

- URL: `http://localhost:3000/cart`
- Title: Your trip cart | EasyTrip
- No findings.


## product

- URL: `http://localhost:3000/products/top-view-observation-deck`
- Title: Skyline Observation Deck at One World Trade Center | EasyTrip
- No findings.

