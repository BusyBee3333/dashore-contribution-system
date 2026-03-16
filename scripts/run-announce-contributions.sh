#!/bin/bash
cd /Users/jakeshore/.clawdbot/workspace/contribution-system

# Source env vars if available
[ -f .env ] && source .env

node scripts/announce-contributions.js 2>&1 | tail -10
