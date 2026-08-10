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
echo "stock-autotrader-preview-${BRANCH_SLUG}"
