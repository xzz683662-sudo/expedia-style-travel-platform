#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# EasyTrip end-to-end smoke test
#
# Exercises the full commercial loop against a running API:
#   search -> product detail -> checkout -> payment -> ticket issue
#   -> gate redemption -> cancellation/refund
#
# Usage:  bash scripts/smoke-test.sh [API_BASE_URL]
# ---------------------------------------------------------------------------

set -euo pipefail

API="${1:-http://localhost:4000}"
PASS=0
FAIL=0

# Clean up response snapshots written by the unified-search assertions.
trap 'rm -f "${SEARCH_FILE:-}" "${MULTI_FILE:-}" "${CAT_FILE:-}" 2>/dev/null || true' EXIT

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }
head2() { printf "\n\033[1;36m── %s\033[0m\n" "$1"; }

check() {
  local label="$1" condition="$2"
  if [ "$condition" = "true" ]; then
    green "  ✓ $label"
    PASS=$((PASS + 1))
  else
    red   "  ✗ $label"
    FAIL=$((FAIL + 1))
  fi
}

# jq is optional; fall back to node for JSON extraction.
# Normalise `a.0.b` into `a[0].b` so paths work on jq 1.5 as well as jq 1.6+.
normalize_path() {
  echo "$1" | sed -E 's/\.([0-9]+)(\.|$)/[\1]\2/g'
}

if command -v jq >/dev/null 2>&1; then
  jget() { jq -r "$(normalize_path "$1")"; }
else
  jget() {
    node -e "
      let d='';
      process.stdin.on('data',c=>d+=c).on('end',()=>{
        const path='$1';
        let v=JSON.parse(d);
        for (const raw of path.split('.')) {
          if (v === null || v === undefined) break;
          const m = raw.match(/^([A-Za-z0-9_]*)\[(\d+)\]$/);
          if (m) { v = m[1] ? v[m[1]] : v; v = v?.[Number(m[2])]; }
          else v = v?.[raw];
        }
        console.log(v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v));
      });
    "
  }
fi

head2 "Health"
HEALTH=$(curl -fsS "$API/health")
check "GET /health returns ok" "$(echo "$HEALTH" | jget '.status' | grep -q '^ok$' && echo true || echo false)"

# Redis connects lazily, so the very first /ready can briefly report 503.
# Retry a couple of times rather than failing the run on a cold cache.
READY=""
for _ in 1 2 3 4 5; do
  READY=$(curl -s "$API/ready" || true)
  if echo "$READY" | jget '.ready' | grep -q true; then break; fi
  sleep 1
done
check "GET /ready reports database connected" "$(echo "$READY" | jget '.checks.database' | grep -q true && echo true || echo false)"

head2 "Search"
# Keep the raw search JSON on disk as well: parsing a large response straight
# from a variable through a pipe can misreport the exit code under `set -e`,
# so the unified-search assertions below read the response file directly.
SEARCH=$(curl -fsS "$API/api/v1/search?pageSize=5")
SEARCH_FILE=$(mktemp)
printf '%s\n' "$SEARCH" > "$SEARCH_FILE"
TOTAL=$(echo "$SEARCH" | jget '.total')
check "GET /api/v1/search returns results (total>0)" "$([ "${TOTAL:-0}" -gt 0 ] && echo true || echo false)"

FIRST_SLUG=$(echo "$SEARCH" | jget '.items.0.slug')
check "search returns a product slug" "$([ -n "$FIRST_SLUG" ] && [ "$FIRST_SLUG" != "null" ] && echo true || echo false)"

PRICE=$(echo "$SEARCH" | jget '.items.0.priceCents')
check "search hit carries a price (${PRICE:-none} cents)" "$([ -n "$PRICE" ] && [ "$PRICE" != "null" ] && [ "$PRICE" -gt 0 ] 2>/dev/null && echo true || echo false)"

