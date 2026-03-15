/**
 * Event Detection Module
 * 
 * Handles three types of event-based contributions:
 *   1. Discord Scheduled Events — guildScheduledEventCreate / guildScheduledEventUserAdd
 *   2. Voice Activity — 3+ people join a channel within voice_host_timeout_minutes → host gets event_hosted pts
 *   3. Announcement Heuristics — messages with event-like language + 3+ reactions in #announcements / #general
 */

import { ContributionDB } from './db.js';

// ──── Event Language Heuristics ────

const EVENT_KEYWORDS = [
  'join us', 'live session', 'masterclass', 'workshop', 'webinar',
  'office hours', 'ama ', 'ask me anything', 'going live', 'stream',
  'meetup', 'space ', 'twitter space', 'listen in', 'drop in',
  'zoom link', 'meet.google', 'luma.lu', 'lu.ma', 'eventbrite',
  'cal.com', 'calendly', 'at \d{1,2}(:\d{2})?(am|pm)', // time patterns
  'tonight', 'tomorrow', 'this week', 'next week',
  'registration', 'rsvp', 'sign up', 'ticket',
];

const EVENT_KEYWORD_RE = new RegExp(EVENT_KEYWORDS.join('|'), 'i');

// Scheduling link patterns
const SCHEDULING_LINK_RE = /https?:\/\/(lu\.ma|luma\.lu|calendly\.com|cal\.com|eventbrite\.com|zoom\.us|meet\.google\.com)/i;

function isEventLike(content) {
  return EVENT_KEYWORD_RE.test(content) || SCHEDULING_LINK_RE.test(content);
}

// ──── EventTracker class ────

export class EventTracker {
  /**
   * @param {ContributionDB} db 
   * @param {object} config  — full config.json
   * @param {object} pointConfig — config.points
   */
  constructor(db, config, pointConfig) {
    this.db = db;
    this.config = config;
    this.points = pointConfig;

    // Voice session state: channelId -> { sessionId, participants: Set, hostTimer }
    this._voiceSessions = new Map();

    const evtCfg = config.events || {};
    this.voiceMinParticipants  = evtCfg.voice_min_participants   || 3;
    this.voiceHostTimeoutMs    = (evtCfg.voice_host_timeout_minutes || 5) * 60 * 1000;
    this.announcementChannels  = new Set(evtCfg.announcement_channels || ['announcements', 'general']);
    this.reactionThreshold     = evtCfg.event_reaction_threshold  || 3;
  }

  // ──────────────────────────────────────────────────────────
  //  1. Scheduled Events
  // ──────────────────────────────────────────────────────────

  /**
   * Called when a Discord scheduled event is created.
   * Awards event_hosted points to the creator.
   */
  async onScheduledEventCreate(event) {
    const creatorId = event.creatorId || event.creator?.id;
    if (!creatorId) return;

    const pts = this.points.event_hosted?.base || 20;
    const name = event.name || 'scheduled event';

    try {
      this.db.upsertMember(creatorId, event.creator?.username || creatorId);
      this.db.addContribution({
        memberId: creatorId,
        type: 'event_hosted',
        points: pts,
        evidence: {
          event_id: event.id,
          event_name: name,
          scheduled_start: event.scheduledStartAt?.toISOString?.() || null,
          source_detail: 'discord_scheduled_event',
        },
        source: 'event',
      });
      console.log(`[events] +${pts} event_hosted -> ${creatorId} (created scheduled event: ${name})`);
    } catch (err) {
      console.error(`[events] onScheduledEventCreate error:`, err.message);
    }
  }

  /**
   * Called when a user RSVPs to a scheduled event.
   * Awards event_attended points.
   */
  async onScheduledEventUserAdd(event, user) {
    const userId = user.id;
    const creatorId = event.creatorId || event.creator?.id;

    // Don't award attendance to the host (they already got event_hosted)
    if (userId === creatorId) return;

    const pts = this.points.event_attended?.base || 3;

    try {
      this.db.upsertMember(userId, user.username || userId);
      this.db.addContribution({
        memberId: userId,
        type: 'event_attended',
        points: pts,
        evidence: {
          event_id: event.id,
          event_name: event.name,
          source_detail: 'discord_scheduled_event_rsvp',
        },
        source: 'event',
      });
      if (process.env.DEBUG_EVENTS) {
        console.log(`[events] +${pts} event_attended -> ${userId} (RSVP: ${event.name})`);
      }
    } catch (err) {
      console.error(`[events] onScheduledEventUserAdd error:`, err.message);
    }
  }

  // ──────────────────────────────────────────────────────────
  //  2. Voice Activity
  // ──────────────────────────────────────────────────────────

