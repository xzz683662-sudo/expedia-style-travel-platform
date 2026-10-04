#!/usr/bin/env bash
#
# Finds columns that are written but never read.
#
# Why this exists
# ---------------
# This repo has shipped the same defect three times:
#
#   a455c68  SearchDocument facets were backfilled, but service.ts only *wrote*
#            two of them and nothing read them back.
#   c16a230  OrderItem gained a stay snapshot that no response ever returned.
#   09a4681  Four category extension tables, six dead columns.
#
# In each case the schema change looked complete, typecheck passed, and the data
# was in Postgres — reaching nobody. `as number | undefined` and `any` suppress
# the compiler, and the writer (a seed or backfill) lands in a different commit
# from the reader (a route), so neither review sees the gap.
#
# What it checks
# --------------
# For every scalar column on a Prisma model, whether its name appears under
# `apps/api/prisma` (a writer: seed or backfill) and under `apps/api/src` (a
# reader). A column written and never read is reported.
#
# It is a heuristic, not a proof. A name can appear in a comment, in a different
# model's context, or behind a `select` that excludes it. So this reports
# candidates for review. Before changing anything, confirm the column genuinely
# has no reader — grep for the *model* name, not just the field name, because a
# route may project the whole row via `include` with no `select`.
#
# Usage: bash scripts/schema-audit.sh [--verbose]

set -uo pipefail

VERBOSE=false
[[ "${1:-}" == "--verbose" ]] && VERBOSE=true

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA="$ROOT/apps/api/prisma/schema.prisma"
WRITER_DIR="$ROOT/apps/api/prisma"
READER_DIR="$ROOT/apps/api/src"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$1"; }
dim()  { printf '  \033[2m%s\033[0m\n' "$1"; }

if [[ ! -f "$SCHEMA" ]]; then
  printf 'schema-audit: %s not found\n' "$SCHEMA" >&2
  exit 2
fi

# Build the source vocabulary ONCE. A per-column `grep -r` across the api tree is
# ~70 greps per model and dominates the runtime; two passes over one concatenated
# corpus is a fraction of that.
dim "  collecting source references..."
WRITER_CORPUS=$(mktemp)
READER_CORPUS=$(mktemp)
cleanup() { rm -f "$WRITER_CORPUS" "$READER_CORPUS"; }
trap cleanup EXIT

find "$WRITER_DIR" -name '*.ts' -type f -print0 2>/dev/null | xargs -0 cat 2>/dev/null > "$WRITER_CORPUS"
find "$READER_DIR" -name '*.ts' -type f -print0 2>/dev/null | xargs -0 cat 2>/dev/null > "$READER_CORPUS"

# Structural columns, plus names generic enough to collide on any grep.
SKIP_NAMES='id|createdAt|updatedAt|deletedAt|slug|uuid|version|email|name|code|type|status|createdBy|updatedBy'

# Types that are NOT scalar columns: only the models and enums declared in this
# schema. Prisma's own scalars (`String`, `Int`, `DateTime`, `Json`, ...) are
# exactly what we DO want to audit, so they must not appear here — including
# them skipped every field and the audit silently reported success having
# checked nothing.
KNOWN_TYPES=$(grep -oE '^(model|enum)[[:space:]]+[A-Za-z0-9_]+' "$SCHEMA" | awk '{print $2}' | sort -u | paste -sd '|' -)

bold "══ Schema audit: columns written but never read ══"
dim "  schema: ${SCHEMA#"$ROOT"/}"

audit_results=()
model_count=0
checked=0
current_model=""

# Load every line up front so each field can look at the line that follows it.
# Prisma routinely puts `@relation` on the line BELOW the field, so judging a
# field from its own line alone misses every foreign key in the file — that is
# how `Merchant.ownerUserId` was wrongly reported as dead.
#
# Reading the file into an array (rather than a `while` over a pipe) also keeps
# the loop in the current shell: a `while` inside a pipeline runs in a subshell,
# and every append to an array is silently thrown away there. That bug shipped
# in the first draft of this script and made it report "no dead columns" while
# having checked nothing at all.
mapfile -t LINES < "$SCHEMA"
total=${#LINES[@]}

for (( idx = 0; idx < total; idx++ )); do
  line="${LINES[idx]}"
  next_line=""
  (( idx + 1 < total )) && next_line="${LINES[idx + 1]}"

  if [[ "$line" =~ ^model[[:space:]]+([A-Za-z0-9_]+)[[:space:]]*\{ ]]; then
    current_model="${BASH_REMATCH[1]}"
    model_count=$((model_count + 1))
    continue
  fi

  [[ "$line" == "}" ]] && { current_model=""; continue; }
  [[ -z "$current_model" ]] && continue
  [[ "$line" =~ ^[[:space:]]*// ]] && continue
  [[ "$line" =~ ^[[:space:]]*(///|@) ]] && continue

  if [[ "$line" =~ ^[[:space:]]+([A-Za-z0-9_]+)[[:space:]]+([A-Za-z0-9_]+)(\[\])?(.*)$ ]]; then
    field="${BASH_REMATCH[1]}"
    ftype="${BASH_REMATCH[2]}"
    is_array="${BASH_REMATCH[3]:-}"
    rest="${BASH_REMATCH[4]:-}"

    # Relations have no column; array columns are filter payloads, not projections.
    # The `@relation` test spans two lines because Prisma writes it either way.
    [[ "$rest" == *@relation* || "$next_line" == *@relation* ]] && continue
    [[ -n "$is_array" ]] && continue
    # Skip a field whose type names a model or enum in this schema: that is a
    # relation, and Prisma stores no column for it. A field typed with a Prisma
    # scalar IS a column and is exactly what we are here to audit.
    [[ "|$KNOWN_TYPES|" == *"|$ftype|"* ]] && continue
    [[ "|$SKIP_NAMES|" == *"|$field|"* ]] && continue

    checked=$((checked + 1))

    # `-F` fixed-string: a field name may contain regex metacharacters, and
    # `grep -w` is unreliable across implementations for names with underscores.
    if grep -qF -- "$field" "$WRITER_CORPUS"; then
      if ! grep -qF -- "$field" "$READER_CORPUS"; then
        audit_results+=("${current_model}.${field}")
      elif [[ "$VERBOSE" == true ]]; then
        dim "  ok  ${current_model}.${field}"
      fi
    fi
  fi
done

dim "  scanned ${model_count} models, ${checked} scalar columns"

# A zero here means the parser matched nothing, which is indistinguishable from
# a clean result unless it is treated as a hard error. This script exists to
# catch silently-dead columns; it must never be one of them.
if [[ "$checked" -lt 100 ]]; then
  printf '\n'
  bold "  Audit did not inspect enough columns (${checked}) to be trustworthy."
  bold "  Treat this as a failure of the parser, not as a clean schema."
  exit 1
fi

if [[ ${#audit_results[@]} -eq 0 ]]; then
  printf '\n'
  bold "  No dead columns found."
  bold "  Every scalar column a seed or backfill writes is read somewhere under apps/api/src."
  exit 0
fi

printf '\n'
bold "  ${#audit_results[@]} column(s) written but never read:"
for entry in "${audit_results[@]}"; do
  warn "$entry"
done

cat <<'GUIDANCE'

  Each is a candidate, not a verdict. Confirm the column genuinely has no reader
  before touching it: grep the *model* name, not just the field name, because a
  route may project the whole row via `include` with no `select`.

  If it really is unread, surface it or drop it. A column nobody can reach is
  worse than no column — it reads like a feature that exists.
GUIDANCE

exit 1