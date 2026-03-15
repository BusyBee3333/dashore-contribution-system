#!/usr/bin/env node

/**
 * Level-Up Announcer
 *
 * Reads unannounced level-ups from level_up_log and posts
 * celebration messages via Discord webhook.
 *
 * Usage:
 *   node scripts/announce-levelups.js             # Send unannounced level-ups
 *   node scripts/announce-levelups.js --dry-run   # Print without sending
 */

import { ContributionDB } from '../src/db.js';
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

const db = new ContributionDB(
  resolve(__dirname, '..', config.contribution_db || './data/contributions.db')
).init();

// ──── Level Emojis ────

const LEVEL_EMOJI = {
  1: '(._. )',
  2: '( ._.)',
  3: '(o_o )',
  4: '( ^_^)',
  5: '(*_* )',
  6: '(!!!)',
  7: '(GOD)',
};

// ──── Fetch unannounced level-ups ────

function getUnannounced() {
  return db.db.prepare(`
    SELECT 
      lu.*,
      m.username,
      m.display_name
    FROM level_up_log lu
    JOIN members m ON lu.member_id = m.discord_id
    WHERE lu.announced = 0
    ORDER BY lu.created_at ASC
  `).all();
}

function markAnnounced(id) {
  db.db.prepare(`
    UPDATE level_up_log SET announced = 1 WHERE id = ?
  `).run(id);
}

// ──── Format message ────

function formatMessage(lu) {
  const name = lu.display_name || lu.username;
  const oldEmoji = LEVEL_EMOJI[lu.old_level] || '';
  const newEmoji = LEVEL_EMOJI[lu.new_level] || '';

  const description = [
    `${oldEmoji} Lv.${lu.old_level} **${lu.old_name}** → ${newEmoji} Lv.${lu.new_level} **${lu.new_name}**`,
    `Total: **${lu.total_points} pts**`,
  ].join('\n');

  return {
    username: 'Contribution Bot',
    embeds: [{
      title: `🎉 Level Up! **${name}**`,
      description,
      color: levelColor(lu.new_level),
      footer: { text: `Keep it up! 🔥` },
      timestamp: lu.created_at ? new Date(lu.created_at).toISOString() : new Date().toISOString(),
    }],
  };
}

function levelColor(level) {
  const colors = {
    2: 0x57F287,   // Green  — Participant
    3: 0x3BA55D,   // Darker green — Contributor
    4: 0xFEE75C,   // Yellow — Regular
    5: 0xEB459E,   // Pink — Champion
    6: 0xED4245,   // Red — Legend
    7: 0x9B59B6,   // Purple — Architect
  };
  return colors[level] || 0x5865F2;
}

// ──── Send webhook ────

async function sendWebhook(payload) {
  // Prefer a dedicated level-up webhook, fall back to digest webhook, then generic
  const levelupEnv = config.engagement?.levelup_webhook_env || 'DISCORD_LEVELUP_WEBHOOK_URL';
  const digestEnv  = config.engagement?.open_questions_webhook_env
    || config.digest?.webhook_url_env
    || 'DISCORD_DIGEST_WEBHOOK_URL';
  const webhookUrl =
    process.env[levelupEnv] ||
    process.env[digestEnv] ||
    process.env['DISCORD_WEBHOOK_URL'];

  if (!webhookUrl) {
    console.error(`No webhook URL — set DISCORD_LEVELUP_WEBHOOK_URL, DISCORD_DIGEST_WEBHOOK_URL, or DISCORD_WEBHOOK_URL`);
    return false;
  }

  const body = { ...payload };
  if (!body.avatar_url) delete body.avatar_url;

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Webhook failed: ${res.status} ${text}`);
    return false;
  }

  return true;
}

// ──── Main ────

const pending = getUnannounced();

if (!pending.length) {
  console.log('No unannounced level-ups.');
  db.close();
  process.exit(0);
}

console.log(`Found ${pending.length} unannounced level-up(s).`);

for (const lu of pending) {
  const name = lu.display_name || lu.username;
  const oldEmoji = LEVEL_EMOJI[lu.old_level] || '';
  const newEmoji = LEVEL_EMOJI[lu.new_level] || '';

  const preview = `🎉 ${name} leveled up! ${oldEmoji} Lv.${lu.old_level} ${lu.old_name} → ${newEmoji} Lv.${lu.new_level} ${lu.new_name}  (${lu.total_points} pts)`;
  console.log(preview);

  if (!dryRun) {
    const payload = formatMessage(lu);
    const ok = await sendWebhook(payload);
    if (ok) {
      markAnnounced(lu.id);
      console.log(`  -> announced (id=${lu.id})`);
    } else {
      console.error(`  -> failed to announce (id=${lu.id}), leaving as unannounced`);
    }

    // Small delay between webhook calls to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  } else {
    console.log(`  [dry-run] would send webhook`);
  }
}

db.close();
console.log('Done.');
