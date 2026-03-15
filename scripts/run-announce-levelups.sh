#!/bin/bash
cd /Users/jakeshore/.clawdbot/workspace/contribution-system
# Load env vars (webhook URLs, etc.)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi
node scripts/announce-levelups.js 2>&1 | tail -10
