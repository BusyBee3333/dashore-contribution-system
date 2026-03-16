#!/usr/bin/env node

/**
 * Idea Impact Analysis
 * 
 * Second-pass analyzer that detects ideas leading to real outcomes.
 * Runs after (or alongside) the main conversation scorer.
 * 
 * Usage:
 *   node scripts/analyze-ideas.js --hours 48
 *   node scripts/analyze-ideas.js --days 7
 *   node scripts/analyze-ideas.js --dry-run --days 3
 */

import { IdeaTracker } from '../src/idea-tracker.js';
import { ContributionDB } from '../src/db.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──── Parse Args ────

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    flags[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
    if (flags[key] !== true) i++;
  }
}

const dryRun = flags['dry-run'] === true;

// Determine time range
let sinceISO;
const now = new Date();
if (flags.since) {
  sinceISO = flags.since;
} else if (flags.hours) {
  sinceISO = new Date(now - parseInt(flags.hours) * 3600000).toISOString();
} else if (flags.days) {
  sinceISO = new Date(now - parseInt(flags.days) * 86400000).toISOString();
} else {
  sinceISO = new Date(now - 48 * 3600000).toISOString(); // default: last 48h
}

console.log(`\n=== Idea Impact Analysis ===`);
console.log(`Time range: ${sinceISO} -> ${now.toISOString()}`);
console.log(`Dry run: ${dryRun}`);

// ──── Load Config ────

let config;
try {
  config = JSON.parse(readFileSync(resolve(__dirname, '../config/config.json'), 'utf-8'));
} catch {
  console.error('Missing config/config.json');
  process.exit(1);
}

// ──── Run ────

const tracker = new IdeaTracker({
  guildId: config.guild_id,
  lookbackHours: parseInt(flags.hours || flags.days * 24 || 48),
  outcomeWindowHours: 72,
  minReactions: 1,
  minPositiveReplies: 0,
  stateFile: resolve(__dirname, '../data/idea-tracker-state.json'),
});

const db = new ContributionDB(
  resolve(__dirname, '..', config.contribution_db || './data/contributions.db')
).init();

async function main() {
  const results = await tracker.run(sinceISO);

  if (results.length === 0) {
    console.log('\nNo high-impact ideas detected this run.');
    tracker.close();
    return;
  }

  // Get active season
  const season = db.getActiveSeason?.() || null;

  let totalPoints = 0;
  let contributionsCreated = 0;

  for (const result of results) {
    const { points, reasons, ideaMessage, sentiment, outcomes } = result;

    if (dryRun) {
      console.log(`\n  [DRY RUN] Would award ${points} pts to ${ideaMessage.displayName}`);
      console.log(`    Idea: "${ideaMessage.content.slice(0, 100)}..."`);
      console.log(`    Reasons: ${reasons.join(', ')}`);
      continue;
    }

    // Ensure member exists
    db.upsertMember(ideaMessage.author_id, ideaMessage.displayName, ideaMessage.displayName);

    // Add contribution
    db.addContribution({
      memberId: ideaMessage.author_id,
      type: 'idea_impact',
      points,
      rawScore: points,
      multiplier: 1.0,
      evidence: JSON.stringify({
        idea: ideaMessage.content.slice(0, 500),
        channel: ideaMessage.channel,
        timestamp: ideaMessage.timestamp,
        reasons,
        sentiment: {
          reactions: sentiment.positiveReactionCount,
          humanAgreement: sentiment.positiveHumanReplies,
          botExecution: sentiment.botExecutionMessages,
        },
        outcomes: outcomes.map(o => ({
          type: o.type,
          detail: o.detail?.slice(0, 200),
          url: o.url,
        })),
      }),
      channelId: null,
      channelName: ideaMessage.channel,
      source: 'idea_tracker',
      messageIds: JSON.stringify([ideaMessage.id]),
      seasonId: season?.id || null,
    });

    totalPoints += points;
    contributionsCreated++;
    console.log(`  ✅ Awarded ${points} pts to ${ideaMessage.displayName} for idea_impact`);
  }

  console.log(`\n=== Complete ===`);
  console.log(`Ideas scored: ${results.length}`);
  console.log(`Contributions created: ${contributionsCreated}`);
  console.log(`Total points awarded: ${totalPoints}`);

  tracker.close();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