head2 "Category facets (Phase 0)"
# A hotel card needs stars, a flight card needs carrier + route, a cruise card
# needs the ship. These assert the facet is exposed AND that it filters, because
# a facet that renders but does not narrow the result set is worse than none.
FLIGHT_FACET=$(curl -fsS "$API/api/v1/search?type=FLIGHT&limit=1")
FLIGHT_CARRIER=$(echo "$FLIGHT_FACET" | jget '.items.0.carrierName')
check "a flight hit carries a carrier (${FLIGHT_CARRIER:-none})" "$([ -n "$FLIGHT_CARRIER" ] && [ "$FLIGHT_CARRIER" != "null" ] && echo true || echo false)"

FLIGHT_ROUTE=$(echo "$FLIGHT_FACET" | jget '.items.0.routeSummary')
check "a flight hit carries a route (${FLIGHT_ROUTE:-none})" "$([ -n "$FLIGHT_ROUTE" ] && [ "$FLIGHT_ROUTE" != "null" ] && echo true || echo false)"

HOTEL_FACET=$(curl -fsS "$API/api/v1/search?type=HOTEL_ROOM&limit=1")
HOTEL_STARS=$(echo "$HOTEL_FACET" | jget '.items.0.starRating')
check "a hotel hit carries a star rating (${HOTEL_STARS:-none})" "$([ -n "$HOTEL_STARS" ] && [ "$HOTEL_STARS" != "null" ] && echo true || echo false)"

# Facets must not bleed across categories: a hotel must not report a carrier.
HOTEL_HAS_CARRIER=$(echo "$HOTEL_FACET" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).items[0].carrierName!=null)}catch{console.log(false)}});")
check "a hotel hit does not leak a carrier facet" "$([ "$HOTEL_HAS_CARRIER" = "false" ] && echo true || echo false)"

STARS_5=$(curl -fsS "$API/api/v1/search?type=HOTEL_ROOM&stars=5&limit=1")
STARS_5_COUNT=$(echo "$STARS_5" | jget '.total')
STARS_ALL=$(curl -fsS "$API/api/v1/search?type=HOTEL_ROOM&limit=1")
STARS_ALL_COUNT=$(echo "$STARS_ALL" | jget '.total')
check "starRating facet narrows results (${STARS_5_COUNT:-0} of ${STARS_ALL_COUNT:-0})" "$([ "${STARS_5_COUNT:-0}" -gt 0 ] 2>/dev/null && [ "${STARS_5_COUNT:-0}" -lt "${STARS_ALL_COUNT:-0}" ] 2>/dev/null && echo true || echo false)"

# Out-of-range and junk values are dropped, not rejected: the storefront should
# never 422 because one chip carried a bad value.
BAD_STARS_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/search?type=HOTEL_ROOM&stars=99")
check "an out-of-range star filter is ignored, not a 422 (${BAD_STARS_CODE})" "$([ "$BAD_STARS_CODE" = "200" ] && echo true || echo false)"

MIXED_STARS=$(curl -fsS "$API/api/v1/search?type=HOTEL_ROOM&stars=5,abc&limit=1")
MIXED_COUNT=$(echo "$MIXED_STARS" | jget '.total')
check "a junk entry is dropped and the valid one still applies (${MIXED_COUNT})" "$([ "${MIXED_COUNT:-0}" = "${STARS_5_COUNT:-x}" ] && echo true || echo false)"

head2 "Unified multi-category search"
# Each metric is resolved by a node call that reads the response file directly.
# NOTE: do NOT name the category-count variable `GROUPS` — bash exposes `GROUPS`
# as a read-only array of the caller's group IDs, so assigning to it fails with
# a non-zero status and `set -e` aborts the whole run.
GROUP_COUNT=$(node -e 'const fs=require("fs"),o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),g=o.groups||[];console.log(g.length)' "$SEARCH_FILE" || true)
GROUP_OK=$(node -e 'const fs=require("fs"),o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),g=o.groups||[];console.log(g.length>0&&g.every(x=>typeof x.type==="string"&&typeof x.label==="string"&&typeof x.count==="number"&&x.count>=x.items.length))' "$SEARCH_FILE" || true)
FACET_TYPES=$(node -e 'const fs=require("fs"),o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),f=o.facets?o.facets.types:[],n=f?f.length:0;console.log(n)' "$SEARCH_FILE" || true)
check "unified search returns category groups (${GROUP_COUNT:-0})" "$([ "${GROUP_COUNT:-0}" -gt 0 ] && echo true || echo false)"
check "each group carries type/label/count" "$([ "$GROUP_OK" = "true" ] && echo true || echo false)"
check "type facet is populated (${FACET_TYPES:-0} categories)" "$([ "${FACET_TYPES:-0}" -gt 0 ] && echo true || echo false)"

