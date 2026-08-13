#!/usr/bin/env bash
# Single source of truth for preview Worker names.
set -euo pipefail

BRANCH="${1:?usage: preview-worker-name.sh <branch>}"
BRANCH_SLUG="$(printf '%s' "${BRANCH}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-')"
MAX_SLUG_LENGTH=29
if (( ${#BRANCH_SLUG} > MAX_SLUG_LENGTH )); then
  BRANCH_HASH="$(printf '%s' "${BRANCH}" | sha256sum | cut -c1-6)"
  BRANCH_SLUG="${BRANCH_SLUG:0:22}"
  BRANCH_SLUG="${BRANCH_SLUG%-}-${BRANCH_HASH}"
fi
printf 'stock-autotrader-preview-%s\n' "${BRANCH_SLUG}"
