# Cron Setup — Contribution System

All jobs are managed via the **Clawdbot cron scheduler** (`clawdbot cron`).

## Schedule Overview

| Job | Cron | Description |
|-----|------|-------------|
| `contribution-analysis` | `0 */6 * * *` | Analyze Discord conversations every 6 hours |
| `github-sync` | `0 2 * * *` | Sync GitHub PRs/issues/reviews daily at 2am |
| `weekly-digest` | `0 10 * * 1` | Post weekly digest on Mondays at 10am |
| `announce-levelups` | `*/30 * * * *` | Announce pending level-ups every 30 minutes |
| `open-questions-digest` | `0 9 * * *` | Daily digest of unanswered questions at 9am |
| `notify-close-levelup` | `0 */6 * * *` | DM members within 20% of next level, every 6h |

All times are **America/New_York**.

---

## Setup Commands

Run these once to register the cron jobs with Clawdbot:

```bash
# 1. Conversation analysis — every 6 hours
clawdbot cron add \
  --name "contribution-analysis" \
  --description "Analyze Discord conversations and score contributions" \
  --cron "0 */6 * * *" \
  --tz "America/New_York" \
  --message "Run the contribution analysis: bash /Users/jakeshore/.clawdbot/workspace/contribution-system/scripts/run-analysis.sh"

# 2. GitHub sync — daily at 2am
clawdbot cron add \
  --name "github-sync" \
  --description "Sync GitHub PRs, reviews, and issues" \
  --cron "0 2 * * *" \
  --tz "America/New_York" \
  --message "Run the GitHub contribution sync: bash /Users/jakeshore/.clawdbot/workspace/contribution-system/scripts/run-github-sync.sh"

# 3. Weekly digest — Mondays at 10am
clawdbot cron add \
  --name "weekly-digest" \
  --description "Post the weekly contribution digest to Discord" \
  --cron "0 10 * * 1" \
  --tz "America/New_York" \
  --message "Run the weekly digest: bash /Users/jakeshore/.clawdbot/workspace/contribution-system/scripts/run-weekly-digest.sh"

# 4. Level-up announcements — every 30 minutes
clawdbot cron add \
  --name "announce-levelups" \
  --description "Announce pending level-ups via Discord webhook" \
  --cron "*/30 * * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Announce any pending level-ups: bash /Users/jakeshore/.clawdbot/workspace/contribution-system/scripts/run-announce-levelups.sh"

# 5. Open questions digest — daily at 9am ET
clawdbot cron add \
  --name "open-questions-digest" \
  --description "Daily digest of unanswered questions in Discord" \
  --cron "0 9 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Run the open questions digest: bash /Users/jakeshore/.clawdbot/workspace/contribution-system/scripts/run-open-questions-digest.sh"

# 6. Close-to-levelup DMs — every 6 hours
clawdbot cron add \
  --name "notify-close-levelup" \
  --description "DM members who are within 20% of their next level threshold" \
  --cron "0 */6 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Run the close-to-levelup notifier: bash /Users/jakeshore/.clawdbot/workspace/contribution-system/scripts/run-notify-close-levelup.sh"
```

---

## Management

```bash
# List all jobs
clawdbot cron list

# Check status
clawdbot cron status

# Disable a job temporarily
clawdbot cron disable --name contribution-analysis

# Re-enable
clawdbot cron enable --name contribution-analysis

# Run a job right now (debug)
clawdbot cron run --name github-sync

# Remove a job
clawdbot cron rm --name weekly-digest

# View run history
clawdbot cron runs
```

---

## Environment Variables Required

| Variable | Used By | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | analysis | AI scoring for conversations |
| `DISCORD_DIGEST_WEBHOOK_URL` | digest, open-questions, level-ups fallback | Discord webhook for digest/announcements |
| `DISCORD_LEVELUP_WEBHOOK_URL` | announce-levelups | Dedicated webhook for #general level-up posts |
| `DISCORD_BOT_TOKEN` | notify-close-levelup | Bot token for sending DMs to members |

Set in shell environment or via `signet secret put KEY`.

See `scripts/setup-webhooks.md` for detailed webhook creation instructions.

---

## Shell Scripts

| Script | Description |
|--------|-------------|
| `scripts/run-analysis.sh` | Runs `analyze-conversations.js --hours 6` |
| `scripts/run-github-sync.sh` | Runs `sync-github.js --days 1` |
| `scripts/run-weekly-digest.sh` | Runs `weekly-digest.js --send` |
| `scripts/run-announce-levelups.sh` | Runs `announce-levelups.js` |
| `scripts/run-open-questions-digest.sh` | Runs `open-questions-digest.js` |
| `scripts/run-notify-close-levelup.sh` | Runs `notify-close-to-levelup.js` |

All scripts change to the project directory first so relative paths work.
