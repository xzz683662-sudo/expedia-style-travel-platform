# Storefront render audit — mobile

Automated pass over the running storefront (mobile viewport).

`error` = a broken image or a horizontal overflow; `warning` = collapsed content or an
unnamed control; `info` = a small tap target or an alt/copy mismatch candidate for a
human to review. Only `error` fails the run.

**Summary:** 0 error(s), 23 warning(s), 87 informational.

| Page | Errors | Warnings | Info | Screenshot |
| --- | ---: | ---: | ---: | --- |
| home | 0 | 11 | 14 | `artifacts/ux-audit/mobile/home.png` |
| search | 0 | 12 | 15 | `artifacts/ux-audit/mobile/search.png` |
| login | 0 | 0 | 15 | `artifacts/ux-audit/mobile/login.png` |
| register | 0 | 0 | 14 | `artifacts/ux-audit/mobile/register.png` |
| cart | 0 | 0 | 14 | `artifacts/ux-audit/mobile/cart.png` |
| product | 0 | 0 | 15 | `artifacts/ux-audit/mobile/product.png` |

## home

- URL: `http://localhost:3000/`
- Title: EasyTrip — Flights, hotels, cruises and curated experiences worldwide

- **warning** · `unnamed-control` — `input.input`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **info** · `small-tap-target` — `a.logo "EEasyTrip" 116×30`
- **info** · `small-tap-target` — `a.small "Journeys" 173×20`
- **info** · `small-tap-target` — `a.small "Shopping cart" 173×20`
- **info** · `small-tap-target` — `a.small "Popular now" 173×20`
- **info** · `small-tap-target` — `a.small "Priority entry" 173×20`
- **info** · `small-tap-target` — `a.small "Flexible booking" 173×20`
- **info** · `small-tap-target` — `a.small "My bookings" 173×20`
- **info** · `small-tap-target` — `a.small "My tickets" 173×20`
- **info** · `small-tap-target` — `a.small "EasyTrip Club" 173×20`
- **info** · `small-tap-target` — `a.small "Help centre" 173×20`
- **info** · `small-tap-target` — `a.small "Cancellations" 173×20`
- **info** · `small-tap-target` — `a.small "Contact" 173×20`
- **info** · `small-tap-target` — `a.small.subtle "Privacy" 46×20`
- **info** · `small-tap-target` — `a.small.subtle "Terms" 39×20`

## search

- URL: `http://localhost:3000/search`
- Title: Search global journeys | EasyTrip

- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **warning** · `unnamed-control` — `a.product-media`
- **info** · `small-tap-target` — `a.logo "EEasyTrip" 116×30`
- **info** · `small-tap-target` — `a.small.nowrap "All landmark access →" 149×20`
- **info** · `small-tap-target` — `a.small.nowrap "All private guides →" 130×20`
- **info** · `small-tap-target` — `a.small.nowrap "All ocean & river cruises →" 173×20`
- **info** · `small-tap-target` — `a.small.nowrap "All signature activities →" 161×20`
- **info** · `small-tap-target` — `a.small.nowrap "All international flights →" 162×20`
- **info** · `small-tap-target` — `a.small.nowrap "All hotels & suites →" 131×20`
- **info** · `small-tap-target` — `a.small.nowrap "All day trips →" 93×20`
- **info** · `small-tap-target` — `a.small.nowrap "All curated packages →" 154×20`
- **info** · `small-tap-target` — `a.product-title "London Flight & 3-Night Stay" 235×20`
- **info** · `small-tap-target` — `a.small "Journeys" 173×20`
- **info** · `small-tap-target` — `a.small "Shopping cart" 173×20`
- **info** · `small-tap-target` — `a.small "Popular now" 173×20`
- **info** · `small-tap-target` — `a.small "Priority entry" 173×20`
- **info** · `small-tap-target` — `a.small "Flexible booking" 173×20`

## login

- URL: `http://localhost:3000/login`
- Title: EasyTrip — Flights, hotels, cruises and curated experiences worldwide