  /**
   * Called on voiceStateUpdate.
   * oldState / newState are Discord.js VoiceState objects.
   */
  async onVoiceStateUpdate(oldState, newState) {
    const userId    = newState.member?.id || oldState.member?.id;
    const username  = newState.member?.user?.username || oldState.member?.user?.username || userId;
    const isBot     = newState.member?.user?.bot || oldState.member?.user?.bot;
    if (!userId || isBot) return;

    const joinedChannel = newState.channelId && newState.channelId !== oldState.channelId
      ? newState.channel
      : null;
    const leftChannel = oldState.channelId && oldState.channelId !== newState.channelId
      ? oldState.channel
      : null;

    // ── User joined a voice channel ──
    if (joinedChannel) {
      const channelId   = joinedChannel.id;
      const channelName = joinedChannel.name;

      this.db.upsertMember(userId, username);

      let session = this._voiceSessions.get(channelId);

      if (!session) {
        // First person in channel — start a session, set initiator
        const dbSession = this.db.startVoiceSession(channelId, channelName, userId);
        session = {
          sessionId:    dbSession.lastInsertRowid,
          initiatorId:  userId,
          participants: new Set([userId]),
          hostTimer:    null,
          hostAwarded:  false,
        };
        this._voiceSessions.set(channelId, session);
        console.log(`[events/voice] session started in #${channelName} by ${username}`);

        // Set timer: if threshold met within timeout, award host
        session.hostTimer = setTimeout(
          () => this._checkVoiceHost(channelId),
          this.voiceHostTimeoutMs
        );
      } else {
        // Join existing session
        session.participants.add(userId);
        const count = session.participants.size;
        this.db.updateVoiceSession(session.sessionId, [...session.participants], count);
        console.log(`[events/voice] ${username} joined #${channelName} (${count} participants)`);
      }
    }

    // ── User left a voice channel ──
    if (leftChannel) {
      const channelId = leftChannel.id;
      const session   = this._voiceSessions.get(channelId);
      if (!session) return;

      session.participants.delete(userId);
      const count = session.participants.size;
      console.log(`[events/voice] ${username} left #${leftChannel.name} (${count} remaining)`);

      if (count === 0) {
        // Empty channel — close session
        clearTimeout(session.hostTimer);
        this.db.endVoiceSession(session.sessionId);
        this._voiceSessions.delete(channelId);
        console.log(`[events/voice] session ended in #${leftChannel.name}`);
      } else {
        this.db.updateVoiceSession(session.sessionId, [...session.participants], session.participants.size);
      }
    }
  }

  /**
   * Called after voice_host_timeout_minutes to check if threshold was met.
   */
  async _checkVoiceHost(channelId) {
    const session = this._voiceSessions.get(channelId);
    if (!session || session.hostAwarded) return;

    const count = session.participants.size;
    if (count >= this.voiceMinParticipants) {
      const initiatorId = session.initiatorId;
      const pts = this.points.event_hosted?.base || 20;

      session.hostAwarded = true;
      this.db.markVoiceSessionHostAwarded(session.sessionId);

      this.db.addContribution({
        memberId: initiatorId,
        type: 'event_hosted',
        points: pts,
        evidence: {
          voice_session_id: session.sessionId,
          peak_participants: count,
          source_detail: 'voice_activity_host',
        },
        source: 'event',
      });

      // Award attendance to participants (excluding initiator)
      const attendPts = this.points.event_attended?.base || 3;
      for (const participantId of session.participants) {
        if (participantId === initiatorId) continue;
        this.db.addContribution({
          memberId: participantId,
          type: 'event_attended',
          points: attendPts,
          evidence: {
            voice_session_id: session.sessionId,
            source_detail: 'voice_activity_attendee',
          },
          source: 'event',
        });
      }

      console.log(`[events/voice] threshold met! +${pts} event_hosted -> ${initiatorId}, +${attendPts} event_attended to ${count - 1} others`);
    } else {
      if (process.env.DEBUG_EVENTS) {
        console.log(`[events/voice] threshold not met for channel ${channelId} (${count}/${this.voiceMinParticipants})`);
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  //  3. Announcement Heuristics (call from messageReactionAdd)
  // ──────────────────────────────────────────────────────────

  /**
   * Called on messageReactionAdd. Pass the reaction and user objects.
   * Checks if message is in an announcement channel, event-like, and has hit the reaction threshold.
   */
  async onReactionAdd(reaction, user) {
    if (user.bot) return;

    // Only care about announcement/general channels
    const channelName = reaction.message.channel?.name || '';
    if (!this.announcementChannels.has(channelName)) return;

    // Fetch full message if partial
    let message = reaction.message;
    if (message.partial) {
      try { message = await message.fetch(); } catch { return; }
    }
    if (message.author?.bot) return;

    const content = message.content || '';
    if (!isEventLike(content)) return;

    // Count total reactions
    const totalReactions = message.reactions.cache.reduce(
      (sum, r) => sum + (r.count || 0), 0
    );

    if (totalReactions < this.reactionThreshold) return;

    // Check if we already awarded this message
    const eventId = `announcement_event:${message.id}`;
    if (this.db.hasGithubEvent(eventId)) return; // reuse github_events dedup table

    const authorId = message.author.id;
    const pts = this.points.event_hosted?.base || 20;

    try {
      this.db.upsertMember(authorId, message.author.username);
      this.db.addContribution({
        memberId: authorId,
        type: 'event_hosted',
        points: pts,
        evidence: {
          message_id: message.id,
          channel: channelName,
          content_preview: content.slice(0, 200),
          total_reactions: totalReactions,
          source_detail: 'announcement_heuristic',
        },
        source: 'event',
      });

      // Record dedup so we don't award again on each new reaction
      this.db.recordGithubEvent({
        eventId,
        eventType: 'event_hosted',
        repo: 'discord',
        githubAuthor: message.author.username,
        discordId: authorId,
        pointsAwarded: pts,
      });

      console.log(`[events/announcement] +${pts} event_hosted -> ${message.author.username} (${totalReactions} reactions in #${channelName})`);
    } catch (err) {
      console.error(`[events] onReactionAdd error:`, err.message);
    }
  }

  /**
   * Clean up in-memory voice sessions on shutdown.
   */
  cleanup() {
    for (const [channelId, session] of this._voiceSessions) {
      clearTimeout(session.hostTimer);
      this.db.endVoiceSession(session.sessionId);
    }
    this._voiceSessions.clear();
  }
}
