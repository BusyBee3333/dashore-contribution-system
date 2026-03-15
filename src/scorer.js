/**
 * AI Conversation Scorer
 * 
 * Pulls conversations from discrawl, clusters them, and uses Claude or OpenAI
 * to score each participant's contribution quality.
 * 
 * Supports two providers:
 *   - anthropic: uses @anthropic-ai/sdk (needs ANTHROPIC_API_KEY)
 *   - openai: uses OpenAI chat completions (needs OPENAI_API_KEY)
 */

import Database from 'better-sqlite3';
import { resolve } from 'path';

const DISCRAWL_DB = resolve(process.env.HOME, '.discrawl/discrawl.db');
const GUILD_ID = '1449158500344270961'; // DaShore Incubator

// Channels to skip (bot channels, alerts, etc.)
const SKIP_CHANNELS = new Set([
  'bot-talk', 'alerts', 'dashboard', 'oogie2', 
  'reddit-digest', 'trending-agent-repos', 'ai-twitter-threads',
  'contribution-system'
]);

export class ConversationScorer {
  constructor(config = {}) {
    this.provider = config.provider || 'openai'; // 'anthropic' or 'openai'
    this.model = config.model || (this.provider === 'anthropic' ? 'claude-haiku-4-5-20250315' : 'gpt-4o-mini');
    this.guildId = config.guildId || GUILD_ID;
    this.conversationGapMinutes = config.conversationGapMinutes || 30;
    this.minMessages = config.minMessages || 3;
    this.minMessagesThread = config.minMessagesThread || 2;
    this.discrawlDb = new Database(config.discrawlDb || DISCRAWL_DB, { readonly: true });
    this.apiKey = config.apiKey || null;
    this.authToken = config.authToken || null; // OAuth token (Bearer auth)

    // Token/cost tracking
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;

    // Lazy-init clients
    this._client = null;
  }

  async _getClient() {
    if (this._client) return this._client;
    if (this.provider === 'anthropic') {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      // Support both API key and OAuth token auth
      const opts = {};
      if (this.authToken) {
        opts.authToken = this.authToken;
      } else if (this.apiKey) {
        opts.apiKey = this.apiKey;
      }
      this._client = new Anthropic(opts);
    } else {
      // OpenAI-compatible via fetch (no extra dependency needed)
      this._client = 'openai';
    }
    return this._client;
  }

  /**
   * Get channels worth analyzing.
   * Threads use a lower message threshold (minMessagesThread) than regular channels.
   */
  getActiveChannels() {
    const channels = this.discrawlDb.prepare(`
      SELECT DISTINCT c.id, c.name, c.kind
      FROM channels c
      JOIN messages m ON c.id = m.channel_id
      WHERE c.guild_id = ?
        AND c.kind IN ('text', 'thread_public', 'thread_private')
      GROUP BY c.id
      HAVING COUNT(m.id) >= (
        CASE WHEN c.kind IN ('thread_public', 'thread_private')
          THEN ${this.minMessagesThread}
          ELSE ${this.minMessages}
        END
      )
      ORDER BY COUNT(m.id) DESC
    `).all(this.guildId);

    return channels.filter(c => !SKIP_CHANNELS.has(c.name));
  }

  /**
   * Pull messages from discrawl for a channel within a time range
   */
  getMessages(channelId, sinceISO, untilISO = null) {
    let sql = `
      SELECT m.id, m.author_id, m.content, m.created_at, m.reply_to_message_id,
             m.has_attachments, m.normalized_content,
             mem.username, mem.display_name, mem.nick
      FROM messages m
      LEFT JOIN members mem ON m.author_id = mem.user_id AND mem.guild_id = ?
      WHERE m.channel_id = ? 
        AND m.created_at >= ?
        AND m.author_id IS NOT NULL
        AND m.content != ''
        AND m.message_type IN (0, 19)
    `;
    const params = [this.guildId, channelId, sinceISO];

    if (untilISO) {
      sql += ' AND m.created_at <= ?';
      params.push(untilISO);
    }

    sql += ' ORDER BY m.created_at ASC';
    return this.discrawlDb.prepare(sql).all(...params);
  }

  /**
   * Get reaction counts for messages (from raw_json since discrawl stores them there)
   */
  getReactions(messageIds) {
    if (!messageIds.length) return {};
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = this.discrawlDb.prepare(`
      SELECT id, json_extract(raw_json, '$.reactions') as reactions
      FROM messages
      WHERE id IN (${placeholders})
        AND json_extract(raw_json, '$.reactions') IS NOT NULL
    `).all(...messageIds);

    const result = {};
    for (const row of rows) {
      try {
        const reactions = JSON.parse(row.reactions);
        result[row.id] = reactions.reduce((sum, r) => sum + (r.count || 0), 0);
      } catch { /* ignore */ }
    }
    return result;
  }