- **info** · `small-tap-target` — `a.logo "EEasyTrip" 116×30`
- **info** · `small-tap-target` — `button.demo-account "admin@easytrip.testAdmin — operations console" 343×30`
- **info** · `small-tap-target` — `a.small "Journeys" 173×20`
- **info** · `small-tap-target` — `a.small "Shopping cart" 173×20`
- **info** · `small-tap-target` — `a.small "Popular now" 173×20`
- **info** · `small-tap-target` — `a.small "Priority entry" 173×20`
- **info** · `small-tap-target` — `a.small "Flexible booking" 173×20`
- **info** · `small-tap-target` — `a.small "My bookings" 173×20`
- **info** · `small-tap-target` — `a.small "My tickets" 173×20`
- **info** · `small-tap-target` — `a.small "EasyTrip Club" 173×20`
- **info** · `small-tap-target` — `a.small "Help centre" 173×20`
- **info** · `small-tap-target` — `a.small "Cancellations" 173×20`
- **info** · `small-tap-target` — `a.small "Contact" 173×20`
- **info** · `small-tap-target` — `a.small.subtle "Privacy" 46×20`
- **info** · `small-tap-target` — `a.small.subtle "Terms" 39×20`

## register

- URL: `http://localhost:3000/register`
- Title: EasyTrip — Flights, hotels, cruises and curated experiences worldwide

- **info** · `small-tap-target` — `a.logo "EEasyTrip" 116×30`
- **info** · `small-tap-target` — `a.small "Journeys" 173×20`
- **info** · `small-tap-target` — `a.small "Shopping cart" 173×20`
- **info** · `small-tap-target` — `a.small "Popular now" 173×20`
- **info** · `small-tap-target` — `a.small "Priority entry" 173×20`
- **info** · `small-tap-target` — `a.small "Flexible booking" 173×20`
- **info** · `small-tap-target` — `a.small "My bookings" 173×20`
- **info** · `small-tap-target` — `a.small "My tickets" 173×20`
- **info** · `small-tap-target` — `a.small "EasyTrip Club" 173×20`
- **info** · `small-tap-target` — `a.small "Help centre" 173×20`
- **info** · `small-tap-target` — `a.small "Cancellations" 173×20`
- **info** · `small-tap-target` — `a.small "Contact" 173×20`
- **info** · `small-tap-target` — `a.small.subtle "Privacy" 46×20`
- **info** · `small-tap-target` — `a.small.subtle "Terms" 39×20`

## cart

- URL: `http://localhost:3000/cart`
- Title: Your trip cart | EasyTrip

- **info** · `small-tap-target` — `a.logo "EEasyTrip" 116×30`
- **info** · `small-tap-target` — `a.small "Journeys" 173×20`
- **info** · `small-tap-target` — `a.small "Shopping cart" 173×20`
- **info** · `small-tap-target` — `a.small "Popular now" 173×20`
- **info** · `small-tap-target` — `a.small "Priority entry" 173×20`
- **info** · `small-tap-target` — `a.small "Flexible booking" 173×20`
- **info** · `small-tap-target` — `a.small "My bookings" 173×20`
- **info** · `small-tap-target` — `a.small "My tickets" 173×20`
- **info** · `small-tap-target` — `a.small "EasyTrip Club" 173×20`
- **info** · `small-tap-target` — `a.small "Help centre" 173×20`
- **info** · `small-tap-target` — `a.small "Cancellations" 173×20`
- **info** · `small-tap-target` — `a.small "Contact" 173×20`
- **info** · `small-tap-target` — `a.small.subtle "Privacy" 46×20`
- **info** · `small-tap-target` — `a.small.subtle "Terms" 39×20`

## product

- URL: `http://localhost:3000/products/top-view-observation-deck`
- Title: Skyline Observation Deck at One World Trade Center | EasyTrip

- **info** · `small-tap-target` — `a.logo "EEasyTrip" 116×30`
- **info** · `small-tap-target` — `a.small.bold "Oct 8, 2026 · Today" 132×20`
- **info** · `small-tap-target` — `a.small "Journeys" 173×20`
- **info** · `small-tap-target` — `a.small "Shopping cart" 173×20`
- **info** · `small-tap-target` — `a.small "Popular now" 173×20`
- **info** · `small-tap-target` — `a.small "Priority entry" 173×20`
- **info** · `small-tap-target` — `a.small "Flexible booking" 173×20`
- **info** · `small-tap-target` — `a.small "My bookings" 173×20`
- **info** · `small-tap-target` — `a.small "My tickets" 173×20`
- **info** · `small-tap-target` — `a.small "EasyTrip Club" 173×20`
- **info** · `small-tap-target` — `a.small "Help centre" 173×20`
- **info** · `small-tap-target` — `a.small "Cancellations" 173×20`
- **info** · `small-tap-target` — `a.small "Contact" 173×20`
- **info** · `small-tap-target` — `a.small.subtle "Privacy" 46×20`
- **info** · `small-tap-target` — `a.small.subtle "Terms" 39×20`