# Multi-category filter: `types=A,B` must return only those two categories, and
# the disjunctive type facet must still list the *other* categories (so the tab
# bar does not collapse to the selected ones).
MULTI_FILE=$(mktemp)
curl -fsS "$API/api/v1/search?types=ATTRACTION_TICKET,CRUISE&pageSize=50" -o "$MULTI_FILE"
MULTI_OK=$(node -e 'const fs=require("fs"),o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),ts=new Set(o.items.map(i=>i.type)),gs=o.groups?o.groups.length:0;console.log([...ts].every(t=>t==="ATTRACTION_TICKET"||t==="CRUISE")&&ts.size>0&&gs===0)' "$MULTI_FILE" || true)
check "GET /search?types=A,B narrows to the selected categories" "$([ "$MULTI_OK" = "true" ] && echo true || echo false)"

DISJUNCTIVE=$(node -e 'const fs=require("fs"),o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),ft=o.facets?o.facets.types:[],ids=ft?ft.map(f=>f.value):[];console.log(ids.length>1&&ids.some(v=>v!=="ATTRACTION_TICKET"&&v!=="CRUISE"))' "$MULTI_FILE" || true)
check "type facet stays disjunctive while a category is selected" "$([ "$DISJUNCTIVE" = "true" ] && echo true || echo false)"

CAT_FILE=$(mktemp)
curl -fsS "$API/api/v1/search/categories" -o "$CAT_FILE"
CAT_SUM=$(node -e 'const fs=require("fs"),o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),cs=o.categories||[];console.log(cs.every(c=>c.label&&c.productCount>0&&c.fromPriceCents>0))' "$CAT_FILE" || true)
check "GET /search/categories rolls up the catalogue" "$([ "$CAT_SUM" = "true" ] && echo true || echo false)"

head2 "Destinations & collections"
DEST=$(curl -fsS "$API/api/v1/destinations")
check "GET /api/v1/destinations lists popular cities" "$(echo "$DEST" | grep -q 'productCount' && echo true || echo false)"

COLL=$(curl -fsS "$API/api/v1/collections/trending")
check "GET /api/v1/collections/trending works" "$(echo "$COLL" | jget '.title' | grep -q 'Trending' && echo true || echo false)"

head2 "Product detail"
DETAIL=$(curl -fsS "$API/api/v1/products/$FIRST_SLUG")
check "GET /api/v1/products/:slug returns the product" "$(echo "$DETAIL" | jget '.slug' | grep -q "$FIRST_SLUG" && echo true || echo false)"
PRODUCT_ID=$(echo "$DETAIL" | jget '.id')

VARIANTS=$(echo "$DETAIL" | jget '.ticketTypes' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).length)}catch{console.log(0)}});")
check "product exposes ticket variants (${VARIANTS:-0})" "$([ "${VARIANTS:-0}" -gt 0 ] && echo true || echo false)"

CANCEL_POLICY=$(echo "$DETAIL" | jget '.cancellationPolicy.freeCancelHours')
check "product exposes a cancellation policy (${CANCEL_POLICY:-none}h)" "$([ -n "$CANCEL_POLICY" ] && [ "$CANCEL_POLICY" != "null" ] && echo true || echo false)"

TICKET_TYPE_ID=$(echo "$DETAIL" | jget '.ticketTypes.0.id')

head2 "Guest cart"
GUEST_CART=$(curl -fsS "$API/api/v1/cart")
GUEST_CART_TOKEN=$(echo "$GUEST_CART" | jget '.guestToken')
check "GET /cart creates a guest cart capability" "$([ -n "$GUEST_CART_TOKEN" ] && [ "$GUEST_CART_TOKEN" != "null" ] && echo true || echo false)"

