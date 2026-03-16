#!/usr/bin/env node

/**
 * Contribution Announcer
 * 
 * Posts celebration embeds to #contribution-system when someone earns
 * notable points. Runs after analysis/idea-tracker, checks for unannounced
 * contributions, and posts shoutouts.
 * 
 * Usage:
 *   node scripts/announce-contributions.js
 *   node scripts/announce-contributions.js --dry-run
 *   node scripts/announce-contributions.js --since "2026-03-15"
 */

import { ContributionDB } from '../src/db.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Bot token for posting
const BOT_TOKEN = process.env[config.discord_token_env || 'DISCORD_BOT_TOKEN'];
const ANNOUNCE_CHANNEL = config.contribution_announce_channel || '1481909602856734756'; // #contribution-system

// ──── Ensure announcement tracking table ────

db.db.exec(`
  CREATE TABLE IF NOT EXISTS contribution_announcements (
    contribution_id INTEGER PRIMARY KEY REFERENCES contributions(id),
    announced_at TEXT DEFAULT (datetime('now'))
  )
`);

// ──── Type config ────

const TYPE_CONFIG = {
  idea_impact: {
    emoji: '💡',
    title: 'Idea → Impact',
    verb: 'proposed an idea that led to real outcomes',
    color: 0xF5A623, // gold
    minPoints: 3,     // announce if ≥3 pts
  },
  helpful_conversation: {
    emoji: '💬',
    title: 'Helpful Conversation',
    verb: 'was genuinely helpful in conversation',
    color: 0x3498DB, // blue
    minPoints: 5,
  },
  teaching_moment: {
    emoji: '📚',
    title: 'Teaching Moment',
    verb: 'taught something valuable',
    color: 0x9B59B6, // purple
    minPoints: 5,
  },
  tool_share: {
    emoji: '🔧',
    title: 'Tool Share',
    verb: 'shared a useful tool or resource',
    color: 0x2ECC71, // green
    minPoints: 3,
  },
  voice_helpful: {
    emoji: '🎤',
    title: 'Voice MVP',
    verb: 'was helpful in a voice chat',
    color: 0x1ABC9C, // teal
    minPoints: 5,
  },
  voice_teaching: {
    emoji: '🎓',
    title: 'Voice Teacher',
    verb: 'taught something in a voice session',
    color: 0x9B59B6, // purple
    minPoints: 5,
  },
  voice_idea: {
    emoji: '🗣️',
    title: 'Voice Idea',
    verb: 'proposed an actionable idea in voice chat',
    color: 0xF5A623, // gold
    minPoints: 5,
  },
  event_hosted: {
    emoji: '🎪',
    title: 'Event Host',
    verb: 'hosted a voice event',
    color: 0xE91E63, // pink
    minPoints: 3,
  },
};

// ──── Get unannounced contributions ────

// Known bot IDs — exclude from announcements
const BOT_IDS = new Set([
  '1458234593714114640',  // Buba
  '1475640365842432061',  // Oogie
  '1476170950302236752',  // Buba Jr
]);

function getUnannounced(sinceISO) {
  const since = sinceISO || new Date(Date.now() - 24 * 3600000).toISOString();
  
  const all = db.db.prepare(`
    SELECT 
      c.id, c.member_id, c.type, c.points, c.raw_score, c.evidence,
      c.channel_name, c.created_at,
      m.username, m.display_name
    FROM contributions c
    JOIN members m ON c.member_id = m.discord_id
    LEFT JOIN contribution_announcements ca ON c.id = ca.contribution_id
    WHERE ca.contribution_id IS NULL
      AND c.created_at >= ?
      AND c.points >= 3
      AND c.type IN (${Object.keys(TYPE_CONFIG).map(() => '?').join(',')})
    ORDER BY c.points DESC, c.created_at ASC
    LIMIT 50
  `).all(since, ...Object.keys(TYPE_CONFIG));

  // Filter out bots
  return all.filter(c => !BOT_IDS.has(c.member_id));
}

/**
 * Batch contributions by member+type to avoid flooding.
 * Groups multiple same-type contributions into a single announcement.
 * Returns top 5 most notable (highest points or multi-idea batches).
 */
function batchContributions(contributions) {
  const groups = new Map(); // key: "member_id:type" → { contribs, totalPoints }

  for (const c of contributions) {
    const key = `${c.member_id}:${c.type}`;
    if (!groups.has(key)) {
      groups.set(key, { contribs: [], totalPoints: 0, member_id: c.member_id, type: c.type });
    }
    const g = groups.get(key);
    g.contribs.push(c);
    g.totalPoints += c.points;
  }

  // Sort by total points descending, take top 5
  return [...groups.values()]
    .sort((a, b) => b.totalPoints - a.totalPoints)
    .slice(0, 5);
}

// ──── Send embed ────

