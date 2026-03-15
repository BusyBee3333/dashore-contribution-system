# DaShore Incubator — Contribution System & Leaderboard

A Discord contribution tracking system that uses **discrawl** for data collection
and **Claude AI** for conversation quality scoring.

## Architecture

```
discrawl (SQLite) ──▶ AI Scorer (Haiku/Sonnet) ──▶ Contribution DB ──▶ Discord Bot
GitHub webhooks ─────────────────────────────────────┘                      │
Discord events ──────────────────────────────────────┘                      │
Peer voting (/vouch) ────────────────────────────────┘               Leaderboard
```

## Setup

```bash
# 1. Install dependencies
cd contribution-system
npm install

# 2. Configure
cp config/config.example.json config/config.json
# Edit config.json with your settings

# 3. Initialize the contribution database
node scripts/init-db.js

# 4. Run first analysis
node scripts/analyze-conversations.js --days 7

# 5. Start the bot
node src/bot.js
```

## Components

- `src/bot.js` — Discord bot with slash commands
- `src/db.js` — Contribution database (SQLite)
- `src/scorer.js` — Claude AI conversation scorer
- `src/github.js` — GitHub integration
- `scripts/analyze-conversations.js` — Batch conversation analysis
- `scripts/init-db.js` — Initialize contribution DB
- `scripts/sync-github.js` — Pull GitHub contributions

## Guild

- **DaShore Incubator** (`1449158500344270961`)
- 17 human members, 5K+ messages in #general

## Scoring

Messages are pulled from discrawl, clustered into conversations, and scored by Claude Haiku.
Each conversation participant receives scores for helpfulness, teaching, and engagement quality.
Scores are multiplied by base point values and written to the contribution database.