GUEST_SERVICE_DATE=$(node -e "const d=new Date();d.setDate(d.getDate()+10);console.log(d.toISOString().slice(0,10));")
GUEST_CART_ADD=$(curl -fsS -X POST "$API/api/v1/cart/items" \
  -H 'Content-Type: application/json' \
  -H "X-Cart-Token: $GUEST_CART_TOKEN" \
  -d "{\"ticketTypeId\":\"$TICKET_TYPE_ID\",\"serviceDate\":\"$GUEST_SERVICE_DATE\",\"quantity\":1}")
GUEST_CART_COUNT=$(echo "$GUEST_CART_ADD" | jget '.items' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).length)}catch{console.log(0)}});")
check "guest can add an item without signing in" "$([ "${GUEST_CART_COUNT:-0}" -eq 1 ] && echo true || echo false)"
check "adding to cart leaves it open without a stock hold" "$(echo "$GUEST_CART_ADD" | jget '.status' | grep -q '^OPEN$' && echo true || echo false)"

head2 "Availability calendar"
CAL=$(curl -fsS "$API/api/v1/products/$FIRST_SLUG/availability?days=30")
CAL_DAYS=$(echo "$CAL" | jget '.days' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).length)}catch{console.log(0)}});")
check "availability calendar returns days (${CAL_DAYS:-0})" "$([ "${CAL_DAYS:-0}" -gt 0 ] && echo true || echo false)"

head2 "Auth"
EMAIL="smoke+$(date +%s)@easytrip.test"
REG=$(curl -fsS -X POST "$API/api/v1/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Password123!\",\"firstName\":\"Smoke\",\"lastName\":\"Test\"}")
TOKEN=$(echo "$REG" | jget '.token')
check "POST /auth/register returns a token" "$([ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] && echo true || echo false)"

ME=$(curl -fsS "$API/api/v1/auth/me" -H "Authorization: Bearer $TOKEN")
check "GET /auth/me returns the profile" "$(echo "$ME" | jget '.email' | grep -q "$EMAIL" && echo true || echo false)"

LOGIN=$(curl -fsS -X POST "$API/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Password123!\"}")
check "POST /auth/login authenticates" "$(echo "$LOGIN" | jget '.token' | grep -qv 'null' && echo true || echo false)"

head2 "Wishlist"
WISHLIST_ADD=$(curl -fsS -X POST "$API/api/v1/wishlist" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"productId\":\"$PRODUCT_ID\"}")
check "customer can save a product to the wishlist" "$(echo "$WISHLIST_ADD" | jget '.productId' | grep -q "$PRODUCT_ID" && echo true || echo false)"
WISHLIST=$(curl -fsS "$API/api/v1/wishlist" -H "Authorization: Bearer $TOKEN")
check "saved product appears in the wishlist" "$(echo "$WISHLIST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).some(i=>i.productId==='$PRODUCT_ID'))}catch{console.log(false)}});" | grep -q true && echo true || echo false)"
curl -fsS -X DELETE "$API/api/v1/wishlist/$PRODUCT_ID" -H "Authorization: Bearer $TOKEN" >/dev/null
WISHLIST=$(curl -fsS "$API/api/v1/wishlist" -H "Authorization: Bearer $TOKEN")
check "customer can remove a saved product" "$(echo "$WISHLIST" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(!JSON.parse(d).some(i=>i.productId==='$PRODUCT_ID'))}catch{console.log(false)}});" | grep -q true && echo true || echo false)"

head2 "Multi-night stay"
# A hotel stay is sold per room per night. These assert the three properties
# that distinguish it from a ticket: nights are billed, every night in the range
# is held, and a range that cannot be fully satisfied leaves nothing behind.
# `ticketTypeId` is not on a search hit — the option list comes from the product
# detail, the same way the single-date checkout above resolves its own.
STAY_SLUG=$(curl -fsS "$API/api/v1/search?type=HOTEL_ROOM&limit=1" | jget '.items.0.slug')
STAY_TT=$(curl -fsS "$API/api/v1/products/$STAY_SLUG" | jget '.ticketTypes.0.id')
if [[ -z "$STAY_TT" || "$STAY_TT" == "null" ]]; then
  bad "no hotel ticket type available to test a stay"
