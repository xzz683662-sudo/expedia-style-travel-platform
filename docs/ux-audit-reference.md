# Reference site audit — expedia.com

## Result: blocked by an anti-bot interstitial

The audit reached `https://www.expedia.com/` but the response was a bot challenge, not the
storefront. No rendering signals could be collected, so no findings are recorded.

This is expected for an automated browser against a large commercial site and is not
a defect in this repository. To audit the reference manually, open the URL in a normal
browser and compare against the checklist in this file.

**Checklist for the manual pass** (the same signals the automated audit measures):

- Every image renders (no empty boxes where a thumbnail should be).
- No section overflows the viewport horizontally; no clipped text.
- Headings, nav and tabs respond on click, on desktop and at 390px.
- Card copy matches its image (a photo of a beach under "city walking tour" is a defect).
- The primary search form is usable end to end without a layout jump.

**Summary:** 0 error(s), 0 warning(s), 0 informational.

| Page | Errors | Warnings | Info | Screenshot |
| --- | ---: | ---: | ---: | --- |
