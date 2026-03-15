#!/usr/bin/env node

/**
 * Open Questions Digest
 *
 * Scans the last N hours of Discord messages in the DaShore Incubator guild,
 * finds unanswered/under-answered questions, and posts a digest embed to Discord.
 *
 * Usage:
 *   node scripts/open-questions-digest.js              # Post to webhook
 *   node scripts/open-questions-digest.js --dry-run    # Print to console only
 *   node scripts/open-questions-digest.js --hours 48   # Custom lookback window
 *   node scripts/open-questions-digest.js --min 1      # Post even with 1 question
 */

import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──── Args ────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const hoursIdx = args.indexOf('--hours');
const HOURS = hoursIdx !== -1 ? parseInt(args[hoursIdx + 1], 10) : 24;

const minIdx = args.indexOf('--min');
const MIN_QUESTIONS = minIdx !== -1 ? parseInt(args[minIdx + 1], 10) : 2;

const GUILD_ID = '1449158500344270961';

// ──── Config ────

let config;
try {
  config = JSON.parse(readFileSync(resolve(__dirname, '../config/config.json'), 'utf-8'));
} catch {
  console.error('Missing config/config.json');
  process.exit(1);
}

// ──── DB Paths ────

const discrawlDbPath = resolve(homedir(), '.discrawl/discrawl.db');
if (!existsSync(discrawlDbPath)) {
  console.error(`discrawl.db not found at ${discrawlDbPath}`);
  process.exit(1);
}

const contribDbPath = resolve(__dirname, '..', config.contribution_db || './data/contributions.db');

const discrawl = new Database(discrawlDbPath, { readonly: true });
discrawl.pragma('journal_mode = WAL');

const contrib = new Database(contribDbPath);
contrib.pragma('journal_mode = WAL');

// ──── Ensure tracking table ────

contrib.exec(`
  CREATE TABLE IF NOT EXISTS digest_posted (
    message_id TEXT PRIMARY KEY,
    digest_type TEXT NOT NULL,
    posted_at TEXT DEFAULT (datetime('now'))
  );
`);

// ──── Question detection ────

const QUESTION_WORDS = [
  'how', 'what', 'why', 'where', 'when', 'who',
  'is there', 'can anyone', 'does anyone',
  'help', 'stuck', 'anyone know',
];

function isQuestion(content) {
  if (!content || content.length < 15) return false;
  const lower = content.toLowerCase().trim();
  if (lower.endsWith('?')) return true;
  return QUESTION_WORDS.some(w => lower.includes(w));
}

// ──── Fetch questions ────

function fetchQuestions() {
  const cutoff = new Date(Date.now() - HOURS * 60 * 60 * 1000).toISOString();
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  // Get messages from target guild in the lookback window
  // Exclude bot messages (author_id null or flagged), deleted messages
  const messages = discrawl.prepare(`
    SELECT
      m.id,
      m.channel_id,
      m.author_id,
      m.content,
      m.created_at,
      m.reply_to_message_id,
      m.raw_json,
      c.name AS channel_name
    FROM messages m
    JOIN channels c ON c.id = m.channel_id AND c.guild_id = m.guild_id
    WHERE m.guild_id = ?
      AND m.created_at >= ?
      AND m.deleted_at IS NULL
      AND m.message_type = 0
      AND m.author_id IS NOT NULL
    ORDER BY m.created_at ASC
  `).all(GUILD_ID, cutoff);

  // Get already-posted question IDs
  const postedIds = new Set(
    contrib.prepare(`SELECT message_id FROM digest_posted WHERE digest_type = 'open_questions'`).all()
      .map(r => r.message_id)
  );

  // Build a set of message IDs that received a reply
  const repliedTo = new Set();
  for (const msg of messages) {
    if (msg.reply_to_message_id) {
      repliedTo.add(msg.reply_to_message_id);
    }
  }

  // Score questions
  const scored = [];

  for (const msg of messages) {
    if (!isQuestion(msg.content)) continue;
    if (postedIds.has(msg.id)) continue;

    // Skip messages that are themselves replies (they have context from the thread)
    if (msg.reply_to_message_id) continue;

    let score = 0;

    // +1 if no one replied to this message
    if (!repliedTo.has(msg.id)) score += 1;

    // +1 if no reactions (check raw_json)
    let hasReactions = false;
    try {
      const raw = JSON.parse(msg.raw_json);
      if (raw.reactions && Array.isArray(raw.reactions) && raw.reactions.length > 0) {
        hasReactions = true;
      }
    } catch {}
    if (!hasReactions) score += 1;

    // +1 if older than 2 hours (had time to get a response, but didn't)
    if (msg.created_at < twoHoursAgo) score += 1;

    scored.push({ ...msg, score });
  }

  // Sort by score desc, then by oldest first (most neglected)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.created_at < b.created_at ? -1 : 1;
  });

  return scored.slice(0, 5);
}

