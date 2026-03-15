#!/bin/bash
cd /Users/jakeshore/.clawdbot/workspace/contribution-system
node scripts/weekly-digest.js --send 2>&1 | tail -10
