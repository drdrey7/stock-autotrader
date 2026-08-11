#!/usr/bin/env bash
# Central preview worker naming for Stock Autotrader.
# Used by:
#   .github/workflows/deploy.yml          (preview deploy step)
#   .github/workflows/cleanup-preview.yml (PR closed/merged cleanup)
# Keep the sanitization identical in both workflows — this script is the single source of truth.
set -euo pipefail

BRANCH="${1:?usage: preview-worker-name.sh <branch>}"
# Cloudflare worker names allow only [a-zA-Z0-9-]; map anything else (/, ., etc.) to '-'.
BRANCH_SLUG="$(printf '%s' "${BRANCH}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-')"
# Cloudflare preview URLs cap Worker names at 54 characters. Keep the stable
# prefix, then add a short branch hash when truncation is needed to avoid
# collisions between similarly-prefixed branches.
MAX_SLUG_LENGTH=29
if (( ${#BRANCH_SLUG} > MAX_SLUG_LENGTH )); then
  BRANCH_HASH="$(printf '%s' "${BRANCH}" | sha256sum | cut -c1-6)"
  BRANCH_SLUG="${BRANCH_SLUG:0:22}"
  BRANCH_SLUG="${BRANCH_SLUG%-}-${BRANCH_HASH}"
fi
echo "stock-autotrader-preview-${BRANCH_SLUG}"