  /**
   * Cluster messages into conversation threads based on time gaps.
   * @param {Array} messages
   * @param {number} [minMessagesOverride] - Optional override for the minimum message threshold
   */
  clusterConversations(messages, minMessagesOverride) {
    if (!messages.length) return [];
    const minMsgs = minMessagesOverride !== undefined ? minMessagesOverride : this.minMessages;
    const conversations = [];
    let current = [messages[0]];

    for (let i = 1; i < messages.length; i++) {
      const prev = new Date(messages[i - 1].created_at);
      const curr = new Date(messages[i].created_at);
      const gapMinutes = (curr - prev) / (1000 * 60);

      if (gapMinutes > this.conversationGapMinutes) {
        if (current.length >= minMsgs) {
          conversations.push(current);
        }
        current = [messages[i]];
      } else {
        current.push(messages[i]);
      }
    }

    if (current.length >= minMsgs) {
      conversations.push(current);
    }

    return conversations;
  }

  /**
   * Format a conversation cluster for the AI prompt
   */
  formatConversation(messages) {
    return messages.map(m => {
      const name = m.nick || m.display_name || m.username || 'unknown';
      const timestamp = m.created_at.replace('T', ' ').slice(0, 19);
      const reply = m.reply_to_message_id ? ' [reply]' : '';
      return `[${timestamp}] ${name} (${m.author_id})${reply}: ${m.content}`;
    }).join('\n');
  }

