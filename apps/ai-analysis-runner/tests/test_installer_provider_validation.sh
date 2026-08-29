#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VALIDATOR="$REPO_ROOT/apps/ai-analysis-runner/deploy/validate-ai-analysis-provider.sh"
SANDBOX="$(mktemp -d /tmp/installer-provider-validation.XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

run_case() {
  local name=$1 expected=$2 contents=$3 file="$SANDBOX/$1.env"
  printf '%b\n' "$contents" > "$file"
  if bash "$VALIDATOR" "$file" >/dev/null 2>&1; then
    actual=pass
  else
    actual=fail
  fi
  if [ "$actual" != "$expected" ]; then
    printf 'FAIL %s: expected=%s actual=%s\n' "$name" "$expected" "$actual" >&2
    exit 1
  fi
  printf 'PASS %s\n' "$name"
}

run_case openrouter-pass pass 'TRADINGAGENTS_LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=placeholder'
run_case openrouter-missing-key fail 'TRADINGAGENTS_LLM_PROVIDER=openrouter'
run_case google-pass pass 'TRADINGAGENTS_LLM_PROVIDER=google
GOOGLE_API_KEY=placeholder'
run_case openai-pass pass 'TRADINGAGENTS_LLM_PROVIDER=openai
OPENAI_API_KEY=placeholder'
run_case compatible-pass pass 'TRADINGAGENTS_LLM_PROVIDER=openai_compatible
OPENAI_COMPATIBLE_API_KEY=placeholder
TRADINGAGENTS_LLM_BACKEND_URL=https://gateway.example/v1'
run_case unknown-provider fail 'TRADINGAGENTS_LLM_PROVIDER=unknown'

printf 'installer provider validation: PASS\n'
