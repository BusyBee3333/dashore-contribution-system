/**
 * Idea Impact Tracker
 * 
 * Detects when a human's idea/suggestion leads to real outcomes.
 * Runs as a second pass after conversation scoring.
 * 
 * Signal chain:
 *   1. Human posts an idea/suggestion in Discord
 *   2. Other humans react positively (reactions, agreement replies)
 *   3. A bot (Buba/Oogie) executes the idea
 *   4. Outcome is produced (repo created, cron added, channel restructured, etc.)
 *   5. This tracker connects the dots and auto-awards bonus points
 * 
 * Data sources:
 *   - discrawl DB: messages, reactions, channel metadata
 *   - GitHub (via gh CLI): repos created within timeframe
 *   - Cron jobs (via clawdbot config): jobs created within timeframe
 *   - Channel changes: new channels, renames, deletions
 */

import Database from 'better-sqlite3';
import { resolve } from 'path';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const DISCRAWL_DB = resolve(process.env.HOME, '.discrawl/discrawl.db');
const GUILD_ID = '1449158500344270961';

// Bot user IDs to identify bot execution
const BOT_IDS = new Set([
  '1458234593714114640',  // Buba
  '1475640365842432061',  // Oogie
  '1476170950302236752',  // Buba Jr
]);

// Patterns that indicate an idea/suggestion
const IDEA_PATTERNS = [
  /(?:we should|you should|let's|can (?:you|we)|how about|what if|i think we need|propose|suggest|idea:|wouldn't it be)/i,
  /(?:analyze|restructure|reorganize|set up|create|build|make a|automate|design)/i,
  /(?:cron|script|bot|repo|dashboard|pipeline|system|tool)/i,
];

// Patterns that indicate positive sentiment in replies
const POSITIVE_PATTERNS = [
  /(?:great|nice|love|awesome|perfect|good|sick|dope|fire|yes|exactly|agreed|this is|brilliant|smart|genius)/i,
  /(?:let's do|on it|makes sense|good idea|that's hot|that works|do it)/i,
];

// Reaction emojis that indicate positive sentiment
const POSITIVE_REACTIONS = new Set([
  '🔥', '❤️', '👍', '💯', '✅', '🎉', '💪', '⭐', '🚀', '👀',
  '💛', '❤️‍🔥', '🙌', '👏', '💜', '🤝', '😍', '🫡',
]);

export class IdeaTracker {
  constructor(config = {}) {
    this.guildId = config.guildId || GUILD_ID;
    this.discrawlDb = new Database(config.discrawlDb || DISCRAWL_DB, { readonly: true });
    this.lookbackHours = config.lookbackHours || 48;
    this.outcomeWindowHours = config.outcomeWindowHours || 72;
    this.minReactions = config.minReactions || 1;
    this.minPositiveReplies = config.minPositiveReplies || 0;
    this.stateFile = config.stateFile || null;
    this._previouslyTracked = new Set();
    
    if (this.stateFile && existsSync(this.stateFile)) {
      try {
        const state = JSON.parse(readFileSync(this.stateFile, 'utf8'));
        this._previouslyTracked = new Set(state.trackedMessageIds || []);
      } catch { /* fresh start */ }
    }
  }

  /**
   * Find messages that look like ideas/suggestions from humans
   */
  findIdeas(sinceISO) {
    const messages = this.discrawlDb.prepare(`
      SELECT m.id, m.author_id, m.content, m.created_at, m.channel_id,
             c.name as channel_name,
             mem.username, mem.display_name, mem.nick
      FROM messages m
      JOIN channels c ON m.channel_id = c.id
      LEFT JOIN members mem ON m.author_id = mem.user_id AND mem.guild_id = ?
      WHERE c.guild_id = ?
        AND m.created_at >= ?
        AND m.author_id IS NOT NULL
        AND length(m.content) > 30
      ORDER BY m.created_at ASC
    `).all(this.guildId, this.guildId, sinceISO);

    const ideas = [];
    for (const msg of messages) {
      // Skip bots
      if (BOT_IDS.has(msg.author_id)) continue;
      
      // Skip already tracked
      if (this._previouslyTracked.has(msg.id)) continue;

      // Check if message matches idea patterns
      const content = msg.content || '';
      const matchCount = IDEA_PATTERNS.filter(p => p.test(content)).length;
      
      // Need at least 2 pattern matches to qualify as an "idea"
      if (matchCount >= 2) {
        ideas.push({
          ...msg,
          patternMatches: matchCount,
          displayName: msg.nick || msg.display_name || msg.username || 'unknown',
        });
      }
    }

    return ideas;
  }