else
  STAY_IN=$(node -e "const d=new Date();d.setDate(d.getDate()+40);console.log(d.toISOString().slice(0,10));")
  STAY_OUT=$(node -e "const d=new Date();d.setDate(d.getDate()+43);console.log(d.toISOString().slice(0,10));")

  STAY_CART=$(curl -fsS "$API/api/v1/cart" -H "Authorization: Bearer $TOKEN")
  STAY_CART=$(curl -fsS -X POST "$API/api/v1/cart/items" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"ticketTypeId\":\"$STAY_TT\",\"serviceDate\":\"$STAY_IN\",\"checkOutDate\":\"$STAY_OUT\",\"quantity\":1}")
  STAY_NIGHTS=$(echo "$STAY_CART" | jget '.items.0.nights')
  STAY_UNIT=$(echo "$STAY_CART" | jget '.items.0.unitPriceCents')
  STAY_TOTAL=$(echo "$STAY_CART" | jget '.items.0.lineTotalCents')
  check "a stay cart line records its nights (${STAY_NIGHTS:-none}, expected 3)" "$([ "$STAY_NIGHTS" = "3" ] && echo true || echo false)"

  # lineTotal must be unit x rooms x nights. Charging the nightly rate once is the
  # bug this guards: the cart quotes 3 nights and the invoice bills 1.
  STAY_EXPECTED=$(( ${STAY_UNIT:-0} * 3 ))
  check "a stay line bills per night (${STAY_TOTAL:-0} of ${STAY_EXPECTED})" "$([ "${STAY_TOTAL:-0}" = "$STAY_EXPECTED" ] && echo true || echo false)"

  STAY_CHECKOUT=$(curl -fsS -X POST "$API/api/v1/cart/checkout" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"contactEmail\":\"traveler@easytrip.test\",\"travelers\":[{\"fullName\":\"Smoke Stay\",\"dateOfBirth\":\"1990-01-01\"}]}")
  STAY_ORDER_ID=$(echo "$STAY_CHECKOUT" | jget '.orderId')
  check "a multi-night stay checks out (${STAY_ORDER_ID:-none})" "$([ -n "$STAY_ORDER_ID" ] && [ "$STAY_ORDER_ID" != "null" ] && echo true || echo false)"

  # Compare the order against its *own* line, not against the cart figure above:
  # the two are priced independently (a room's TicketType carries its own
  # currency and base price), so only the per-night relationship is meaningful.
  # This is the assertion that catches the real defect — a 3-night booking
  # invoiced for one night.
  STAY_ORDER_DETAIL=$(curl -fsS "$API/api/v1/orders/$STAY_ORDER_ID" -H "Authorization: Bearer $TOKEN")
  STAY_ORDER_NIGHTS=$(echo "$STAY_ORDER_DETAIL" | jget '.items.0.nights')
  STAY_ORDER_LINE=$(echo "$STAY_ORDER_DETAIL" | jget '.items.0.lineTotalCents')
  STAY_ORDER_NIGHTLY=$(echo "$STAY_ORDER_DETAIL" | jget '.items.0.unitPriceCents')
  STAY_ORDER_EXPECTED=$(( ${STAY_ORDER_NIGHTLY:-0} * ${STAY_ORDER_NIGHTS:-0} ))
  check "the stay order keeps its night count (${STAY_ORDER_NIGHTS:-none})" "$([ "${STAY_ORDER_NIGHTS:-0}" -ge 2 ] 2>/dev/null && echo true || echo false)"
  check "the stay order bills night x night (${STAY_ORDER_LINE:-0} of ${STAY_ORDER_EXPECTED})" "$([ "${STAY_ORDER_LINE:-0}" = "$STAY_ORDER_EXPECTED" ] && [ "${STAY_ORDER_EXPECTED:-0}" -gt 0 ] && echo true || echo false)"
fi

head2 "Checkout"
# Pick a date ~10 days out so inventory exists.
SERVICE_DATE=$(node -e "const d=new Date();d.setDate(d.getDate()+10);console.log(d.toISOString().slice(0,10));")

