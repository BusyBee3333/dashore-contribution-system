#!/usr/bin/env bash
# Run the daily open questions digest
# Posts top unanswered questions to Discord via webhook

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Load .env file if present (fallback for cron environments where signet can't expose values)
if [ -f "$PROJECT_DIR/.env" ]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env"
  set +o allexport
fi

# Load secrets from signet if available (supplements .env; won't override existing vars)
if command -v signet &>/dev/null; then
  export DISCORD_DIGEST_WEBHOOK_URL="${DISCORD_DIGEST_WEBHOOK_URL:-$(signet secret get DISCORD_DIGEST_WEBHOOK_URL 2>/dev/null || true)}"
  export DISCORD_LEVELUP_WEBHOOK_URL="${DISCORD_LEVELUP_WEBHOOK_URL:-$(signet secret get DISCORD_LEVELUP_WEBHOOK_URL 2>/dev/null || true)}"
  export DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-$(signet secret get DISCORD_BOT_TOKEN 2>/dev/null || true)}"
fi

echo "[$(date)] Running open-questions-digest..."
node scripts/open-questions-digest.js "$@"
echo "[$(date)] Done."
