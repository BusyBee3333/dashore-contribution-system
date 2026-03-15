#!/bin/bash
cd /Users/jakeshore/.clawdbot/workspace/contribution-system
node scripts/sync-github.js --days 1 2>&1 | tail -5
