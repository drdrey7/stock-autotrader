#!/usr/bin/env bash
set -Eeuo pipefail

require_env_key() {
  local file=$1 key=$2
  local value
  value=$(sed -n "s/^${key}=//p" "$file" | tail -n 1)
  case "$value" in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac
  [[ "$value" =~ [^[:space:]] ]] || {
    echo "ERROR: $key is missing from $file" >&2
    return 1
  }
}

validate_provider_env() {
  local file=$1
  local provider
  provider=$(sed -n 's/^TRADINGAGENTS_LLM_PROVIDER=//p' "$file" | tail -n 1)
  case "$provider" in
    \"*\") provider=${provider#\"}; provider=${provider%\"} ;;
    \'*\') provider=${provider#\'}; provider=${provider%\'} ;;
  esac
  case "$provider" in
    google) require_env_key "$file" GOOGLE_API_KEY ;;
    openai) require_env_key "$file" OPENAI_API_KEY ;;
    openrouter) require_env_key "$file" OPENROUTER_API_KEY ;;
    openai_compatible)
      require_env_key "$file" OPENAI_COMPATIBLE_API_KEY
      require_env_key "$file" TRADINGAGENTS_LLM_BACKEND_URL
      ;;
    *)
      echo "ERROR: unsupported TRADINGAGENTS_LLM_PROVIDER" >&2
      return 1
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  [ "$#" -eq 1 ] || { echo "usage: $0 AI_ANALYSIS_ENV_FILE" >&2; exit 2; }
  validate_provider_env "$1"
fi
