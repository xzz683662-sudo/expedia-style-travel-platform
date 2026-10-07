---
name: apify-toolkit
description: 'Routing guide for the 28 globally installed Apify Agent Skills (apify/awesome-skills). Use when a task in this repo needs live web data — competitor travel pricing, accommodation host or supplier contacts, attraction and local-business discovery, ad or AI-search visibility research, triaging a supply scrape that came back blocked or empty, or keyless paid data access — so you pick the right Apify skill instead of improvising a scraper.'
argument-hint: '(task, e.g. "competitor flight prices", "hotel host emails", "supply fetch got 403")'
user-invocable: true
---

# Apify Toolkit — which skill to call, when

The [apify/awesome-skills](https://github.com/apify/awesome-skills) collection is
installed **once, globally**, and discovered by VS Code. Do not vendor a copy into
this repo. When a task needs live web data the repo does not already model, load
the matching skill below instead of hand-rolling a scraper.

## Where they live / how they are wired

| Thing | Value |
| --- | --- |
| Clone | `~/agent-skills/apify-awesome-skills` |
| Skills root | `~/agent-skills/apify-awesome-skills/skills` — 28 installable skills + `_template` |
| Registration | VS Code setting `chat.agentSkillsLocations` = `{ "~/agent-skills/apify-awesome-skills/skills": true }` |
| Toggle | `chat.useAgentSkills: true` (machine + user settings) |
| Refresh | `cd ~/agent-skills/apify-awesome-skills && git pull` — new skills are picked up on the next request |
| Validate | `python3 scripts/lint_references.py` from that clone (offline reference check) |

`_template/` has an empty `name`, so discovery skips it — ignore it.

## Guardrails before you call one

- **Actors cost money and hit third-party sites.** Prefer the repo's own adapters
  (`apps/api/src/modules/supply/`, `modules/inventory-feed/`) for anything
  EasyTrip already owns. Apify is for data the repo does not have.
- **Never send repo secrets** (`.env`, JWT signing keys, payment keys) to an
  Actor input. Pass only the public identifiers a lookup needs.
- **Read the skill, then the Actor's input schema.** Do not guess input fields.
- Treat scraped prices/dates as **research, never a bookable rate.** A scraped
  number must not reach an `OrderItem` snapshot without going through
  `modules/pricing/`.
- These skills advise and research; they never book, pay, or mutate this repo.

## Routing table

### Tier A — supply & product research (domain-facing)

| Task in this repo | Skill |
| --- | --- |
| Competitor OTA catalogue / attraction prices, marketplace intelligence | `apify-ecommerce` |
| Accommodation **supplier/host contacts** (hotels, apartments, rentals) for supply onboarding | `apify-booking-host-leads` |
| Find local attractions/operators and decision-maker contacts by city | `apify-google-maps-leads` (or `apify-local-business-leads-osm` as the no-Google path) |
| Whole-competitor teardown: pricing, positioning, review sentiment, battlecard | `apify-easy-competitive-intelligence` |
| Flight / itinerary research and fare comparison (advise only — never books) | `apify-plan-travel` |

### Tier B — engineering the scraping / supply layer

| Task in this repo | Skill |
| --- | --- |
| A supply / live-rate / inventory fetch returns 0 items, 403, 429, a challenge page, or empty HTML | `apify-blocked-scrape-triage` |
| Wire an agent or RAG flow to live product data; "the assistant quotes stale prices" | `apify-product-data-setup` |
| Run Actors with **no Apify account or API key** (pay USDC on Base per use) | `apify-x402-agentic-wallet` |
| Build a TypeScript Apify **orchestrator** Actor that chains sub-Actors | `apify-orchestrator-actor-development` |

### Tier C — growth, SEO & marketing

| Task | Skill |
| --- | --- |
| Is EasyTrip cited in AI Overviews / ChatGPT / Perplexity / Gemini vs competitors | `apify-ai-search-visibility-tracker` |
| Competitor ad creatives and copy (Meta, Google, TikTok, LinkedIn, X) | `apify-ads-intelligence` |
| Link-building prospects, unlinked brand mentions, outreach copy | `apify-link-prospecting-outreach` |
| Influencer/creator emails; Instagram brand–creator collab audit | `apify-creator-emails`, `apify-influencer-brand-collabs` |
| Agency/company databases, verified emails, lead scoring, buying signals | `apify-marketing-agency-database`, `apify-company-data-api`, `apify-verified-email-finder`, `apify-lead-scoring-enrichment`, `apify-buying-signal-detection` |

### Tier D — content, ops & security

| Task | Skill |
| --- | --- |
| Destination sentiment / traveller discussion on Reddit | `apify-reddit-scraper` |
| Yandex SERP or image sourcing (RU market, destination imagery) | `apify-yandex-search-api`, `apify-yandex-image-search-api` |
| CVE / breach / attack-surface / threat-intel checks for the platform | `apify-osint-threat-intel` |
| Hiring demand, salary, job-board or careers-page monitoring | `apify-jobs-data`, `apify-job-boards`, `apify-ashby-jobs-scraper` |
| App Store / Play metadata, rating, ASO watch | `apify-app-store-intelligence` |

## After the data comes back

- Land external data through the repo's normal path — a seed/fixture or a
  `modules/*` import — never straight into pricing or a ticket.
- Verify with the repo gates: `.github/skills/verify-the-change/SKILL.md`.
