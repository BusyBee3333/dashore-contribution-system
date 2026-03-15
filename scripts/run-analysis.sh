#!/bin/bash
cd /Users/jakeshore/.clawdbot/workspace/contribution-system
node scripts/analyze-conversations.js --hours 6 2>&1 | tail -5