  /**
   * For a given idea message, measure community sentiment
   */
  measureSentiment(ideaMsg) {
    const ideaTime = new Date(ideaMsg.created_at).getTime();
    const windowEnd = ideaTime + (2 * 3600000); // 2 hours after idea

    // Get reactions from raw_json (discrawl stores them in the message JSON)
    let positiveReactionCount = 0;
    let totalReactionCount = 0;
    const reactionEmojis = [];

    try {
      const row = this.discrawlDb.prepare(`
        SELECT json_extract(raw_json, '$.reactions') as reactions
        FROM messages
        WHERE id = ?
          AND json_extract(raw_json, '$.reactions') IS NOT NULL
      `).get(ideaMsg.id);

      if (row?.reactions) {
        const reactions = JSON.parse(row.reactions);
        for (const r of reactions) {
          const emoji = r.emoji?.name || r.emoji || '';
          const count = r.count || 1;
          totalReactionCount += count;
          reactionEmojis.push(`${emoji} (${count})`);
          if (POSITIVE_REACTIONS.has(emoji)) {
            positiveReactionCount += count;
          }
        }
      }
    } catch { /* no reactions or parse error */ }

    // Get replies/follow-up messages in the same channel within 2 hours
    const replies = this.discrawlDb.prepare(`
      SELECT m.id, m.author_id, m.content, m.created_at,
             mem.username, mem.display_name, mem.nick
      FROM messages m
      LEFT JOIN members mem ON m.author_id = mem.user_id AND mem.guild_id = ?
      WHERE m.channel_id = ?
        AND m.created_at > ?
        AND m.created_at <= ?
        AND m.author_id != ?
      ORDER BY m.created_at ASC
      LIMIT 20
    `).all(
      this.guildId,
      ideaMsg.channel_id,
      ideaMsg.created_at,
      new Date(windowEnd).toISOString(),
      ideaMsg.author_id
    );

    // Classify replies
    let positiveHumanReplies = 0;
    let botAcknowledgements = 0;
    let botExecutionMessages = 0;

    for (const reply of replies) {
      const content = reply.content || '';
      
      if (BOT_IDS.has(reply.author_id)) {
        // Bot response — check if it's acknowledging/executing the idea
        if (/(?:on it|done|created|pushed|shipped|set up|registered|deployed|got it|working on)/i.test(content)) {
          botExecutionMessages++;
        } else {
          botAcknowledgements++;
        }
      } else {
        // Human reply — check for positive sentiment
        if (POSITIVE_PATTERNS.some(p => p.test(content))) {
          positiveHumanReplies++;
        }
      }
    }

    return {
      positiveReactionCount,
      totalReactionCount,
      positiveHumanReplies,
      botAcknowledgements,
      botExecutionMessages,
      totalReplies: replies.length,
      reactionEmojis,
    };
  }

  /**
   * Check for real-world outcomes that happened after the idea
   */
  checkOutcomes(ideaMsg) {
    const outcomes = [];
    const ideaTime = new Date(ideaMsg.created_at);
    const windowEnd = new Date(ideaTime.getTime() + (this.outcomeWindowHours * 3600000));
    const content = (ideaMsg.content || '').toLowerCase();

    // 1. Check for GitHub repos created in the time window
    try {
      const reposJson = execSync(
        `gh repo list BusyBee3333 --json name,createdAt,description --limit 10 2>/dev/null`,
        { encoding: 'utf8', timeout: 10000 }
      );
      const repos = JSON.parse(reposJson);
      for (const repo of repos) {
        const createdAt = new Date(repo.createdAt);
        if (createdAt > ideaTime && createdAt < windowEnd) {
          // Check if repo name/description relates to the idea content
          const repoText = `${repo.name} ${repo.description || ''}`.toLowerCase();
          const ideaWords = content.split(/\s+/).filter(w => w.length > 4);
          const overlap = ideaWords.filter(w => repoText.includes(w)).length;
          
          if (overlap >= 1 || this._topicOverlap(content, repoText)) {
            outcomes.push({
              type: 'repo_created',
              detail: `GitHub repo created: ${repo.name}`,
              url: `https://github.com/BusyBee3333/${repo.name}`,
              relevance: overlap,
              timestamp: repo.createdAt,
            });
          }
        }
      }
    } catch { /* gh not available or error */ }

    // 2. Check for new Discord channels created after the idea
    try {
      const newChannels = this.discrawlDb.prepare(`
        SELECT id, name, kind, created_at
        FROM channels
        WHERE guild_id = ?
          AND created_at > ?
          AND created_at < ?
      `).all(this.guildId, ideaMsg.created_at, windowEnd.toISOString());

      for (const ch of newChannels) {
        if (this._topicOverlap(content, ch.name)) {
          outcomes.push({
            type: 'channel_created',
            detail: `Discord channel created: #${ch.name}`,
            channelId: ch.id,
            timestamp: ch.created_at,
          });
        }
      }
    } catch { /* discrawl might not have created_at */ }

    // 3. Check for bot messages that reference "done", "shipped", "created", "repo" 
    //    in the same channel within the outcome window
    try {
      const botFollowups = this.discrawlDb.prepare(`
        SELECT m.content, m.created_at, m.author_id
        FROM messages m
        WHERE m.channel_id = ?
          AND m.created_at > ?
          AND m.created_at < ?
          AND m.author_id IN (${[...BOT_IDS].map(() => '?').join(',')})
        ORDER BY m.created_at ASC
        LIMIT 30
      `).all(
        ideaMsg.channel_id,
        ideaMsg.created_at,
        windowEnd.toISOString(),
        ...BOT_IDS,
      );

      for (const msg of botFollowups) {
        const c = (msg.content || '').toLowerCase();
        if (/(?:repo|github\.com|pushed|shipped|deployed|cron.*registered|live at|created.*repo)/i.test(c)) {
          // Extract URL if present
          const urlMatch = c.match(/(https:\/\/github\.com\/\S+)/);
          outcomes.push({
            type: 'bot_execution',
            detail: msg.content.slice(0, 200),
            url: urlMatch?.[1] || null,
            timestamp: msg.created_at,
          });
        }
      }
    } catch { /* error reading discrawl */ }

    return outcomes;
  }