async function sendEmbed(embed) {
  if (!BOT_TOKEN) {
    console.error('[announcer] No bot token — cannot post');
    return false;
  }

  const res = await fetch(`https://discord.com/api/v10/channels/${ANNOUNCE_CHANNEL}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[announcer] Discord API error: ${err}`);
    return false;
  }
  return true;
}

// ──── Mark as announced ────

function markAnnounced(contributionId) {
  db.db.prepare(`
    INSERT OR IGNORE INTO contribution_announcements (contribution_id) VALUES (?)
  `).run(contributionId);
}

// ──── Build celebration embed ────

function buildEmbed(contrib) {
  const typeConf = TYPE_CONFIG[contrib.type] || {
    emoji: '⭐',
    title: 'Contribution',
    verb: 'contributed to the community',
    color: 0x95A5A6,
    minPoints: 5,
  };

  // Skip if below minimum for this type
  if (contrib.points < typeConf.minPoints) return null;

  const name = contrib.display_name || contrib.username || 'Unknown';
  let evidence = {};
  try { evidence = JSON.parse(contrib.evidence || '{}'); } catch { /* ok */ }

  // Build description
  let desc = `<@${contrib.member_id}> ${typeConf.verb}`;
  if (contrib.channel_name) {
    desc += ` in **#${contrib.channel_name}**`;
  }

  // Add evidence details
  const fields = [];

  if (evidence.reasoning) {
    fields.push({
      name: 'What happened',
      value: evidence.reasoning.slice(0, 200),
      inline: false,
    });
  }

  if (evidence.idea) {
    fields.push({
      name: 'The idea',
      value: `"${evidence.idea.slice(0, 200)}..."`,
      inline: false,
    });
  }

  if (evidence.reasons?.length) {
    fields.push({
      name: 'Impact trail',
      value: evidence.reasons.slice(0, 4).map(r => `• ${r}`).join('\n'),
      inline: false,
    });
  }

  if (evidence.outcomes?.length) {
    const outcomeText = evidence.outcomes
      .slice(0, 3)
      .map(o => `${o.url ? `[${o.detail}](${o.url})` : o.detail}`)
      .join('\n');
    fields.push({
      name: 'Outcomes',
      value: outcomeText,
      inline: false,
    });
  }

  if (evidence.topics?.length) {
    fields.push({
      name: 'Topics',
      value: evidence.topics.join(', '),
      inline: true,
    });
  }

  fields.push({
    name: 'Points earned',
    value: `**+${contrib.points}** pts`,
    inline: true,
  });

  return {
    title: `${typeConf.emoji} ${typeConf.title}`,
    description: desc,
    color: typeConf.color,
    fields,
    footer: {
      text: `Contribution System · ${new Date(contrib.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
    },
    timestamp: contrib.created_at,
  };
}

// ──── Main ────

async function main() {
  const sinceArg = args.find(a => a.startsWith('--since'))?.split('=')[1]
    || (args.indexOf('--since') > -1 ? args[args.indexOf('--since') + 1] : null);

  const contributions = getUnannounced(sinceArg);
  console.log(`[announcer] Found ${contributions.length} unannounced contributions (bots excluded)`);

  if (contributions.length === 0) {
    console.log('[announcer] Nothing to announce.');
    return;
  }

  // Batch by member+type → top 5 groups
  const batches = batchContributions(contributions);
  console.log(`[announcer] Batched into ${batches.length} announcement groups`);

  let posted = 0;
  for (const batch of batches) {
    // Use the highest-scoring contribution as the representative
    const best = batch.contribs.sort((a, b) => b.points - a.points)[0];
    const count = batch.contribs.length;

    // Build embed — if batched, adjust description
    const embed = buildEmbed(best);
    if (!embed) {
      // Below threshold — mark all as announced
      for (const c of batch.contribs) markAnnounced(c.id);
      continue;
    }

    // If multiple contributions of same type, show as batch
    if (count > 1) {
      const name = best.display_name || best.username;
      embed.description = `<@${best.member_id}> had **${count} notable contributions** this cycle`;
      embed.fields = embed.fields.filter(f => f.name !== 'Points earned');
      embed.fields.push({
        name: 'Total earned',
        value: `**+${batch.totalPoints}** pts across ${count} contributions`,
        inline: true,
      });
    }

    if (dryRun) {
      console.log(`[DRY RUN] Would post: ${embed.title} for ${best.display_name || best.username} (+${batch.totalPoints} pts, ${count} contribs)`);
      for (const c of batch.contribs) markAnnounced(c.id);
      continue;
    }

    const success = await sendEmbed(embed);
    if (success) {
      for (const c of batch.contribs) markAnnounced(c.id);
      posted++;
      console.log(`[announcer] Posted: ${embed.title} for ${best.display_name || best.username} (+${batch.totalPoints} pts, ${count} contribs)`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  console.log(`[announcer] Done. ${posted} announcements posted.`);
}

main().catch(err => {
  console.error('[announcer] Error:', err);
  process.exit(1);
});