USER_CART=$(curl -fsS "$API/api/v1/cart" -H "Authorization: Bearer $TOKEN")
check "signed-in customer gets an open cart" "$(echo "$USER_CART" | jget '.status' | grep -q '^OPEN$' && echo true || echo false)"
for _ in 1 2; do
  USER_CART=$(curl -fsS -X POST "$API/api/v1/cart/items" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"ticketTypeId\":\"$TICKET_TYPE_ID\",\"serviceDate\":\"$SERVICE_DATE\",\"quantity\":1}")
done
USER_CART_COUNT=$(echo "$USER_CART" | jget '.items' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).length)}catch{console.log(0)}});")
check "cart retains multiple independently selected lines" "$([ "${USER_CART_COUNT:-0}" -eq 2 ] && echo true || echo false)"

ORDER=$(curl -fsS -X POST "$API/api/v1/cart/checkout" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"contactEmail\":\"$EMAIL\",
    \"travelers\":[{\"fullName\":\"Smoke Test\",\"isLead\":true}]
  }")

ORDER_ID=$(echo "$ORDER" | jget '.orderId')
ORDER_NUM=$(echo "$ORDER" | jget '.orderNumber')
TOTAL_CENTS=$(echo "$ORDER" | jget '.totalCents')
check "POST /cart/checkout creates a pending multi-line order ($ORDER_NUM)" "$([ -n "$ORDER_ID" ] && [ "$ORDER_ID" != "null" ] && echo true || echo false)"
check "order total is positive (${TOTAL_CENTS:-0} cents)" "$([ "${TOTAL_CENTS:-0}" -gt 0 ] && echo true || echo false)"

head2 "Inventory hold"
# A second order for the same slot must not oversell beyond capacity; just
# verify the hold mechanism responds coherently.
HOLD_CHECK=$(curl -fsS -X POST "$API/api/v1/orders" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"lines\":[{\"ticketTypeId\":\"$TICKET_TYPE_ID\",\"serviceDate\":\"$SERVICE_DATE\",\"quantity\":1}],
    \"contactEmail\":\"$EMAIL\"
  }")
SECOND_ORDER_ID=$(echo "$HOLD_CHECK" | jget '.orderId')
check "a second order on the same date also holds inventory" "$([ -n "$SECOND_ORDER_ID" ] && [ "$SECOND_ORDER_ID" != "null" ] && echo true || echo false)"

head2 "Payment (mock gateway)"
# 4242... approves; the order should confirm and issue a ticket.
PAY=$(curl -fsS -X POST "$API/api/v1/orders/$ORDER_ID/pay" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "method":"CARD",
    "idempotencyKey":"smoke-'"$(date +%s)"'-'"$ORDER_ID"'",
    "card":{"number":"4242424242424242","expMonth":12,"expYear":2030,"cvc":"123","holderName":"Smoke Test"}
  }')
PAY_STATUS=$(echo "$PAY" | jget '.status')
check "POST /orders/:id/pay captures payment (status=$PAY_STATUS)" "$(echo "$PAY_STATUS" | grep -q 'CAPTURED' && echo true || echo false)"

DETAIL2=$(curl -fsS "$API/api/v1/orders/$ORDER_ID" -H "Authorization: Bearer $TOKEN")
ORDER_STATUS=$(echo "$DETAIL2" | jget '.status')
check "order transitions to CONFIRMED (${ORDER_STATUS:-none})" "$(echo "$ORDER_STATUS" | grep -q 'CONFIRMED' && echo true || echo false)"
ORDER_LINE_COUNT=$(echo "$DETAIL2" | jget '.items' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).length)}catch{console.log(0)}});")
check "multi-line cart becomes one order with two lines" "$([ "${ORDER_LINE_COUNT:-0}" -eq 2 ] && echo true || echo false)"

