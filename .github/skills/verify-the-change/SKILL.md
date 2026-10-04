---
name: verify-the-change
description: 'Use when implementing, fixing, refactoring, or verifying any change in the expedia-style-travel-platform monorepo. This workflow forces a root-cause diagnosis, repo-specific guardrails, and fresh evidence from the real verification gates before claiming a fix is complete.'
argument-hint: '[change, e.g. "fix ticketing refund calculation" or "add Prisma column and seed"]'
user-invocable: true
---

# Verify the Change

Project-scoped workflow for the Expedia-style travel platform. Load this skill before making or verifying a change in this repo.

## When to use

Use this skill for:
- debugging an existing bug or flaky behavior
- implementing a feature or route change
- updating Prisma schema, seed scripts, or data contracts
- changing payment, ticketing, pricing, search, or realtime code
- preparing a patch for review and verification

## Core rule

Never claim a fix is complete without fresh evidence from the repo's actual verification flow. The goal is not "it looks right"; the goal is "the repo passed the relevant checks against the current code".

## Workflow

### 1. Reproduce the issue or confirm the change target

- Capture the exact symptom, endpoint, route, or failing behavior.
- If the issue is in a database or seed path, reproduce with the minimal real command instead of guessing.
- If the change is not yet reproducible, create a focused failing check or minimal reproduction before editing.

Examples:
- `scripts/smoke-test.sh`
- `pnpm verify`
- `(cd apps/api && set -a && . ../../.env && set +a && pnpm db:seed)`
- `pnpm --filter @easytrip/web build` before CSS-based mobile checks

### 2. Read the narrowest relevant context

- Start with the exact file or module under change.
- Check the repo playbook before assuming commands or framework behavior.
- Read the code path and the closest tests or scripts that already validate the feature.

For this repo, especially verify:
- Prisma schema and seed scripts
- Fastify route/auth/plugin patterns
- env loading and Prisma CLI behavior
- ticketing storage and artifact generation
- money and refund logic
- Next.js App Router caveats

### 3. Diagnose the root cause before patching

A fix should explain the actual failure mode, not just the symptom.

Check for repo-specific traps before editing:
- stale `tsx watch` or `preflight.cjs` processes may keep old code alive
- Prisma CLI needs `.env` loaded explicitly for db commands
- `prisma db push` can block in CI/non-TTY without `--accept-data-loss`
- money/refund checks can treat `0` as missing data
- schema/seed work can create columns that are never read
- Fastify async/sync hook behavior can silently produce hangs or 401/500 distortions

### 4. Make the smallest root-cause fix

- Prefer one precise change over broad refactors.
- Keep the patch aligned with the domain layer and route contract.
- Do not add dead fields, silent coercions, or speculative "fixes" without a reader or validation path.
- If schema or seeds changed, confirm the column is actually consumed by code.

### 5. Verify with the real project gates

Use the repo's intended checks, then stop only when they pass.

Minimum verification paths:
- `pnpm verify` for the full default gate
- `scripts/schema-audit.sh` when Prisma or seed data changed
- `scripts/smoke-test.sh` for API behavior
- `scripts/mobile-check.sh` after a web build
- `realtime-test.mjs` when the realtime module is affected

Important repo conventions:
- run `pnpm --filter @easytrip/web build` before mobile CSS checks
- if a stale dev server is suspected, clear it before restarting: `pkill -f 'tsx watch'; pkill -f preflight.cjs`
- for Prisma CLI tasks, load the root env explicitly: `(cd apps/api && set -a && . ../../.env && set +a && ...)`

### 6. Review the final evidence before finishing

Only finish when all of the following are true:
- the root cause is identified and the fix matches it
- the relevant verification command exited successfully
- no stale watchers or environment drift are masking the result
- the change is consistent with repo conventions and domain rules

## Decision points

### If the issue is schema-driven
- check the Prisma model, seed script, and consumer code together
- run `scripts/schema-audit.sh`
- confirm that each new field has a valid reader, not just a writer

### If the issue is runtime API logic
- check route/auth/plugin flow in `apps/api/src`
- verify the request lifecycle and Fastify behavior before patching
- re-run smoke checks or the relevant route flow

### If the issue is UI or frontend behavior
- verify the App Router constraints and built CSS conditions
- use the actual web build and smoke flow, not ad hoc assumptions

### If the issue involves tickets, money, or payments
- validate the domain model and generated artifacts before considering it fixed
- do not accept `0` or empty values as “not set” unless the code explicitly distinguishes them

## Completion checks

A task is only complete when:
1. the reproduction or failing signal is understood
2. the root cause has been stated clearly
3. the fix addresses the root cause, not just the visible symptom
4. the relevant repo verification command passed with fresh output
5. no unverified assumptions remain

## Suggested prompt patterns

- “Debug this regression in the ticketing flow and verify it with the repo’s real checks.”
- “Trace the root cause of this Prisma seed mismatch and confirm the fix with the schema audit.”
- “Implement the minimal fix for this API bug and prove it with smoke verification.”
- “Add the feature, then verify it against the project’s typecheck/smoke/realtime/mobile gates.”

## Related customizations

Consider pairing this skill with:
- a repo playbook for project facts and pitfalls
- a schema/seed validation instruction for Prisma-heavy changes
- a release-verification prompt for final QA passes
- a domain-specific skill for payments, ticketing, or realtime work
