#!/usr/bin/env bash
# Central preview worker naming for Stock Autotrader.
# Used by:
#   .github/workflows/deploy.yml          (preview deploy step)
#   .github/workflows/cleanup-preview.yml (PR closed/merged cleanup)
# Keep the sanitization identical in both workflows — this script is the single source of truth.
set -euo pipefail

BRANCH="${1:?usage: preview-worker-name.sh <branch>}"
BRANCH_SLUG="$(echo "${BRANCH}" | tr '/' '-' | tr '[:upper:]' '[:lower:]')"
echo "stock-autotrader-preview-${BRANCH_SLUG}"
