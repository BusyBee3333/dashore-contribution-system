#!/usr/bin/env node

/**
 * Batch Conversation Analyzer
 * 
 * Pulls messages from discrawl, clusters into conversations,
 * scores with Claude Haiku, and writes contributions to the DB.
 * 
 * Usage:
 *   node scripts/analyze-conversations.js --days 7
 *   node scripts/analyze-conversations.js --hours 12
 *   node scripts/analyze-conversations.js --since 2026-03-01T00:00:00Z
 *   node scripts/analyze-conversations.js --dry-run --days 3
 */

import { ConversationScorer } from '../src/scorer.js';
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
const verbose = flags['verbose'] === true || flags['v'] === true;

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
  // Default: last 24 hours
  sinceISO = new Date(now - 86400000).toISOString();
}
const untilISO = now.toISOString();

console.log(`\n=== Contribution Analysis ===`);
console.log(`Time range: ${sinceISO} -> ${untilISO}`);
console.log(`Dry run: ${dryRun}`);
console.log('');

// ──── Load Config ────

let config;
try {
  config = JSON.parse(readFileSync(resolve(__dirname, '../config/config.json'), 'utf-8'));
} catch {
  console.error('Missing config/config.json');
  process.exit(1);
}

// ──── Initialize ────

const apiKeyEnv = config.scoring?.api_key_env || 'OPENAI_API_KEY';
const authTokenEnv = config.scoring?.auth_token_env || 'ANTHROPIC_AUTH_TOKEN';

// Support both API key and OAuth token — prefer OAuth if available
const apiKey = process.env[apiKeyEnv] || null;
const authToken = process.env[authTokenEnv] || process.env['ANTHROPIC_API_KEY'] || null;

// Auto-detect: if the key starts with sk-ant-oat, it's an OAuth token
let resolvedApiKey = apiKey;
let resolvedAuthToken = null;
if (authToken && authToken.startsWith('sk-ant-oat')) {
  resolvedAuthToken = authToken;
  resolvedApiKey = null;
} else if (apiKey && apiKey.startsWith('sk-ant-oat')) {
  resolvedAuthToken = apiKey;
  resolvedApiKey = null;
} else {
  resolvedApiKey = apiKey || authToken;
}

const scorer = new ConversationScorer({
  provider: config.scoring?.provider || 'openai',
  model: config.scoring?.model || 'gpt-4o-mini',
  apiKey: resolvedApiKey,
  authToken: resolvedAuthToken,
  guildId: config.guild_id,
  conversationGapMinutes: config.scoring?.conversation_gap_minutes || 30,
  minMessages: config.scoring?.min_messages_for_conversation || 3,
  minMessagesThread: config.scoring?.min_messages_for_thread || 2,
});

if (resolvedAuthToken) {
  console.log(`Auth: OAuth token (${resolvedAuthToken.slice(0, 15)}...)`);
} else if (resolvedApiKey) {
  console.log(`Auth: API key (${resolvedApiKey.slice(0, 15)}...)`);
} else {
  console.error('No API key or OAuth token found! Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN');
  process.exit(1);
}

const db = new ContributionDB(resolve(__dirname, '..', config.contribution_db || './data/contributions.db')).init();

// ──── Main Analysis Loop ────