// ──── Discord message link ────

function messageLink(channelId, messageId) {
  return `https://discord.com/channels/${GUILD_ID}/${channelId}/${messageId}`;
}

// ──── Truncate ────

function truncate(text, max = 200) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

// ──── Format timestamp ────

function formatTs(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    hour12: true, timeZone: 'America/New_York',
  });
}

// ──── Build embed ────

function buildEmbed(questions) {
  const fields = questions.map(q => ({
    name: `#${q.channel_name} · ${formatTs(q.created_at)}`,
    value: `${truncate(q.content, 200)}\n[→ Jump to message](${messageLink(q.channel_id, q.id)})`,
    inline: false,
  }));

  return {
    username: 'DaShore Digest',
    embeds: [{
      title: '❓ Open Questions — Help Needed!',
      description: `These questions haven't gotten traction in the last ${HOURS}h. Jump in!`,
      color: 0xf39c12,
      fields,
      footer: { text: 'Answering earns contribution points · /leaderboard to check your rank' },
      timestamp: new Date().toISOString(),
    }],
  };
}

// ──── Send webhook ────

async function sendWebhook(payload) {
  const webhookUrl =
    process.env.DISCORD_DIGEST_WEBHOOK_URL ||
    process.env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    console.error('No webhook URL — set DISCORD_DIGEST_WEBHOOK_URL or DISCORD_WEBHOOK_URL');
    return false;
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Webhook failed: ${res.status} ${text}`);
    return false;
  }

  return true;
}

// ──── Mark posted ────

function markPosted(questions) {
  const stmt = contrib.prepare(`
    INSERT OR IGNORE INTO digest_posted (message_id, digest_type)
    VALUES (?, 'open_questions')
  `);
  for (const q of questions) {
    stmt.run(q.id);
  }
}

// ──── Main ────

console.log(`🔍 Scanning last ${HOURS}h of messages in guild ${GUILD_ID}...`);

const questions = fetchQuestions();

console.log(`Found ${questions.length} open question(s).`);

if (questions.length < MIN_QUESTIONS) {
  console.log(`Below minimum threshold (${MIN_QUESTIONS}), skipping digest.`);
  discrawl.close();
  contrib.close();
  process.exit(0);
}

if (dryRun) {
  console.log('\n[DRY RUN] Would post digest with these questions:\n');
  for (const q of questions) {
    console.log(`  [Score: ${q.score}] #${q.channel_name} @ ${formatTs(q.created_at)}`);
    console.log(`  ${truncate(q.content, 120)}`);
    console.log(`  ${messageLink(q.channel_id, q.id)}\n`);
  }
} else {
  const payload = buildEmbed(questions);
  const ok = await sendWebhook(payload);
  if (ok) {
    markPosted(questions);
    console.log(`✅ Digest posted with ${questions.length} question(s).`);
  } else {
    console.error('❌ Failed to post digest.');
    process.exit(1);
  }
}

discrawl.close();
contrib.close();
console.log('Done.');
