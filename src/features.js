/**
 * New Engagement Features Module
 * 
 * 1. Reaction-Based Instant Points
 * 2. Public Level-Up Announcements
 * 3. First Contribution Ceremony (DM)
 * 4. Public Vouch Wall (#kudos channel)
 * 5. Help Wanted Auto-Ping
 */

import { EmbedBuilder } from 'discord.js';

// ──── Reaction Point Emojis ────

const DEFAULT_REACTION_EMOJIS = {
  '✅': { points: 3, label: 'helpful' },
  '⭐': { points: 5, label: 'great' },
  '🔥': { points: 3, label: 'fire' },
  '💡': { points: 4, label: 'idea' },
};

// ──── 1. Reaction-Based Instant Points ────

export class ReactionPoints {
  constructor(db, config, audit) {
    this.db = db;
    this.config = config;
    this.audit = audit;
    
    const rConfig = config.reaction_points || {};
    this.enabled = rConfig.enabled !== false;
    this.emojis = rConfig.emojis || DEFAULT_REACTION_EMOJIS;
    this.maxPointsPerMessage = rConfig.max_points_per_message || 5;
    this.maxPointsReceivedPerDay = rConfig.max_points_received_per_day || 20;
  }

  /**
   * Handle a messageReactionAdd event for instant points.
   * Returns true if points were awarded.
   */
  async onReactionAdd(reaction, user) {
    if (!this.enabled) return false;
    if (user.bot) return false;

    // Get emoji name (handles custom + unicode)
    const emoji = reaction.emoji.name;
    const emojiConfig = this.emojis[emoji];
    if (!emojiConfig) return false;

    // Fetch full message if partial
    let message = reaction.message;
    if (message.partial) {
      try { message = await message.fetch(); } catch { return false; }
    }

    // Skip bot messages
    if (message.author?.bot) return false;

    // Self-reaction check
    const authorId = message.author.id;
    const reactorId = user.id;
    if (authorId === reactorId) return false;

    // Check: already reacted with this emoji on this message?
    if (this.db.hasReactionPoint(message.id, reactorId, emoji)) return false;

    // Anti-gaming: max points per message
    const messagePointsSoFar = this.db.getReactionPointsForMessage(message.id);
    if (messagePointsSoFar >= this.maxPointsPerMessage * 5) return false; // generous limit on total reactions per msg

    // Anti-gaming: max points received per day for this author
    const dailyPointsSoFar = this.db.getDailyReactionPointsReceived(authorId);
    if (dailyPointsSoFar >= this.maxPointsReceivedPerDay) return false;

    const points = emojiConfig.points;

    // Record the reaction point
    const recorded = this.db.addReactionPoint(message.id, reactorId, authorId, emoji, points);
    if (!recorded) return false;

    // Ensure member exists
    this.db.upsertMember(authorId, message.author.username, message.member?.displayName);

    // Check if this is their FIRST ever contribution (before adding)
    const isFirstContribution = this.db.getContributionCount(authorId) === 0 && !this.db.isFirstPointsNotified(authorId);

    // Add contribution
    this.db.addContribution({
      memberId: authorId,
      type: 'reaction_points',
      points,
      evidence: {
        emoji,
        label: emojiConfig.label,
        reactor: reactorId,
        message_id: message.id,
        channel_id: message.channel.id,
      },
      channelId: message.channel.id,
      channelName: message.channel.name,
      source: 'reaction',
    });

    // Audit log
    this.audit.log({
      points,
      username: message.author.username,
      type: 'reaction_points',
      extra: `${emoji} from ${user.username}`,
    });

    // Reply in thread (compact, non-intrusive)
    try {
      const thread = message.thread || await message.startThread({
        name: `points for ${message.author.username}`,
        autoArchiveDuration: 60,
      });
      await thread.send(`${emoji} **+${points} pts** to <@${authorId}> — ${emojiConfig.label}!`);
    } catch (err) {
      // If threads fail (permissions, etc.), just log and continue
      console.error('[reaction-points] thread reply failed:', err.message);
    }

    return { authorId, points, isFirstContribution };
  }
}

// ──── 2. Public Level-Up Announcements ────

