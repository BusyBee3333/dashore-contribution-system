#!/usr/bin/env node

/**
 * Weekly Digest
 *
 * Generates a Discord embed digest of the past 7 days' contributions.
 * Highlights top contributors, new members, level-ups, hot topics, and GitHub.
 *
 * Usage:
 *   node scripts/weekly-digest.js --dry-run   # Print to stdout
 *   node scripts/weekly-digest.js --send       # POST to Discord webhook
 */

import { ContributionDB } from '../src/db.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──── Args ────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const send   = args.includes('--send');

if (!dryRun && !send) {
  console.error('Usage: weekly-digest.js --dry-run | --send');
  process.exit(1);
}

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

// ──── Level system ────

const LEVELS = [
  { level: 7, name: 'Architect', min: 5000 },
  { level: 6, name: 'Legend',    min: 2500 },
  { level: 5, name: 'Champion',  min: 1000 },
  { level: 4, name: 'Regular',   min: 500  },
  { level: 3, name: 'Contributor', min: 200 },
  { level: 2, name: 'Participant', min: 50  },
  { level: 1, name: 'Newcomer', min: 0    },
];

const LEVEL_EMOJI = {
  1: '(._. )',
  2: '( ._.)',
  3: '(o_o )',
  4: '( ^_^)',
  5: '(*_* )',
  6: '(!!!)',
  7: '(GOD)',
};

function getLevelForPoints(pts) {
  return LEVELS.find(l => pts >= l.min) || LEVELS[LEVELS.length - 1];
}

// ──── Date helpers ────

const now = new Date();
const since = new Date(now - 7 * 86400000);
const sinceISO = since.toISOString();
const sinceDate = sinceISO.slice(0, 10);
const nowDate = now.toISOString().slice(0, 10);

// Week label e.g. "Mar 7 – Mar 13, 2026"
const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const weekLabel = `${monthNames[since.getMonth()]} ${since.getDate()} – ${monthNames[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;

// ──── Queries ────

/**
 * Top 5 contributors this week by points earned this week
 */
function getTopContributors() {
  return db.db.prepare(`
    SELECT 
      c.member_id,
      m.username,
      m.display_name,
      m.level,
      m.level_name,
      SUM(c.points) AS week_points,
      COUNT(*) AS contribution_count
    FROM contributions c
    JOIN members m ON c.member_id = m.discord_id
    WHERE c.created_at >= ?
    GROUP BY c.member_id
    ORDER BY week_points DESC
    LIMIT 5
  `).all(sinceISO);
}

/**
 * Total contributions + total points this week
 */
function getWeekTotals() {
  return db.db.prepare(`
    SELECT 
      COUNT(*) AS total_contributions,
      COALESCE(SUM(points), 0) AS total_points,
      COUNT(DISTINCT member_id) AS active_members
    FROM contributions
    WHERE created_at >= ?
  `).get(sinceISO);
}

/**
 * New members who earned their very first points this week
 */
function getNewMembers() {
  return db.db.prepare(`
    SELECT 
      m.discord_id,
      m.username,
      m.display_name,
      SUM(c.points) AS first_week_points
    FROM members m
    JOIN contributions c ON c.member_id = m.discord_id
    WHERE m.first_seen_at >= ?
      AND c.created_at >= ?
    GROUP BY m.discord_id
    ORDER BY m.first_seen_at ASC
    LIMIT 10
  `).all(sinceISO, sinceISO);
}

/**
 * Level-ups this week (from level_up_log if available, fallback graceful)
 */
function getLevelUps() {
  // Check if level_up_log table exists
  const tableExists = db.db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name='level_up_log'
  `).get();

  if (!tableExists) return [];

  return db.db.prepare(`
    SELECT 
      lu.member_id,
      m.username,
      m.display_name,
      lu.old_level,
      lu.new_level,
      lu.old_name,
      lu.new_name,
      lu.total_points
    FROM level_up_log lu
    JOIN members m ON lu.member_id = m.discord_id
    WHERE lu.created_at >= ?
    ORDER BY lu.new_level DESC, lu.created_at ASC
  `).all(sinceISO);
}

/**
 * Most discussed topics this week — extracted from AI evidence JSON
 */
function getTopTopics() {
  const rows = db.db.prepare(`
    SELECT evidence
    FROM contributions
    WHERE created_at >= ?
      AND evidence IS NOT NULL
      AND source = 'ai_analysis'
    LIMIT 200
  `).all(sinceISO);

  const topicCounts = {};
  for (const row of rows) {
    try {
      const ev = JSON.parse(row.evidence);
      const topics = Array.isArray(ev.topics) ? ev.topics : [];
      for (const t of topics) {
        if (typeof t === 'string' && t.trim()) {
          const topic = t.trim().toLowerCase();
          topicCounts[topic] = (topicCounts[topic] || 0) + 1;
        }
      }
    } catch { /* skip unparseable evidence */ }
  }

  return Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([topic, count]) => ({ topic, count }));
}

/**
 * GitHub activity this week
 */
