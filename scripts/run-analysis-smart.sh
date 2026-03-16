#!/bin/bash
# Smart analysis pipeline — only runs AI scoring when there's signal
# 
# Flow:
#   1. Signal watcher (free, ~0.1s) — checks discrawl for activity
#   2. If signal detected → run AI conversation scorer ($$$)
#   3. Always run idea tracker (mostly free, GitHub check only)
#   4. Run contribution announcer (free, Discord API only)

cd /Users/jakeshore/.clawdbot/workspace/contribution-system

echo "[pipeline] Running signal watcher..."
node scripts/signal-watcher.js 2>&1
SIGNAL_EXIT=$?

if [ $SIGNAL_EXIT -eq 0 ]; then
  # Signal detected — run AI scoring
  echo "[pipeline] Signal detected! Running AI conversation scorer..."
  node scripts/analyze-conversations.js --hours 6 2>&1 | tail -5
elif [ $SIGNAL_EXIT -eq 2 ]; then
  # Quiet period — skip AI, save cost
  echo "[pipeline] Quiet period — skipping AI scoring (no signal)"
else
  # Error in signal watcher — run AI anyway (failsafe)
  echo "[pipeline] Signal watcher error — running AI scorer as failsafe"
  node scripts/analyze-conversations.js --hours 6 2>&1 | tail -5
fi

# Idea tracker always runs (cheap — just SQLite + GitHub API check)
echo "[pipeline] Running idea tracker..."
node scripts/analyze-ideas.js --hours 48 2>&1 | tail -5

# Announcer always runs (free — just Discord API)
echo "[pipeline] Running contribution announcer..."
node scripts/announce-contributions.js 2>&1 | tail -5

echo "[pipeline] Done."
