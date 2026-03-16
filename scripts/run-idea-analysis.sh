#!/bin/bash
cd /Users/jakeshore/.clawdbot/workspace/contribution-system
node scripts/analyze-ideas.js --hours 48 2>&1 | tail -20