function getGithubActivity() {
  // Check if github_events table exists (it should, but be safe)
  const tableExists = db.db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name='github_events'
  `).get();
  if (!tableExists) return { prs: 0, reviews: 0, issues: 0, total_points: 0 };

  const rows = db.db.prepare(`
    SELECT event_type, COUNT(*) AS count, SUM(points_awarded) AS pts
    FROM github_events
    WHERE created_at >= ? AND dry_run = 0
    GROUP BY event_type
  `).all(sinceISO);

  const byType = {};
  for (const r of rows) byType[r.event_type] = { count: r.count, pts: r.pts || 0 };

  return {
    prs: byType['pr_merged']?.count || 0,
    reviews: byType['pr_review']?.count || 0,
    issues: byType['bug_report_github']?.count || 0,
    total_points: Object.values(byType).reduce((s, r) => s + r.pts, 0),
  };
}

// ──── Embed Builder ────

function buildPayload() {
  const top = getTopContributors();
  const totals = getWeekTotals();
  const newMembers = getNewMembers();
  const levelUps = getLevelUps();
  const topics = getTopTopics();
  const github = getGithubActivity();

  const embeds = [];

  // ── Header embed ──────────────────────────────────────

  const headerDesc = [
    `**${totals.total_contributions}** contributions · **${totals.total_points}** pts · **${totals.active_members}** active members`,
  ].join('\n');

  embeds.push({
    title: `📋 Weekly Digest — ${weekLabel}`,
    description: headerDesc,
    color: 0x5865F2,  // Discord blurple
    timestamp: now.toISOString(),
  });

  // ── Top contributors ──────────────────────────────────

  if (top.length) {
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    const lines = top.map((m, i) => {
      const name = m.display_name || m.username;
      const emoji = LEVEL_EMOJI[m.level] || '';
      return `${medals[i]} **${name}** — **${m.week_points} pts** this week  ${emoji} Lv.${m.level} ${m.level_name}`;
    });

    embeds.push({
      title: '🏆 Top Contributors',
      description: lines.join('\n'),
      color: 0xFEE75C,  // Gold
    });
  }

  // ── Level-ups ─────────────────────────────────────────

  if (levelUps.length) {
    const lines = levelUps.map(lu => {
      const name = lu.display_name || lu.username;
      const oldEmoji = LEVEL_EMOJI[lu.old_level] || '';
      const newEmoji = LEVEL_EMOJI[lu.new_level] || '';
      return `🎉 **${name}** — ${oldEmoji} Lv.${lu.old_level} ${lu.old_name} → ${newEmoji} Lv.${lu.new_level} ${lu.new_name}`;
    });

    embeds.push({
      title: '⬆️ Level-Ups This Week',
      description: lines.join('\n'),
      color: 0xEB459E,  // Pink
    });
  }

  // ── New members ───────────────────────────────────────

  if (newMembers.length) {
    const lines = newMembers.map(m => {
      const name = m.display_name || m.username;
      return `👋 **${name}** — ${m.first_week_points} pts earned so far`;
    });

    embeds.push({
      title: `✨ New This Week (${newMembers.length})`,
      description: lines.join('\n'),
      color: 0x57F287,  // Green
    });
  }

  // ── Hot topics ────────────────────────────────────────

  if (topics.length) {
    const topicLine = topics
      .map(t => `\`${t.topic}\` ×${t.count}`)
      .join('  ·  ');

    embeds.push({
      title: '💬 Hot Topics',
      description: topicLine,
      color: 0x5865F2,
    });
  }

  // ── GitHub activity ───────────────────────────────────

  const hasGithub = github.prs + github.reviews + github.issues > 0;
  if (hasGithub) {
    const ghLines = [];
    if (github.prs)     ghLines.push(`✅ **${github.prs}** PR${github.prs !== 1 ? 's' : ''} merged`);
    if (github.reviews) ghLines.push(`👀 **${github.reviews}** PR review${github.reviews !== 1 ? 's' : ''}`);
    if (github.issues)  ghLines.push(`🐛 **${github.issues}** issue${github.issues !== 1 ? 's' : ''} closed`);
    if (github.total_points) ghLines.push(`\n_+${github.total_points} pts total from GitHub_`);

    embeds.push({
      title: '🐙 GitHub Activity',
      description: ghLines.join('\n'),
      color: 0x2F3136,  // Near-black
    });
  }

  // ── Footer on last embed ──────────────────────────────

  const last = embeds[embeds.length - 1];
  last.footer = { text: `DaShore Incubator · auto-digest · ${nowDate}` };

  return {
    username: 'Contribution Bot',
    avatar_url: null,
    embeds,
  };
}

// ──── Send ────

async function sendWebhook(payload) {
  const webhookEnv = config.digest?.webhook_url_env || 'DISCORD_DIGEST_WEBHOOK_URL';
  const webhookUrl = process.env[webhookEnv] || process.env['DISCORD_WEBHOOK_URL'];

  if (!webhookUrl) {
    console.error(`No webhook URL — set ${webhookEnv} or DISCORD_WEBHOOK_URL`);
    process.exit(1);
  }

  // Filter null avatar_url to avoid Discord API rejections
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
    process.exit(1);
  }

  console.log(`Digest sent! (${res.status})`);
}

// ──── Main ────

const payload = buildPayload();

if (dryRun) {
  console.log(JSON.stringify(payload, null, 2));
  const totalEmbeds = payload.embeds.length;
  const contributors = payload.embeds.find(e => e.title?.includes('Top Contributors'));
  console.log(`\n--- Digest preview ---`);
  console.log(`Week: ${weekLabel}`);
  console.log(`Embeds: ${totalEmbeds}`);
  if (contributors) {
    console.log(`Top contributors section: yes`);
  }
} else if (send) {
  await sendWebhook(payload);
}

db.close();
