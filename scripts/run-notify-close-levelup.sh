#!/usr/bin/env bash
# Run the close-to-levelup DM notifier
# Sends DMs to members within 20% of the next level threshold

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Load secrets from signet if available
if command -v signet &>/dev/null; then
  export DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-$(signet secret get DISCORD_BOT_TOKEN 2>/dev/null || true)}"
  export DISCORD_DIGEST_WEBHOOK_URL="${DISCORD_DIGEST_WEBHOOK_URL:-$(signet secret get DISCORD_DIGEST_WEBHOOK_URL 2>/dev/null || true)}"
fi

echo "[$(date)] Running notify-close-to-levelup..."
node scripts/notify-close-to-levelup.js "$@"
echo "[$(date)] Done."
