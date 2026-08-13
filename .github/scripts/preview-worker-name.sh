#!/usr/bin/env bash
# Single source of truth for preview Worker names.
set -euo pipefail

PR_NUMBER="${1:?usage: preview-worker-name.sh <pr-number>}"
if [[ ! "${PR_NUMBER}" =~ ^[1-9][0-9]*$ ]]; then
  echo "invalid PR number" >&2
  exit 1
fi
printf 'stock-autotrader-preview-pr-%s\n' "${PR_NUMBER}"
