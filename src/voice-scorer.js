/**
 * Voice Transcript Scorer
 * 
 * Takes a completed voice session transcript and scores it using the same
 * AI scoring pipeline as text conversations. Stores results as contributions.
 * 
 * The key insight: a voice transcript IS just a conversation. Once we have it,
 * the entire existing scoring system (helpfulness, teaching, ideas, reactions)
 * works without modification.
 */

import { ContributionDB } from './db.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class VoiceScorer {
  constructor({ db, config, anthropicAuthToken }) {
    this.db = db;
    this.config = config;
    this.authToken = anthropicAuthToken;
    this.model = 'claude-haiku-4-5-20250315';
  }

  /**
   * Score a completed voice session
   * sessionData: { channelId, channelName, startedAt, endedAt, participants, segments, fullTranscript }
   * memberMap: { userId → { username, displayName } } — resolved before calling
   */
  async scoreSession(sessionData, memberMap = {}) {
    const { channelName, segments, participants } = sessionData;

    if (!segments || segments.length === 0) {
      console.log('[voice-scorer] No segments to score');
      return [];
    }

    // Build conversation text with real usernames
    const formattedConversation = segments
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .map(s => {
        const member = memberMap[s.userId];
        const name = member?.displayName || member?.username || s.userId;
        return `[${name}]: ${s.text}`;
      })
      .join('\n');

    // Unique human participants (filter out bots)
    const humanParticipants = participants.filter(id => memberMap[id] && !memberMap[id]?.isBot);
    if (humanParticipants.length < 2) {
      console.log('[voice-scorer] Not enough human participants to score');
      return [];
    }

    // Duration info
    const durationMinutes = segments.length > 0
      ? Math.round((new Date(sessionData.endedAt) - new Date(sessionData.startedAt)) / 60000)
      : 0;

    const prompt = `You are scoring Discord voice chat contributions for the "${channelName}" channel.
This is a VOICE CONVERSATION transcript (automatically transcribed — may have minor transcription errors).
The session lasted approximately ${durationMinutes} minutes.

Analyze this voice conversation and rate each participant's contribution quality.

IMPORTANT RULES:
- Only score HUMAN participants (skip bots)
- A score of 0 means no notable contribution
- Be strict — casual chatting is 1-3, genuinely helpful is 5-7, outstanding is 8-10
- "Teaching" means actually explaining something to someone who didn't know it
- "Tool share" means sharing a specific tool, resource, or recommendation others can act on
- "Idea" means proposing something concrete that could be executed
- Voice transcripts may have errors — be forgiving of apparent typos/mishearings
- Give credit for asking good questions, not just answering them

Transcript:
---
${formattedConversation}
---

For each unique participant, return a JSON object. ONLY return valid JSON, no other text:
{
  "scores": [
    {
      "user_id": "discord_user_id_or_name_used_in_transcript",
      "username": "display name from transcript",
      "helpfulness": 0-10,
      "teaching": 0-10,
      "engagement_quality": 0-10,
      "shared_resources": [],
      "notable_actions": [],
      "ideas_proposed": [],
      "is_spam_or_farming": false,
      "reasoning": "1-2 sentence explanation"
    }
  ],
  "conversation_quality": 0-10,
  "topics": ["topic1"]
}`;

    try {
      const { Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ authToken: this.authToken });

      const response = await client.messages.create({
        model: this.model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('[voice-scorer] No JSON in response');
        return [];
      }

      const scored = JSON.parse(jsonMatch[0]);
      const qualityMultiplier = (scored.conversation_quality ?? 7) / 10;
      const pointConfig = this.config.point_values || {};
      const season = this.db.getActiveSeason?.() || null;

      const contributions = [];
      const messageIds = segments.map(s => `voice:${s.userId}:${s.timestamp}`);

      for (const participant of scored.scores || []) {
        if (participant.is_spam_or_farming) continue;

        const { helpfulness, teaching, engagement_quality } = participant;

        // Resolve user ID — match by username if not a raw ID
        let memberId = participant.user_id;
        if (!memberId.match(/^\d{17,19}$/)) {
          // Try to find by display name
          const found = Object.entries(memberMap).find(([, m]) =>
            m.displayName?.toLowerCase() === participant.username?.toLowerCase() ||
            m.username?.toLowerCase() === participant.username?.toLowerCase()
          );
          if (found) memberId = found[0];
        }

        if (!memberId) continue;

        // Ensure member exists
        const member = memberMap[memberId];
        if (member) {
          this.db.upsertMember(memberId, member.username, member.displayName);
        }

        // Helpful conversation
        if (helpfulness >= 5) {
          const base = pointConfig.helpful_conversation?.base || 5;
          const maxMult = pointConfig.helpful_conversation?.max_multiplier || 2;
          const mult = 1.0 + ((helpfulness - 5) / 5) * (maxMult - 1);
          const points = Math.max(1, Math.round(base * mult * qualityMultiplier));
          contributions.push({
            memberId,
            type: 'voice_helpful',
            points,
            rawScore: helpfulness,
            multiplier: mult,
            evidence: JSON.stringify({
              reasoning: participant.reasoning,
              notable_actions: participant.notable_actions,
              conversation_quality: scored.conversation_quality,
              session_duration_minutes: durationMinutes,
              topics: scored.topics,
              source_detail: 'voice_transcript',
            }),
            channelName: `voice:${channelName}`,
            source: 'voice_analysis',
            messageIds: JSON.stringify(messageIds.slice(0, 10)),
            seasonId: season?.id || null,
          });
        }

        // Teaching
        if (teaching >= 6) {
          const base = pointConfig.teaching_moment?.base || 8;
          const maxMult = pointConfig.teaching_moment?.max_multiplier || 2;
          const mult = 1.0 + ((teaching - 6) / 4) * (maxMult - 1);
          const points = Math.max(1, Math.round(base * mult * qualityMultiplier));
          contributions.push({
            memberId,
            type: 'voice_teaching',
            points,
            rawScore: teaching,
            multiplier: mult,
            evidence: JSON.stringify({
              reasoning: participant.reasoning,
              topics: scored.topics,
              source_detail: 'voice_transcript',
            }),
            channelName: `voice:${channelName}`,
            source: 'voice_analysis',
            messageIds: JSON.stringify(messageIds.slice(0, 10)),
            seasonId: season?.id || null,
          });
        }

        // Ideas proposed (voice-specific — this is where Mike's insight lives)
        if (participant.ideas_proposed?.length > 0) {
          const baseIdeaPts = 5;
          contributions.push({
            memberId,
            type: 'voice_idea',
            points: baseIdeaPts * Math.min(participant.ideas_proposed.length, 3),
            rawScore: engagement_quality,
            multiplier: 1.0,
            evidence: JSON.stringify({
              ideas: participant.ideas_proposed,
              reasoning: participant.reasoning,
              source_detail: 'voice_transcript',
            }),
            channelName: `voice:${channelName}`,
            source: 'voice_analysis',
            messageIds: JSON.stringify(messageIds.slice(0, 10)),
            seasonId: season?.id || null,
          });
        }
      }

      // Write contributions
      for (const c of contributions) {
        this.db.addContribution(c);
      }

      console.log(`[voice-scorer] Scored voice session in #${channelName}: ${contributions.length} contributions, ${contributions.reduce((s, c) => s + c.points, 0)} pts`);
      return contributions;

    } catch (err) {
      console.error(`[voice-scorer] Scoring error: ${err.message}`);
      return [];
    }
  }

  /**
   * Convenience: store a voice transcript in the DB for later review
   */
  storeTranscript(sessionData, guildId) {
    try {
      this.db.db.prepare(`
        CREATE TABLE IF NOT EXISTS voice_transcripts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT,
          channel_id TEXT NOT NULL,
          channel_name TEXT,
          started_at TEXT,
          ended_at TEXT,
          participant_ids TEXT,
          transcript TEXT,
          segments TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `).run();

      this.db.db.prepare(`
        INSERT INTO voice_transcripts 
          (guild_id, channel_id, channel_name, started_at, ended_at, participant_ids, transcript, segments)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        guildId || null,
        sessionData.channelId,
        sessionData.channelName,
        sessionData.startedAt,
        sessionData.endedAt,
        JSON.stringify(sessionData.participants),
        sessionData.fullTranscript,
        JSON.stringify(sessionData.segments),
      );

      console.log(`[voice-scorer] Transcript stored for #${sessionData.channelName}`);
    } catch (err) {
      console.error(`[voice-scorer] Failed to store transcript: ${err.message}`);
    }
  }
}