async function analyze() {
  const channels = scorer.getActiveChannels();
  console.log(`Found ${channels.length} active channels to analyze\n`);

  let totalMessages = 0;
  let totalConversations = 0;
  let totalContributions = 0;

  for (const channel of channels) {
    // Check if we already analyzed this range for this channel
    const lastEnd = db.getLastAnalysisEnd(channel.id);
    const effectiveSince = lastEnd && lastEnd > sinceISO ? lastEnd : sinceISO;

    const messages = scorer.getMessages(channel.id, effectiveSince, untilISO);
    if (!messages.length) {
      if (verbose) console.log(`  #${channel.name}: no messages in range`);
      continue;
    }

    console.log(`  #${channel.name}: ${messages.length} messages`);
    totalMessages += messages.length;

    // Cluster into conversations — threads use a lower threshold
    const isThread = channel.kind === 'thread_public' || channel.kind === 'thread_private';
    const clusterMinMsgs = isThread ? scorer.minMessagesThread : scorer.minMessages;
    const conversations = scorer.clusterConversations(messages, clusterMinMsgs);
    if (!conversations.length) {
      if (verbose) console.log(`    -> no conversation clusters (need ${clusterMinMsgs}+ messages)`);
      continue;
    }

    console.log(`    -> ${conversations.length} conversation clusters`);

    let channelContributions = 0;
    let channelConversations = 0;

    for (let i = 0; i < conversations.length; i++) {
      const convo = conversations[i];
      const participants = [...new Set(convo.map(m => m.author_id))];
      console.log(`    [${i + 1}/${conversations.length}] ${convo.length} msgs, ${participants.length} participants`);

      if (participants.length < 2) {
        if (verbose) console.log(`      skipping monologue`);
        continue;
      }

      // Dedup: check if we already scored this exact conversation cluster
      // Use the first and last message IDs as a fingerprint
      const convoFingerprint = `${convo[0].id}:${convo[convo.length - 1].id}`;
      if (!dryRun && db.hasAnalyzedConversation(channel.id, convo[0].created_at, convo[convo.length - 1].created_at)) {
        if (verbose) console.log(`      already analyzed, skipping`);
        continue;
      }

      // Score with AI
      const scored = await scorer.scoreConversation(convo, channel.name);
      if (!scored) {
        console.log(`      scoring failed, skipping`);
        continue;
      }

      channelConversations++;
      totalConversations++;

      if (verbose) {
        console.log(`      quality: ${scored.conversation_quality}/10, topics: ${scored.topics?.join(', ')}`);
        for (const s of scored.scores || []) {
          console.log(`        ${s.username}: help=${s.helpfulness} teach=${s.teaching} engage=${s.engagement_quality}${s.is_spam_or_farming ? ' [FLAGGED]' : ''}`);
        }
      }

      // Convert scores to contributions
      const contributions = scorer.scoresToContributions(scored, config.points);
      let convoContributions = 0;
      
      if (!dryRun) {
        for (const c of contributions) {
          // Ensure member exists
          const msg = convo.find(m => m.author_id === c.memberId);
          if (msg) {
            db.upsertMember(c.memberId, msg.username, msg.nick || msg.display_name);
          }

          // Anti-gaming: dynamic daily cap check (scales by member level)
          const dailyPts = db.getDailyConversationPoints(c.memberId);
          const cap = db.getDailyCapForMember(c.memberId);
          if (dailyPts + c.points > cap) {
            console.log(`      [cap] ${msg?.username || c.memberId} hit daily cap (${dailyPts}/${cap})`);
            continue;
          }

          db.addContribution({
            ...c,
            channelId: channel.id,
          });
          convoContributions++;
          totalContributions++;
          channelContributions++;
          console.log(`      +${c.points} pts -> ${msg?.username || c.memberId} (${c.type})`);
        }

        // Record analysis run per-conversation (crash-safe dedup)
        const convoStart = convo[0].created_at;
        const convoEnd = convo[convo.length - 1].created_at;
        const cost = scorer.getEstimatedCost();
        db.recordAnalysisRun({
          channelId: channel.id,
          channelName: channel.name,
          timeRangeStart: convoStart,
          timeRangeEnd: convoEnd,
          model: scorer.model,
          messagesAnalyzed: convo.length,
          conversationsScored: 1,
          contributionsCreated: convoContributions,
          inputTokens: cost.inputTokens,
          outputTokens: cost.outputTokens,
          costEstimate: cost.estimatedCost,
        });
      } else {
        for (const c of contributions) {
          const msg = convo.find(m => m.author_id === c.memberId);
          console.log(`      [dry] +${c.points} pts -> ${msg?.username || c.memberId} (${c.type})`);
        }
        totalContributions += contributions.length;
        channelContributions += contributions.length;
      }

      // Small delay between API calls
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`    #${channel.name} done: ${channelConversations} convos, ${channelContributions} contributions`);
  }

  // ──── Summary ────
  
  const cost = scorer.getEstimatedCost();

  console.log(`\n=== Summary ===`);
  console.log(`Messages analyzed: ${totalMessages}`);
  console.log(`Conversations scored: ${totalConversations}`);
  console.log(`Contributions ${dryRun ? '(would be) ' : ''}created: ${totalContributions}`);
  console.log(`Tokens: ${cost.inputTokens} in / ${cost.outputTokens} out`);
  console.log(`Estimated cost: $${cost.estimatedCost.toFixed(4)}`);

  if (!dryRun && totalContributions > 0) {
    console.log(`\n--- Leaderboard Update ---`);
    const leaders = db.getLeaderboard({ limit: 10 });
    for (const m of leaders) {
      console.log(`  ${m.display_name || m.username}: ${m.total_points} pts (Lv.${m.level} ${m.level_name})`);
    }
  }

  scorer.close();
  db.close();
}

analyze().catch(err => {
  console.error('Analysis failed:', err);
  scorer.close();
  db.close();
  process.exit(1);
});