  /**
   * Score a single conversation using Claude
   */
  async scoreConversation(messages, channelName) {
    const formatted = this.formatConversation(messages);
    const messageIds = messages.map(m => m.id);
    const reactions = this.getReactions(messageIds);

    // Build reaction context
    let reactionContext = '';
    const reactionEntries = Object.entries(reactions);
    if (reactionEntries.length) {
      reactionContext = '\n\nReaction counts per message:\n' + 
        reactionEntries.map(([id, count]) => {
          const msg = messages.find(m => m.id === id);
          const name = msg?.nick || msg?.display_name || msg?.username || 'unknown';
          return `- ${name}'s message: ${count} reactions`;
        }).join('\n');
    }

    // Unique participants
    const participants = [...new Set(messages.map(m => m.author_id))];
    if (participants.length < 2) return null; // Monologue, skip

    const prompt = `You are scoring Discord community contributions for the "${channelName}" channel.
Analyze this conversation and rate each participant's contribution quality.

IMPORTANT RULES:
- Only score HUMAN participants (skip bots)
- A score of 0 means no notable contribution
- Be strict — casual chatting is 1-3, genuinely helpful is 5-7, outstanding is 8-10
- "Teaching" means actually explaining something to someone who didn't know it
- "Tool share" means sharing a specific tool, library, link, or resource others can use
- Consider reaction counts as social proof of value
- Flag any suspiciously low-effort farming behavior

Conversation:
---
${formatted}
---${reactionContext}

For each unique participant, return a JSON object. ONLY return valid JSON, no other text:
{
  "scores": [
    {
      "user_id": "discord_user_id",
      "username": "display name used in convo",
      "helpfulness": 0-10,
      "teaching": 0-10,
      "engagement_quality": 0-10,
      "shared_resources": [],
      "notable_actions": [],
      "is_spam_or_farming": false,
      "reasoning": "1-2 sentence explanation"
    }
  ],
  "conversation_quality": 0-10,
  "topics": ["topic1"]
}`;

    try {
      await this._getClient();
      let text;

      if (this.provider === 'anthropic') {
        const response = await this._client.messages.create({
          model: this.model,
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }],
        });
        this.totalInputTokens += response.usage.input_tokens;
        this.totalOutputTokens += response.usage.output_tokens;
        text = response.content[0]?.text || '';
      } else {
        // OpenAI-compatible
        const apiKey = this.apiKey || process.env.OPENAI_API_KEY;
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: 1500,
            temperature: 0.3,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        text = data.choices?.[0]?.message?.content || '';
        this.totalInputTokens += data.usage?.prompt_tokens || 0;
        this.totalOutputTokens += data.usage?.completion_tokens || 0;
      }

      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('  [scorer] no JSON found in response');
        return null;
      }

      const result = JSON.parse(jsonMatch[0]);
      result._messageIds = messageIds;
      result._channelName = channelName;

      // Compute per-participant reaction totals for bonus scoring
      const participantReactionCounts = {};
      for (const msg of messages) {
        const count = reactions[msg.id] || 0;
        if (count > 0) {
          participantReactionCounts[msg.author_id] = (participantReactionCounts[msg.author_id] || 0) + count;
        }
      }
      result._reactionBonuses = {};
      for (const [userId, total] of Object.entries(participantReactionCounts)) {
        let bonus = 0;
        if (total >= 11) bonus = 3;
        else if (total >= 6) bonus = 2;
        else if (total >= 3) bonus = 1;
        if (bonus > 0) result._reactionBonuses[userId] = bonus;
      }

      return result;
    } catch (err) {
      console.error(`  [scorer] API error: ${err.message}`);
      return null;
    }
  }

  /**
   * Convert AI scores into contribution records.
   * All AI-scored point values are weighted by conversation_quality / 10.
   */
  scoresToContributions(scored, pointConfig) {
    const contributions = [];
    if (!scored?.scores) return contributions;

    // Quality multiplier: scales all AI-scored points by conversation quality (0.0 – 1.0)
    const qualityMultiplier = (scored.conversation_quality ?? 10) / 10;

    for (const participant of scored.scores) {
      if (participant.is_spam_or_farming) {
        console.log(`  [anti-gaming] flagged ${participant.username} as potential farming`);
        continue;
      }

      const { helpfulness, teaching, engagement_quality } = participant;

      // Helpful conversation (helpfulness >= 5)
      if (helpfulness >= 5) {
        const multiplier = 1.0 + ((helpfulness - 5) / 5) * (pointConfig.helpful_conversation.max_multiplier - 1);
        const rawPoints = Math.round(pointConfig.helpful_conversation.base * multiplier);
        const points = Math.max(1, Math.round(rawPoints * qualityMultiplier));
        contributions.push({
          memberId: participant.user_id,
          type: 'helpful_conversation',
          points,
          rawScore: helpfulness,
          multiplier,
          evidence: {
            reasoning: participant.reasoning,
            notable_actions: participant.notable_actions,
            conversation_quality: scored.conversation_quality,
            quality_multiplier: qualityMultiplier,
            topics: scored.topics,
          },
          channelName: scored._channelName,
          source: 'ai_analysis',
          messageIds: scored._messageIds,
        });
      }

      // Teaching moment (teaching >= 6)
      if (teaching >= 6) {
        const multiplier = 1.0 + ((teaching - 6) / 4) * (pointConfig.teaching_moment.max_multiplier - 1);
        const rawPoints = Math.round(pointConfig.teaching_moment.base * multiplier);
        const points = Math.max(1, Math.round(rawPoints * qualityMultiplier));
        contributions.push({
          memberId: participant.user_id,
          type: 'teaching_moment',
          points,
          rawScore: teaching,
          multiplier,
          evidence: {
            reasoning: participant.reasoning,
            topics: scored.topics,
            conversation_quality: scored.conversation_quality,
            quality_multiplier: qualityMultiplier,
          },
          channelName: scored._channelName,
          source: 'ai_analysis',
          messageIds: scored._messageIds,
        });
      }

      // Tool/resource sharing
      if (participant.shared_resources?.length > 0) {
        const multiplier = Math.min(participant.shared_resources.length, pointConfig.tool_share.max_multiplier);
        const rawPoints = Math.round(pointConfig.tool_share.base * multiplier);
        const points = Math.max(1, Math.round(rawPoints * qualityMultiplier));
        contributions.push({
          memberId: participant.user_id,
          type: 'tool_share',
          points,
          rawScore: engagement_quality,
          multiplier,
          evidence: {
            resources: participant.shared_resources,
            reasoning: participant.reasoning,
            conversation_quality: scored.conversation_quality,
            quality_multiplier: qualityMultiplier,
          },
          channelName: scored._channelName,
          source: 'ai_analysis',
          messageIds: scored._messageIds,
        });
      }

      // Reaction bonus (not scaled by quality — it's direct community feedback)
      const reactionBonus = scored._reactionBonuses?.[participant.user_id] || 0;
      if (reactionBonus > 0) {
        contributions.push({
          memberId: participant.user_id,
          type: 'reaction_bonus',
          points: reactionBonus,
          rawScore: reactionBonus,
          multiplier: 1.0,
          evidence: {
            reaction_bonus_points: reactionBonus,
            reasoning: `Community reactions on messages (+${reactionBonus} bonus pts)`,
          },
          channelName: scored._channelName,
          source: 'ai_analysis',
          messageIds: scored._messageIds,
        });
      }
    }

    return contributions;
  }

  /**
   * Estimate cost for a scoring run
   */
  getEstimatedCost() {
    // Haiku pricing: $0.80/M input, $4/M output
    const inputCost = (this.totalInputTokens / 1_000_000) * 0.80;
    const outputCost = (this.totalOutputTokens / 1_000_000) * 4.00;
    return {
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      estimatedCost: inputCost + outputCost,
    };
  }

  close() {
    this.discrawlDb.close();
  }
}