export class LevelUpAnnouncer {
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  /**
   * Check for unannounced level-ups for a member and post in #general.
   * Call this after any points change.
   */
  async announce(guild, memberId) {
    const levelUps = this.db.getUnannouncedLevelUps(memberId);
    if (!levelUps.length) return;

    // Find #general channel
    const generalChannel = guild.channels.cache.find(c => c.name === 'general' && c.isTextBased());
    if (!generalChannel) {
      console.warn('[level-up] #general channel not found');
      return;
    }

    const member = this.db.getMember(memberId);
    if (!member) return;

    for (const levelUp of levelUps) {
      // Mark as announced first (prevent race conditions)
      const recorded = this.db.recordLevelAnnouncement(memberId, levelUp.new_level);
      if (!recorded) continue;

      // Get top contribution types for embed
      const breakdown = this.db.getPointBreakdown(memberId);
      const topTypes = breakdown.slice(0, 3).map(b => {
        const type = b.type.replace(/_/g, ' ');
        return `**${type}**: ${b.total_points} pts (${b.count}x)`;
      }).join('\n') || '_building their legacy..._';

      const levelConfig = this.config.levels?.find(l => l.level === levelUp.new_level);
      const levelName = levelConfig?.name || levelUp.new_name || 'Unknown';
      const minPoints = levelConfig?.min_points || levelUp.total_points;

      const embed = new EmbedBuilder()
        .setTitle(`🎉 Level Up!`)
        .setDescription(
          `**<@${memberId}>** just reached **Level ${levelUp.new_level}: ${levelName}**!\n` +
          `They've earned **${member.total_points}+ pts** helping the community. Go say congrats!`
        )
        .addFields(
          { name: 'Top Contributions', value: topTypes },
        )
        .setColor(0xF1C40F)
        .setTimestamp();

      try {
        await generalChannel.send({ embeds: [embed] });
        console.log(`[level-up] announced Level ${levelUp.new_level} for ${member.username}`);
      } catch (err) {
        console.error('[level-up] failed to send announcement:', err.message);
      }
    }
  }
}

// ──── 3. First Contribution Ceremony ────

export class FirstContributionCeremony {
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  /**
   * If this is the member's first-ever points, send them a welcome DM.
   * Call after points are awarded. Returns true if DM was sent.
   */
  async maybeSendWelcome(client, memberId) {
    // Already notified?
    if (this.db.isFirstPointsNotified(memberId)) return false;

    // Mark as notified immediately (prevent races)
    this.db.markFirstPointsNotified(memberId);

    const nextLevel = this.config.levels?.find(l => l.level === 2);
    const nextLevelPts = nextLevel?.min_points || 50;
    const nextLevelName = nextLevel?.name || 'Participant';

    try {
      const user = await client.users.fetch(memberId);
      await user.send(
        `hey, you just earned your first points in DaShore! 🎉\n\n` +
        `**Here's how the contribution system works:**\n` +
        `• Help out in channels, share resources, answer questions → earn points\n` +
        `• Get vouched by peers with \`/vouch\` → +5 pts each\n` +
        `• React to great messages with ✅ ⭐ 🔥 💡 → award instant points\n` +
        `• Complete challenges and bounties → bonus points\n` +
        `• Level up as you contribute more!\n\n` +
        `Your next level is **${nextLevelName}** at ${nextLevelPts} pts. Keep helping out! 💪`
      );
      console.log(`[first-contribution] sent welcome DM to ${memberId}`);
      return true;
    } catch (err) {
      // DMs closed or other error — silently skip
      console.log(`[first-contribution] DM failed for ${memberId} (likely closed DMs)`);
      return false;
    }
  }
}

// ──── 4. Public Vouch Wall ────

export class VouchWall {
  constructor(config) {
    this.config = config;
    this.channelName = config.vouch_channel || 'kudos';
  }

  /**
   * Post a vouch to the #kudos channel.
   * Call after a successful vouch.
   */
  async postVouch(guild, voterId, voterUsername, recipientId, recipientUsername, reason, points) {
    const kudosChannel = guild.channels.cache.find(
      c => c.name === this.channelName && c.isTextBased()
    );

    if (!kudosChannel) {
      console.warn(`[vouch-wall] #${this.channelName} channel not found`);
      return false;
    }

    try {
      await kudosChannel.send(
        `✊ **<@${voterId}>** vouched for **<@${recipientId}>**: *"${reason}"* — **+${points} pts**`
      );
      console.log(`[vouch-wall] posted vouch: ${voterUsername} → ${recipientUsername}`);
      return true;
    } catch (err) {
      console.error('[vouch-wall] failed to post:', err.message);
      return false;
    }
  }
}