  /**
   * Check if two text strings share topic-relevant words
   */
  _topicOverlap(text1, text2) {
    const keywords1 = new Set(text1.toLowerCase().match(/\b[a-z]{4,}\b/g) || []);
    const keywords2 = new Set(text2.toLowerCase().match(/\b[a-z]{4,}\b/g) || []);
    let overlap = 0;
    for (const w of keywords1) {
      if (keywords2.has(w)) overlap++;
    }
    return overlap >= 2;
  }

  /**
   * Score an idea based on sentiment + outcomes
   * Returns a point value and evidence object
   */
  scoreIdea(idea, sentiment, outcomes) {
    let basePoints = 0;
    const reasons = [];

    // Sentiment scoring
    if (sentiment.positiveReactionCount >= 3) {
      basePoints += 3;
      reasons.push(`${sentiment.positiveReactionCount} positive reactions`);
    } else if (sentiment.positiveReactionCount >= 1) {
      basePoints += 1;
      reasons.push(`${sentiment.positiveReactionCount} positive reaction(s)`);
    }

    if (sentiment.positiveHumanReplies >= 2) {
      basePoints += 3;
      reasons.push(`${sentiment.positiveHumanReplies} humans agreed/supported`);
    } else if (sentiment.positiveHumanReplies >= 1) {
      basePoints += 1;
      reasons.push(`${sentiment.positiveHumanReplies} human agreed`);
    }

    if (sentiment.botExecutionMessages >= 1) {
      basePoints += 2;
      reasons.push('Bot executed the idea');
    }

    // Outcome scoring (this is the big multiplier)
    for (const outcome of outcomes) {
      switch (outcome.type) {
        case 'repo_created':
          basePoints += 10;
          reasons.push(`Led to repo: ${outcome.url || outcome.detail}`);
          break;
        case 'channel_created':
          basePoints += 5;
          reasons.push(`Led to channel: ${outcome.detail}`);
          break;
        case 'bot_execution':
          basePoints += 3;
          reasons.push(`Bot shipped: ${outcome.detail.slice(0, 100)}`);
          break;
      }
    }

    // Cap at reasonable max
    const points = Math.min(basePoints, 25);

    return {
      points,
      reasons,
      sentiment,
      outcomes,
      ideaMessage: {
        id: idea.id,
        author_id: idea.author_id,
        displayName: idea.displayName,
        content: (idea.content || '').slice(0, 300),
        channel: idea.channel_name,
        timestamp: idea.created_at,
      },
    };
  }

  /**
   * Run the full idea tracking pipeline
   * Returns array of scored ideas ready to be written as contributions
   */
  async run(sinceISO) {
    console.log(`\n=== Idea Impact Tracker ===`);
    console.log(`Looking back from: ${sinceISO}`);
    console.log(`Outcome window: ${this.outcomeWindowHours}h`);

    const ideas = this.findIdeas(sinceISO);
    console.log(`Found ${ideas.length} potential idea messages`);

    const results = [];

    for (const idea of ideas) {
      const sentiment = this.measureSentiment(idea);
      const outcomes = this.checkOutcomes(idea);

      // Only score if there's meaningful signal
      const hasSignal = 
        sentiment.positiveReactionCount >= this.minReactions ||
        sentiment.positiveHumanReplies >= this.minPositiveReplies ||
        sentiment.botExecutionMessages > 0 ||
        outcomes.length > 0;

      if (!hasSignal) continue;

      const scored = this.scoreIdea(idea, sentiment, outcomes);
      
      if (scored.points > 0) {
        results.push(scored);
        console.log(`  ✅ ${idea.displayName} — "${idea.content?.slice(0, 60)}..." → ${scored.points} pts`);
        console.log(`     Reasons: ${scored.reasons.join(', ')}`);
      }
    }

    // Save state
    if (this.stateFile) {
      const newTracked = [...this._previouslyTracked, ...results.map(r => r.ideaMessage.id)];
      writeFileSync(this.stateFile, JSON.stringify({
        trackedMessageIds: newTracked.slice(-500), // Keep last 500
        lastRun: new Date().toISOString(),
      }, null, 2));
    }

    console.log(`\nResults: ${results.length} ideas with impact (${results.reduce((s, r) => s + r.points, 0)} total pts)`);
    return results;
  }

  close() {
    this.discrawlDb.close();
  }
}
