# Webhook Setup Guide

This guide explains how to create and configure the Discord webhooks needed for the engagement features.

---

## Webhooks Needed

| Webhook | Channel | Purpose | Env Var |
|---------|---------|---------|---------|
| Level-up announcements | `#general` (`1449158501124538472`) | Announces when members level up | `DISCORD_LEVELUP_WEBHOOK_URL` |
| Open Questions digest | `#contribution-system` or `#announcements` | Daily digest of unanswered questions | `DISCORD_DIGEST_WEBHOOK_URL` |

---

## Step 1: Create the #general Level-Up Webhook

1. Open Discord and navigate to the **DaShore Incubator** server
2. Right-click **#general** → **Edit Channel**
3. Go to **Integrations** → **Webhooks** → **New Webhook**
4. Name it: `Contribution Bot` (optional: set an avatar)
5. Click **Copy Webhook URL**
6. Set the env var:
   ```bash
   signet secret put DISCORD_LEVELUP_WEBHOOK_URL
   # Paste the URL when prompted
   ```
   Or add to your `.env` file:
   ```
   DISCORD_LEVELUP_WEBHOOK_URL=https://discord.com/api/webhooks/...
   ```

The `announce-levelups.js` script will use this webhook to post level-up celebrations in #general.

---

## Step 2: Create the Open Questions Digest Webhook

1. Navigate to the **#contribution-system** channel (or **#announcements** if preferred)
2. Right-click the channel → **Edit Channel**
3. Go to **Integrations** → **Webhooks** → **New Webhook**
4. Name it: `DaShore Digest`
5. Click **Copy Webhook URL**
6. Set the env var:
   ```bash
   signet secret put DISCORD_DIGEST_WEBHOOK_URL
   # Paste the URL when prompted
   ```
   Or add to `.env`:
   ```
   DISCORD_DIGEST_WEBHOOK_URL=https://discord.com/api/webhooks/...
   ```

The `open-questions-digest.js` script reads `DISCORD_DIGEST_WEBHOOK_URL` (with `DISCORD_WEBHOOK_URL` as final fallback).

---

## Environment Variables Summary

| Variable | Used By | Required? |
|----------|---------|-----------|
| `DISCORD_LEVELUP_WEBHOOK_URL` | `announce-levelups.js` | ✅ Recommended (falls back to DIGEST) |
| `DISCORD_DIGEST_WEBHOOK_URL` | `open-questions-digest.js`, `announce-levelups.js` fallback | ✅ Required |
| `DISCORD_WEBHOOK_URL` | Universal fallback for all scripts | Optional |
| `DISCORD_BOT_TOKEN` | `notify-close-to-levelup.js` (DM sending) | ✅ Required for DMs |

### Webhook Fallback Chain

**Level-up announcements** (`announce-levelups.js`):
```
DISCORD_LEVELUP_WEBHOOK_URL → DISCORD_DIGEST_WEBHOOK_URL → DISCORD_WEBHOOK_URL
```

**Open questions digest** (`open-questions-digest.js`):
```
DISCORD_DIGEST_WEBHOOK_URL → DISCORD_WEBHOOK_URL
```

---

## Quick Test

After setting up the webhooks, test each script:

```bash
cd /Users/jakeshore/.clawdbot/workspace/contribution-system

# Test level-up announcements (dry-run)
node scripts/announce-levelups.js --dry-run

# Test open questions digest (dry-run, no minimum)
node scripts/open-questions-digest.js --dry-run --min 0

# Test close-to-levelup notifier (dry-run)
node scripts/notify-close-to-levelup.js --dry-run
```

To do a live test of the webhook (sends a real message):
```bash
# Send level-up announcements for real
node scripts/announce-levelups.js

# Post digest for real (needs at least 2 questions by default)
node scripts/open-questions-digest.js
```

---

## Cron Jobs

The cron jobs are managed by Clawdbot. See `scripts/cron-setup.md` for the full setup.

New cron jobs added for engagement features:
- **`open-questions-digest`** — Daily at 9am ET
- **`notify-close-levelup`** — Every 6 hours

```bash
# Register the new crons
clawdbot cron add \
  --name "open-questions-digest" \
  --description "Daily digest of unanswered questions in Discord" \
  --cron "0 9 * * *" \
  --tz "America/New_York" \
  --message "Run the open questions digest: bash /Users/jakeshore/.clawdbot/workspace/contribution-system/scripts/run-open-questions-digest.sh"

clawdbot cron add \
  --name "notify-close-levelup" \
  --description "DM members who are close to leveling up" \
  --cron "0 */6 * * *" \
  --tz "America/New_York" \
  --message "Run the close-to-levelup notifier: bash /Users/jakeshore/.clawdbot/workspace/contribution-system/scripts/run-notify-close-levelup.sh"
```
