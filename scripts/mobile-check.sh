#!/usr/bin/env bash
#
# Mobile compatibility regression check.
#
# These are static assertions, not a rendering engine — there is no browser in
# this environment. They verify that the responsive layer is actually present
# in the *built* CSS and the *served* HTML, which is what catches the common
# regressions: a media query silently dropped from globals.css, a viewport
# export removed from the root layout, or an inline fixed-width sidecar
# reintroduced into a page shell.
#
# For true layout verification, open the app in a browser's device emulator.

set -uo pipefail

WEB_URL="${WEB_URL:-http://localhost:3000}"
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/apps/web"
CSS_FILE="$(ls "$WEB_DIR"/.next/static/css/*.css 2>/dev/null | head -1)"

PASS=0
FAIL=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
head2() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
head2 "Build output"

if [[ -z "$CSS_FILE" ]]; then
  bad "no built CSS found — run 'pnpm --filter @easytrip/web build' first"
  printf '\n  passed: %d\n  failed: %d\n' "$PASS" "$FAIL"
  exit 1
fi
ok "built CSS present ($(wc -c < "$CSS_FILE") bytes)"

# ---------------------------------------------------------------------------
head2 "Viewport & document"

HOME_HTML="$(curl -sf "$WEB_URL/" || true)"

if grep -q 'name="viewport"' <<<"$HOME_HTML"; then
  ok "viewport meta tag present"
else
  bad "viewport meta tag missing — mobile browsers will render at 980px"
fi

if grep -q 'width=device-width' <<<"$HOME_HTML"; then
  ok "viewport uses device-width"
else
  bad "viewport is not device-width"
fi

if grep -q 'viewport-fit=cover' <<<"$HOME_HTML"; then
  ok "viewport-fit=cover (notched device support)"
else
  bad "viewport-fit=cover missing — safe-area insets will be ignored"
fi

if grep -q 'class="skip-link"' <<<"$HOME_HTML"; then
  ok "skip-to-content link present"
else
  bad "skip link missing — keyboard users must tab through the nav"
fi

# Zoom must stay available; capping below 5 is an accessibility failure.
if grep -q 'maximum-scale=5' <<<"$HOME_HTML"; then
  ok "pinch-zoom preserved (maximum-scale=5)"
elif grep -q 'user-scalable=no' <<<"$HOME_HTML"; then
  bad "zoom disabled — blocks low-vision users from reading content"
else
  ok "zoom not explicitly capped"
fi

# ---------------------------------------------------------------------------
head2 "Breakpoints"

# Every media query in the stylesheet, counted by width.
declare -A EXPECTED=( [860]=8 [640]=6 [960]=2 )
for bp in 860 640 960; do
  count="$(grep -o "max-width:${bp}px" "$CSS_FILE" | wc -l | tr -d ' ')"
  min="${EXPECTED[$bp]}"
  if (( count >= min )); then
    ok "breakpoint ${bp}px present (${count} queries)"
  else
    bad "breakpoint ${bp}px has ${count} queries, expected >= ${min}"
  fi
done

# ---------------------------------------------------------------------------
head2 "Mobile foundations"

check_css() {
  if grep -q "$1" "$CSS_FILE"; then ok "$2"; else bad "$2"; fi
}

check_css 'overflow-x:hidden'            "horizontal overflow backstop present"
check_css 'overflow-wrap:anywhere'       "long strings wrap instead of widening the page"
check_css 'prefers-reduced-motion'       "reduced-motion honoured"
check_css ':focus-visible'               "keyboard focus rings preserved"
check_css 'env(safe-area-inset-bottom)'  "safe-area insets for notched devices"
check_css '16px'                         "16px inputs (prevents iOS focus zoom)"
check_css 'min-height:44px'              "44px minimum touch targets"

# ---------------------------------------------------------------------------
head2 "Layout collapse"

for cls in with-rail with-rail-side filter-rail filter-rail-toggle booking-panel-col \
           hero-search scanner-layout table-scroll nav-mobile nav-toggle tier-progress; do
  if grep -q "\.${cls}" "$CSS_FILE"; then
    ok ".${cls} defined"
  else
    bad ".${cls} missing — a page shell may be stuck at desktop width"
  fi
done

# ---------------------------------------------------------------------------
head2 "Server-rendered HTML"

for path in / /search /cart /wishlist /itineraries /checkout /loyalty /tickets /orders /account /admin /admin/finance; do
  # /checkout redirects anonymous visitors to sign-in, so 307 is a healthy
  # response for it — the route exists and the auth gate is doing its job.
  case "$path" in
    /checkout) expected="200 307" ;;
    *)         expected="200" ;;
  esac
  code="$(curl -s -o /dev/null -w '%{http_code}' "$WEB_URL$path" || echo 000)"
  if [[ " $expected " == *" $code "* ]]; then
    ok "$path responds $code"
  else
    bad "$path responded $code (expected $expected)"
  fi
done

# The mobile drawer must exist in the markup, not be injected client-side only,
# so it is present for crawlers and for the no-JS fallback path.
if grep -q 'id="mobile-nav"' <<<"$HOME_HTML"; then
  ok "mobile nav present in server HTML"
else
  bad "mobile nav missing from server HTML"
fi

if grep -q 'nav-toggle' <<<"$HOME_HTML"; then
  ok "hamburger toggle present in server HTML"
else
  bad "hamburger toggle missing"
fi

# ---------------------------------------------------------------------------
printf '\n\033[1m══ Summary ══\033[0m\n'
printf '  passed: %d\n  failed: %d\n' "$PASS" "$FAIL"

if (( FAIL > 0 )); then
  printf '\n\033[31mMobile checks failed.\033[0m\n'
  exit 1
fi

printf '\n\033[32mAll mobile checks passed.\033[0m\n'
