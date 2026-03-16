#!/bin/bash
# Start the voice recording + transcription daemon
# Run this alongside the main Buba Jr slash command bot

cd /Users/jakeshore/.clawdbot/workspace/contribution-system

export WHISPER_MODEL="${WHISPER_MODEL:-base}"
export DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}"

echo "[voice-daemon] Starting..."
node scripts/voice-daemon.mjs