// ──── 5. Help Wanted Auto-Ping ────

export class HelpWantedPinger {
  constructor(db, config, client) {
    this.db = db;
    this.config = config;
    this.client = client;
    this._timer = null;

    const hwConfig = config.help_wanted || {};
    this.enabled = hwConfig.enabled !== false;
    this.checkIntervalMs = (hwConfig.check_interval_minutes || 30) * 60 * 1000;
    this.minAgeMs = (hwConfig.min_age_minutes || 30) * 60 * 1000;
    this.patterns = hwConfig.question_patterns || [
      '?', 'how do i', 'anyone know', 'help', 'how to', 'can someone', 'does anyone', 'is there a way'
    ];
    this.monitoredChannels = new Set(hwConfig.monitored_channels || ['general', 'dev-chat', 'questions', 'help']);
  }

  /**
   * Start the periodic scan.
   */
  start() {
    if (!this.enabled) {
      console.log('[help-wanted] disabled in config');
      return;
    }

    console.log(`[help-wanted] starting scan every ${this.checkIntervalMs / 60000} minutes`);
    this._timer = setInterval(() => this.scan(), this.checkIntervalMs);
    
    // Run first scan after 2 minutes (give bot time to fully load)
    setTimeout(() => this.scan(), 120_000);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Look for a question pattern in message content.
   */
  isQuestion(content) {
    const lower = content.toLowerCase();
    return this.patterns.some(p => lower.includes(p));
  }

  /**
   * Scan monitored channels for unanswered questions.
   */
  async scan() {
    if (!this.enabled) return;

    const guildId = this.config.guild_id;
    let guild;
    try {
      guild = await this.client.guilds.fetch(guildId);
    } catch (err) {
      console.error('[help-wanted] failed to fetch guild:', err.message);
      return;
    }

    const now = Date.now();

    for (const channelName of this.monitoredChannels) {
      const channel = guild.channels.cache.find(
        c => c.name === channelName && c.isTextBased()
      );
      if (!channel) continue;

      try {
        // Fetch recent messages (last 100)
        const messages = await channel.messages.fetch({ limit: 100 });

        for (const [, msg] of messages) {
          // Skip bots
          if (msg.author.bot) continue;

          // Check age: must be at least min_age_minutes old
          const msgAge = now - msg.createdTimestamp;
          if (msgAge < this.minAgeMs) continue;

          // Don't look at messages older than 2 hours (stale)
          if (msgAge > 2 * 60 * 60 * 1000) continue;

          // Already pinged?
          if (this.db.isHelpWantedPinged(msg.id)) continue;

          // Is it a question?
          if (!this.isQuestion(msg.content)) continue;

          // Check for replies: if the message has any replies, skip
          // We check the thread or look for messages referencing this one
          let hasReply = false;

          // Check if there's a thread
          if (msg.thread) {
            hasReply = true;
          }

          // Check for reference-based replies in the channel
          if (!hasReply) {
            const nearby = await channel.messages.fetch({ after: msg.id, limit: 20 });
            hasReply = nearby.some(m =>
              m.reference?.messageId === msg.id || 
              (m.content.toLowerCase().includes(`<@${msg.author.id}>`) && m.author.id !== msg.author.id)
            );
          }

          if (hasReply) continue;

          // No replies! Ping for help
          this.db.recordHelpWantedPing(msg.id, channel.id, msg.author.id);

          try {
            await channel.send({
              content: `👋 This question from <@${msg.author.id}> is still open! First helpful answer earns **double points** this round.`,
              reply: { messageReference: msg.id, failIfNotExists: false },
            });
            console.log(`[help-wanted] pinged unanswered question in #${channelName} by ${msg.author.username}`);
          } catch (err) {
            console.error(`[help-wanted] failed to send ping in #${channelName}:`, err.message);
          }
        }
      } catch (err) {
        console.error(`[help-wanted] error scanning #${channelName}:`, err.message);
      }
    }
  }
}
