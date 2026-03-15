#!/usr/bin/env node

/**
 * Close-to-Leveling-Up Notifier
 *
 * Scans members who are within 20% of the next level threshold and sends
 * them a motivational DM via the Discord bot token.
 *
 * Usage:
 *   node scripts/notify-close-to-levelup.js            # Live run (sends DMs)
 *   node scripts/notify-close-to-levelup.js --dry-run  # Print who would be DM'd
 */

import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──── Args ────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// ──── Config ────

let config;
try {
  config = JSON.parse(readFileSync(resolve(__dirname, '../config/config.json'), 'utf-8'));
} catch {
  console.error('Missing config/config.json');
  process.exit(1);
}

// ──── Level thresholds ────

const LEVELS = [
  { level: 1, name: 'Newcomer',    min: 0    },
  { level: 2, name: 'Participant', min: 50   },
  { level: 3, name: 'Contributor', min: 200  },
  { level: 4, name: 'Regular',     min: 500  },
  { level: 5, name: 'Champion',    min: 1000 },
  { level: 6, name: 'Legend',      min: 2500 },
  { level: 7, name: 'Architect',   min: 5000 },
];

const NOTIFY_THRESHOLD = config.engagement?.close_levelup_notify_threshold ?? 0.20;
const COOLDOWN_DAYS    = config.engagement?.close_levelup_notify_cooldown_days ?? 7;

// ──── DB ────

const contribDbPath = resolve(__dirname, '..', config.contribution_db || './data/contributions.db');
const db = new Database(contribDbPath);
db.pragma('journal_mode = WAL');

// Ensure tracking table
// Note: UNIQUE constraint omits date(notified_at) expression (SQLite doesn't support
// expressions in UNIQUE). Deduplication is handled via the wasRecentlyNotified query
// which enforces a 7-day cooldown per (member_id, target_level).
db.exec(`
  CREATE TABLE IF NOT EXISTS level_nudge_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id TEXT NOT NULL,
    target_level INTEGER NOT NULL,
    points_needed INTEGER NOT NULL,
    notified_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_nudge_log_member ON level_nudge_log(member_id, target_level, notified_at);
`);

// ──── Find next level ────

function getNextLevel(totalPoints) {
  for (let i = 0; i < LEVELS.length - 1; i++) {
    if (totalPoints < LEVELS[i + 1].min) {
      return LEVELS[i + 1]; // The level they haven't reached yet
    }
  }
  return null; // Already at max level
}

// ──── Check within threshold ────

function isCloseToLevel(totalPoints, nextLevel) {
  if (!nextLevel) return false;
  const threshold = nextLevel.min;
  const lowerBound = threshold * (1 - NOTIFY_THRESHOLD);
  return totalPoints >= lowerBound && totalPoints < threshold;
}

// ──── Check cooldown ────

function wasRecentlyNotified(memberId, targetLevel) {
  const row = db.prepare(`
    SELECT 1 FROM level_nudge_log
    WHERE member_id = ?
      AND target_level = ?
      AND notified_at >= datetime('now', '-${COOLDOWN_DAYS} days')
    LIMIT 1
  `).get(memberId, targetLevel);
  return !!row;
}

// ──── Log notification ────

function logNotification(memberId, targetLevel, pointsNeeded) {
  db.prepare(`
    INSERT INTO level_nudge_log (member_id, target_level, points_needed)
    VALUES (?, ?, ?)
  `).run(memberId, targetLevel, pointsNeeded);
}

// ──── Build DM message ────

function buildMessage(member, nextLevel, pointsNeeded) {
  return [
    `🔥 You're close! You need just **${pointsNeeded} more points** to reach **${nextLevel.name}** (Lv.${nextLevel.level})!`,
    ``,
    `Keep contributing in DaShore Incubator — every helpful message, PR, or vouch counts.`,
    `Check your progress: \`/mypoints\``,
  ].join('\n');
}

// ──── Send Discord DM ────

async function sendDM(discordId, message) {
  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || process.env[config.discord_token_env || 'DISCORD_BOT_TOKEN'];

  if (!BOT_TOKEN) {
    console.error('DISCORD_BOT_TOKEN not set');
    return false;
  }

  // Step 1: Open DM channel
  let dmChannel;
  try {
    const dmResp = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: discordId }),
    });

    if (!dmResp.ok) {
      const text = await dmResp.text();
      console.error(`  Failed to open DM channel for ${discordId}: ${dmResp.status} ${text}`);
      return false;
    }

    dmChannel = await dmResp.json();
  } catch (err) {
    console.error(`  Network error opening DM channel: ${err.message}`);
    return false;
  }

  if (!dmChannel?.id) {
    console.error(`  No DM channel ID returned for ${discordId}`);
    return false;
  }

  // Step 2: Send message
  try {
    const msgResp = await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: message }),
    });

    if (!msgResp.ok) {
      const text = await msgResp.text();
      console.error(`  Failed to send DM to ${discordId}: ${msgResp.status} ${text}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`  Network error sending DM: ${err.message}`);
    return false;
  }
}

// ──── Main ────

const members = db.prepare(`
  SELECT discord_id, username, display_name, total_points, level, level_name
  FROM members
  WHERE total_points > 0
  ORDER BY total_points DESC
`).all();

console.log(`📊 Checking ${members.length} member(s) for close-to-levelup notifications...`);

let notifiedCount = 0;
let skippedCount = 0;
let errorCount = 0;

for (const member of members) {
  const nextLevel = getNextLevel(member.total_points);

  if (!nextLevel) {
    // Already at max level
    continue;
  }

  if (!isCloseToLevel(member.total_points, nextLevel)) {
    continue;
  }

  const pointsNeeded = nextLevel.min - member.total_points;
  const displayName = member.display_name || member.username;

  // Check cooldown
  if (wasRecentlyNotified(member.discord_id, nextLevel.level)) {
    console.log(`  ⏭ ${displayName} — ${member.total_points}pts → Lv.${nextLevel.level} (${pointsNeeded} away) — already notified within ${COOLDOWN_DAYS} days`);
    skippedCount++;
    continue;
  }

  const message = buildMessage(member, nextLevel, pointsNeeded);

  if (dryRun) {
    console.log(`\n  [DRY RUN] Would DM ${displayName} (${member.discord_id}):`);
    console.log(`    ${member.total_points}pts → Lv.${nextLevel.level} ${nextLevel.name} (needs ${pointsNeeded} more)`);
    console.log(`    "${buildMessage(member, nextLevel, pointsNeeded).split('\n')[0]}"`);
    notifiedCount++;
  } else {
    console.log(`  📨 Sending DM to ${displayName} (${member.discord_id}) — ${pointsNeeded} pts away from Lv.${nextLevel.level}`);
    const ok = await sendDM(member.discord_id, message);

    if (ok) {
      logNotification(member.discord_id, nextLevel.level, pointsNeeded);
      console.log(`    ✅ DM sent`);
      notifiedCount++;

      // Small delay to avoid Discord rate limits
      await new Promise(r => setTimeout(r, 300));
    } else {
      console.error(`    ❌ Failed to DM ${displayName}`);
      errorCount++;
    }
  }
}

console.log(`\nDone. Notified: ${notifiedCount}, Skipped (cooldown): ${skippedCount}, Errors: ${errorCount}`);

db.close();