head2 "Customer itinerary"
ITINERARY=$(curl -fsS -X POST "$API/api/v1/itineraries" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Smoke test trip","destinationSummary":"Test destination"}')
ITINERARY_ID=$(echo "$ITINERARY" | jget '.id')
check "customer can create a trip plan" "$([ -n "$ITINERARY_ID" ] && [ "$ITINERARY_ID" != "null" ] && echo true || echo false)"
curl -fsS -X POST "$API/api/v1/itineraries/$ITINERARY_ID/items" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"orderId\":\"$ORDER_ID\",\"day\":2}" >/dev/null
ITINERARIES=$(curl -fsS "$API/api/v1/itineraries" -H "Authorization: Bearer $TOKEN")
check "confirmed booking appears in its selected trip day" "$(echo "$ITINERARIES" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const a=JSON.parse(d);console.log(a.some(p=>p.id==='$ITINERARY_ID'&&p.items.some(i=>i.orderId==='$ORDER_ID'&&i.day===2)))}catch{console.log(false)}});" | grep -q true && echo true || echo false)"

TICKET_NUM=$(echo "$DETAIL2" | jget '.tickets.0.ticketNumber')
check "an e-ticket was issued (${TICKET_NUM:-none})" "$([ -n "$TICKET_NUM" ] && [ "$TICKET_NUM" != "null" ] && echo true || echo false)"

head2 "Declined card"
DECLINE_ORDER=$(curl -fsS -X POST "$API/api/v1/orders" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"lines\":[{\"ticketTypeId\":\"$TICKET_TYPE_ID\",\"serviceDate\":\"$SERVICE_DATE\",\"quantity\":1}],
    \"contactEmail\":\"$EMAIL\"
  }")
DECLINE_ID=$(echo "$DECLINE_ORDER" | jget '.orderId')
DECLINE_PAY=$(curl -fsS -X POST "$API/api/v1/orders/$DECLINE_ID/pay" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "method":"CARD",
    "idempotencyKey":"smoke-decline-'"$(date +%s)"'",
    "card":{"number":"4000000000000002","expMonth":12,"expYear":2030,"cvc":"123"}
  }')
check "a declined card returns FAILED" "$(echo "$DECLINE_PAY" | jget '.status' | grep -q 'FAILED' && echo true || echo false)"

head2 "Gate redemption"
STAFF=$(curl -fsS -X POST "$API/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"operator@easytrip.test","password":"Password123!"}')
STAFF_TOKEN=$(echo "$STAFF" | jget '.token')
check "operator can log in" "$([ -n "$STAFF_TOKEN" ] && [ "$STAFF_TOKEN" != "null" ] && echo true || echo false)"

SCAN=$(curl -fsS -X POST "$API/api/v1/scan/verify" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -d "{\"code\":\"$TICKET_NUM\",\"gate\":\"Main Gate\",\"commit\":true}")
check "gate scan validates the ticket" "$(echo "$SCAN" | jget '.valid' | grep -q true && echo true || echo false)"

RESCAN=$(curl -fsS -X POST "$API/api/v1/scan/verify" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  -d "{\"code\":\"$TICKET_NUM\",\"gate\":\"Main Gate\",\"commit\":true}")
check "re-scanning a used ticket is rejected" "$(echo "$RESCAN" | jget '.result' | grep -q 'ALREADY_USED' && echo true || echo false)"

head2 "Cancellation & refund"
QUOTE=$(curl -fsS "$API/api/v1/orders/$SECOND_ORDER_ID/cancellation-quote" -H "Authorization: Bearer $TOKEN")
check "cancellation quote is returned" "$(echo "$QUOTE" | jget '.refundBps' | grep -qv 'null' && echo true || echo false)"

CANCEL=$(curl -fsS -X POST "$API/api/v1/orders/$SECOND_ORDER_ID/cancel" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"reason":"smoke test cancellation"}')
REFUND_CENTS=$(echo "$CANCEL" | jget '.refundCents')
check "cancellation records a refund (${REFUND_CENTS:-0} cents)" "$([ "${REFUND_CENTS:-0}" -gt 0 ] && echo true || echo false)"

head2 "Reviews"
REVIEWS=$(curl -fsS "$API/api/v1/products/$FIRST_SLUG/reviews")
check "GET reviews returns an aggregate score" "$(echo "$REVIEWS" | jget '.summary.average' | grep -qv 'null' && echo true || echo false)"

POST_REVIEW=$(curl -fsS -X POST "$API/api/v1/products/$FIRST_SLUG/reviews" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"rating\":5,\"title\":\"Smoke test review\",\"body\":\"This review was created by the automated smoke test to verify the review pipeline end to end.\"}")
check "POST a verified review" "$(echo "$POST_REVIEW" | jget '.id' | grep -qv 'null' && echo true || echo false)"

head2 "Loyalty"
ACCOUNT=$(curl -fsS "$API/api/v1/loyalty/account" -H "Authorization: Bearer $TOKEN")
check "loyalty account is readable" "$(echo "$ACCOUNT" | jget '.tier' | grep -qv 'null' && echo true || echo false)"

head2 "Notification centre (durable half of realtime)"
NOTIFS=$(curl -fsS "$API/api/v1/notifications" -H "Authorization: Bearer $TOKEN")
NOTIF_COUNT=$(echo "$NOTIFS" | jget '.items' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).length)}catch{console.log(0)}});")
check "GET /notifications returns items (${NOTIF_COUNT:-0})" "$([ "${NOTIF_COUNT:-0}" -gt 0 ] && echo true || echo false)"

NOTIF_FOR_ORDER=$(echo "$NOTIFS" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(o.items.some(n=>n.orderId==='$ORDER_ID'))}catch{console.log(false)}});")
check "a durable notification exists for the confirmed order" "$([ "$NOTIF_FOR_ORDER" = "true" ] && echo true || echo false)"

NOTIF_ID=$(echo "$NOTIFS" | jget '.items.0.id')
READ=$(curl -fsS -X POST "$API/api/v1/notifications/$NOTIF_ID/read" -H "Authorization: Bearer $TOKEN")
check "POST /notifications/:id/read marks it read" "$(echo "$READ" | jget '.ok' | grep -q true && echo true || echo false)"

ANON_NOTIFS=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/notifications")
check "notifications reject anonymous access (401)" "$([ "$ANON_NOTIFS" = "401" ] && echo true || echo false)"

head2 "Admin"
ADMIN=$(curl -fsS -X POST "$API/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@easytrip.test","password":"Password123!"}')
ADMIN_TOKEN=$(echo "$ADMIN" | jget '.token')

DASH=$(curl -fsS "$API/api/v1/admin/dashboard" -H "Authorization: Bearer $ADMIN_TOKEN")
check "admin dashboard loads KPIs" "$(echo "$DASH" | jget '.kpis.grossRevenueCents' | grep -qv 'null' && echo true || echo false)"

ADMIN_PRODUCTS=$(curl -fsS "$API/api/v1/admin/products" -H "Authorization: Bearer $ADMIN_TOKEN")
check "admin product list loads" "$(echo "$ADMIN_PRODUCTS" | jget '.total' | grep -qv 'null' && echo true || echo false)"

LEDGER=$(curl -fsS "$API/api/v1/admin/finance/ledger" -H "Authorization: Bearer $ADMIN_TOKEN")
# The ledger legitimately starts empty; assert the envelope shape instead.
LEDGER_KEYS=$(echo "$LEDGER" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);console.log(Array.isArray(o.entries)&&Array.isArray(o.totals)?'ok':'bad')}catch{console.log('bad')}});")
check "finance ledger loads" "$([ "$LEDGER_KEYS" = "ok" ] && echo true || echo false)"

head2 "Authorisation"
FORBIDDEN=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/admin/dashboard")
check "admin routes reject anonymous access (403/401)" "$([ "$FORBIDDEN" = "403" ] || [ "$FORBIDDEN" = "401" ] && echo true || echo false)"

USER_ON_ADMIN=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/admin/dashboard" -H "Authorization: Bearer $TOKEN")
check "admin routes reject customer access (403)" "$([ "$USER_ON_ADMIN" = "403" ] && echo true || echo false)"

# ---------------------------------------------------------------------------
printf "\n\033[1m══ Summary ══\033[0m\n"
printf "  passed: %d\n  failed: %d\n" "$PASS" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  red "Smoke test FAILED"
  exit 1
fi

green "All smoke tests passed."
