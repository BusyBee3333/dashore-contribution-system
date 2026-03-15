/**
 * Contribution Database — SQLite via better-sqlite3
 * 
 * Separate from discrawl's DB. This stores scored contributions,
 * vouches, seasons, projects, and leaderboard data.
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ContributionDB {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  init() {
    this.db.exec(`
      -- Members with cross-platform identity mapping
      CREATE TABLE IF NOT EXISTS members (
        discord_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        display_name TEXT,
        github_username TEXT,
        entire_username TEXT,
        total_points INTEGER DEFAULT 0,
        season_points INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        level_name TEXT DEFAULT 'Newcomer',
        first_seen_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Seasons for periodic resets
      CREATE TABLE IF NOT EXISTS seasons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT,
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- All scored contributions
      CREATE TABLE IF NOT EXISTS contributions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL REFERENCES members(discord_id),
        type TEXT NOT NULL,
        points INTEGER NOT NULL,
        raw_score REAL,
        multiplier REAL DEFAULT 1.0,
        evidence TEXT,           -- JSON: message links, PR URLs, AI reasoning
        channel_id TEXT,
        channel_name TEXT,
        source TEXT NOT NULL,    -- 'ai_analysis', 'github_webhook', 'peer_vote', 'manual', 'event'
        season_id INTEGER REFERENCES seasons(id),
        message_ids TEXT,        -- JSON array of discrawl message IDs involved
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Peer vouching
      CREATE TABLE IF NOT EXISTS vouches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        voter_id TEXT NOT NULL REFERENCES members(discord_id),
        recipient_id TEXT NOT NULL REFERENCES members(discord_id),
        reason TEXT,
        points INTEGER DEFAULT 5,
        season_id INTEGER REFERENCES seasons(id),
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Community-sponsored projects
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        repo_url TEXT,
        proposed_by TEXT REFERENCES members(discord_id),
        approved_by TEXT,
        status TEXT DEFAULT 'proposed',  -- proposed, active, completed, archived
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Analysis run log (cost tracking + dedup)
      CREATE TABLE IF NOT EXISTS analysis_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT,
        channel_name TEXT,
        time_range_start TEXT NOT NULL,
        time_range_end TEXT NOT NULL,
        model_used TEXT,
        messages_analyzed INTEGER DEFAULT 0,
        conversations_scored INTEGER DEFAULT 0,
        contributions_created INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_estimate REAL DEFAULT 0,
        completed_at TEXT DEFAULT (datetime('now'))
      );

      -- GitHub event dedup table
      CREATE TABLE IF NOT EXISTS github_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,  -- e.g. "pr_merged:openclaw/openclaw:42"
        event_type TEXT NOT NULL,       -- 'pr_merged', 'pr_review', 'bug_report_github'
        repo TEXT NOT NULL,
        github_author TEXT NOT NULL,
        discord_id TEXT,
        points_awarded INTEGER DEFAULT 0,
        dry_run INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Level-up event log
      CREATE TABLE IF NOT EXISTS level_up_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id TEXT NOT NULL,
        old_level INTEGER,
        new_level INTEGER,
        old_name TEXT,
        new_name TEXT,
        total_points INTEGER,
        announced INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Contribution streaks per member
      CREATE TABLE IF NOT EXISTS member_streaks (
        member_id TEXT PRIMARY KEY REFERENCES members(discord_id),
        current_streak INTEGER DEFAULT 0,
        longest_streak INTEGER DEFAULT 0,
        last_active_date TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Voice session tracking
      CREATE TABLE IF NOT EXISTS voice_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        initiator_id TEXT REFERENCES members(discord_id),
        participant_ids TEXT,           -- JSON array of discord IDs
        started_at TEXT DEFAULT (datetime('now')),
        ended_at TEXT,
        peak_participants INTEGER DEFAULT 0,
        host_awarded INTEGER DEFAULT 0  -- 1 if event_hosted points were given
      );

      -- Challenges / Bounties
      CREATE TABLE IF NOT EXISTS challenges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        points INTEGER NOT NULL,
        created_by TEXT,
        assigned_to TEXT,
        status TEXT DEFAULT 'open',   -- open, claimed, completed, cancelled
        proof_required TEXT,
        deadline TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status);

      -- Decay log
      CREATE TABLE IF NOT EXISTS decay_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contribution_id INTEGER REFERENCES contributions(id),
        old_points INTEGER,
        new_points INTEGER,
        decay_rate REAL,
        applied_at TEXT DEFAULT (datetime('now'))
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_contributions_member ON contributions(member_id);
      CREATE INDEX IF NOT EXISTS idx_contributions_type ON contributions(type);
      CREATE INDEX IF NOT EXISTS idx_contributions_season ON contributions(season_id);
      CREATE INDEX IF NOT EXISTS idx_contributions_created ON contributions(created_at);
      CREATE INDEX IF NOT EXISTS idx_vouches_voter ON vouches(voter_id);
      CREATE INDEX IF NOT EXISTS idx_vouches_recipient ON vouches(recipient_id);
      CREATE INDEX IF NOT EXISTS idx_vouches_created ON vouches(created_at);
      CREATE INDEX IF NOT EXISTS idx_analysis_runs_time ON analysis_runs(time_range_start, time_range_end);
      CREATE INDEX IF NOT EXISTS idx_github_events_id ON github_events(event_id);
      CREATE INDEX IF NOT EXISTS idx_github_events_type ON github_events(event_type, repo);
      CREATE INDEX IF NOT EXISTS idx_voice_sessions_channel ON voice_sessions(channel_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_level_up_log_member ON level_up_log(member_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_level_up_log_announced ON level_up_log(announced);

      -- Community projects (voting-based)
      CREATE TABLE IF NOT EXISTS community_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        repo_url TEXT,
        proposed_by TEXT NOT NULL,
        status TEXT DEFAULT 'voting',
        poll_message_id TEXT,
        poll_channel_id TEXT,
        poll_ends_at TEXT,
        votes_yes INTEGER DEFAULT 0,
        votes_no INTEGER DEFAULT 0,
        total_eligible_voters INTEGER DEFAULT 0,
        attempt_number INTEGER DEFAULT 1,
        last_failed_at TEXT,
        approved_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS project_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES community_projects(id),
        voter_id TEXT NOT NULL,
        vote TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(project_id, voter_id)
      );

      CREATE TABLE IF NOT EXISTS project_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES community_projects(id),
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'open',
        claimed_by TEXT,
        created_by TEXT NOT NULL,
        points INTEGER DEFAULT 10,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_community_projects_status ON community_projects(status);
      CREATE INDEX IF NOT EXISTS idx_project_votes_project ON project_votes(project_id);
      CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(project_id, status);
    `);

    return this;
  }

  // ──── Members ────

  upsertMember(discordId, username, displayName = null) {
    const stmt = this.db.prepare(`
      INSERT INTO members (discord_id, username, display_name) 
      VALUES (?, ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET 
        username = excluded.username,
        display_name = COALESCE(excluded.display_name, display_name),
        updated_at = datetime('now')
    `);
    return stmt.run(discordId, username, displayName);
  }

  getMember(discordId) {
    return this.db.prepare(`
      SELECT 
        m.*,
        COALESCE(ms.current_streak, 0) AS current_streak,
        COALESCE(ms.longest_streak, 0) AS longest_streak,
        ms.last_active_date
      FROM members m
      LEFT JOIN member_streaks ms ON ms.member_id = m.discord_id
      WHERE m.discord_id = ?
    `).get(discordId);
  }

  linkGitHub(discordId, githubUsername) {
    return this.db.prepare(
      "UPDATE members SET github_username = ?, updated_at = datetime('now') WHERE discord_id = ?"
    ).run(githubUsername, discordId);
  }

  getMemberByGithub(githubUsername) {
    return this.db.prepare(
      'SELECT * FROM members WHERE LOWER(github_username) = LOWER(?)'
    ).get(githubUsername);
  }

  addPendingClaim(discordId, githubUsername) {
    // Uses contributions table with type 'pending_github_claim' — admin can review
    this.db.prepare(`
      INSERT OR IGNORE INTO contributions (member_id, type, points, source, evidence, created_at)
      VALUES (?, 'pending_github_claim', 0, 'self_claim', ?, datetime('now'))
    `).run(discordId, JSON.stringify({ github_username: githubUsername, status: 'pending' }));
  }

  getPendingClaims() {
    return this.db.prepare(`
      SELECT c.member_id, c.evidence, c.created_at, m.username, m.display_name, m.github_username
      FROM contributions c
      JOIN members m ON c.member_id = m.discord_id
      WHERE c.type = 'pending_github_claim'
      ORDER BY c.created_at DESC
    `).all();
  }

  // ──── Contributions ────

  addContribution({ memberId, type, points, rawScore, multiplier, evidence, channelId, channelName, source, messageIds, seasonId }) {
    const stmt = this.db.prepare(`
      INSERT INTO contributions (member_id, type, points, raw_score, multiplier, evidence, channel_id, channel_name, source, message_ids, season_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      memberId, type, points, rawScore || null, multiplier || 1.0,
      evidence ? JSON.stringify(evidence) : null,
      channelId || null, channelName || null, source,
      messageIds ? JSON.stringify(messageIds) : null,
      seasonId || this.getActiveSeason()?.id || null
    );

    // Update member totals + check for level-up
    this.recalcMemberPoints(memberId);

    // Update streak (best-effort, never throws)
    try { this.updateStreak(memberId); } catch {}

    return result;
  }

  getContributions(memberId, { limit = 20, type = null, seasonId = null } = {}) {
    let sql = 'SELECT * FROM contributions WHERE member_id = ?';
    const params = [memberId];
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (seasonId) { sql += ' AND season_id = ?'; params.push(seasonId); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  // ──── Points Recalculation ────

  recalcMemberPoints(discordId) {
    const total = this.db.prepare(
      'SELECT COALESCE(SUM(points), 0) as total FROM contributions WHERE member_id = ?'
    ).get(discordId).total;

    const season = this.getActiveSeason();
    let seasonPoints = 0;
    if (season) {
      seasonPoints = this.db.prepare(
        'SELECT COALESCE(SUM(points), 0) as total FROM contributions WHERE member_id = ? AND season_id = ?'
      ).get(discordId, season.id).total;
    }

    // Snapshot current level BEFORE update (for level-up detection)
    const existing = this.db.prepare(
      'SELECT level, level_name FROM members WHERE discord_id = ?'
    ).get(discordId);
    const oldLevel = existing?.level || 1;
    const oldName  = existing?.level_name || 'Newcomer';

    // Determine new level
    const levels = [
      { level: 7, name: 'Architect', min: 5000 },
      { level: 6, name: 'Legend', min: 2500 },
      { level: 5, name: 'Champion', min: 1000 },
      { level: 4, name: 'Regular', min: 500 },
      { level: 3, name: 'Contributor', min: 200 },
      { level: 2, name: 'Participant', min: 50 },
      { level: 1, name: 'Newcomer', min: 0 },
    ];
    const memberLevel = levels.find(l => total >= l.min) || levels[levels.length - 1];

    this.db.prepare(`
      UPDATE members SET 
        total_points = ?, season_points = ?, 
        level = ?, level_name = ?,
        updated_at = datetime('now')
      WHERE discord_id = ?
    `).run(total, seasonPoints, memberLevel.level, memberLevel.name, discordId);

    // Log level-up if level increased
    if (memberLevel.level > oldLevel) {
      this.db.prepare(`
        INSERT INTO level_up_log (member_id, old_level, new_level, old_name, new_name, total_points)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(discordId, oldLevel, memberLevel.level, oldName, memberLevel.name, total);
    }

    return { total, seasonPoints, level: memberLevel };
  }

  /**
   * Standalone level-up check — reads current DB level, recalculates from
   * total_points, and records any jump to level_up_log.
   * Returns { leveled_up, old_level, new_level, old_name, new_name } always.
   */
  checkLevelUp(discordId) {
    const member = this.db.prepare(
      'SELECT level, level_name, total_points FROM members WHERE discord_id = ?'
    ).get(discordId);

    if (!member) return { leveled_up: false };

    const levels = [
      { level: 7, name: 'Architect', min: 5000 },
      { level: 6, name: 'Legend', min: 2500 },
      { level: 5, name: 'Champion', min: 1000 },
      { level: 4, name: 'Regular', min: 500 },
      { level: 3, name: 'Contributor', min: 200 },
      { level: 2, name: 'Participant', min: 50 },
      { level: 1, name: 'Newcomer', min: 0 },
    ];

    const newLevel = levels.find(l => member.total_points >= l.min) || levels[levels.length - 1];
    const old_level = member.level;
    const old_name  = member.level_name;

    if (newLevel.level > old_level) {
      // Update member record
      this.db.prepare(`
        UPDATE members SET level = ?, level_name = ?, updated_at = datetime('now')
        WHERE discord_id = ?
      `).run(newLevel.level, newLevel.name, discordId);

      // Log the level-up
      this.db.prepare(`
        INSERT INTO level_up_log (member_id, old_level, new_level, old_name, new_name, total_points)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(discordId, old_level, newLevel.level, old_name, newLevel.name, member.total_points);

      return {
        leveled_up: true,
        old_level,
        new_level: newLevel.level,
        old_name,
        new_name: newLevel.name,
      };
    }

    return { leveled_up: false, old_level, new_level: newLevel.level, old_name, new_name: newLevel.name };
  }

  // ──── Leaderboard ────

  getLeaderboard({ limit = 15, season = false } = {}) {
    const orderCol = season ? 'season_points' : 'total_points';
    return this.db.prepare(`
      SELECT 
        m.discord_id, m.username, m.display_name,
        m.total_points, m.season_points, m.level, m.level_name,
        COALESCE(ms.current_streak, 0) AS current_streak,
        COALESCE(ms.longest_streak, 0) AS longest_streak,
        ms.last_active_date
      FROM members m
      LEFT JOIN member_streaks ms ON ms.member_id = m.discord_id
      WHERE m.${orderCol} > 0
      ORDER BY m.${orderCol} DESC 
      LIMIT ?
    `).all(limit);
  }

  getPointBreakdown(discordId) {
    return this.db.prepare(`
      SELECT type, COUNT(*) as count, SUM(points) as total_points
      FROM contributions
      WHERE member_id = ?
      GROUP BY type
      ORDER BY total_points DESC
    `).all(discordId);
  }

  // ──── Vouching ────

  canVouch(voterId, recipientId) {
    // Can't vouch yourself
    if (voterId === recipientId) return { allowed: false, reason: "can't vouch yourself, stinky" };

    // Daily vouch cap (3 per day)
    const todayCount = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM vouches 
      WHERE voter_id = ? AND created_at >= date('now')
    `).get(voterId).cnt;
    if (todayCount >= 3) return { allowed: false, reason: "you've used all 3 vouches today, try again tomorrow" };

    // Weekly cap for same person (1 per week)
    const weekCount = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM vouches 
      WHERE voter_id = ? AND recipient_id = ? AND created_at >= date('now', '-7 days')
    `).get(voterId, recipientId).cnt;
    if (weekCount >= 1) return { allowed: false, reason: "you already vouched for this person this week" };

    return { allowed: true };
  }

  addVouch(voterId, recipientId, reason, points = 5) {
    const seasonId = this.getActiveSeason()?.id || null;
    this.db.prepare(`
      INSERT INTO vouches (voter_id, recipient_id, reason, points, season_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(voterId, recipientId, reason, points, seasonId);

    // Also add as a contribution
    this.addContribution({
      memberId: recipientId,
      type: 'peer_vouch',
      points,
      evidence: { vouched_by: voterId, reason },
      source: 'peer_vote',
      seasonId,
    });
  }

  // ──── Seasons ────

  getActiveSeason() {
    return this.db.prepare('SELECT * FROM seasons WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
  }

  startSeason(name) {
    // Deactivate current season
    this.db.prepare("UPDATE seasons SET active = 0, end_date = datetime('now') WHERE active = 1").run();
    // Create new
    this.db.prepare("INSERT INTO seasons (name, start_date) VALUES (?, datetime('now'))").run(name);
    // Reset season points
    this.db.prepare('UPDATE members SET season_points = 0').run();
    return this.getActiveSeason();
  }

  // ──── Projects ────

  proposeProject(name, description, repoUrl, proposedBy) {
    return this.db.prepare(`
      INSERT INTO projects (name, description, repo_url, proposed_by)
      VALUES (?, ?, ?, ?)
    `).run(name, description, repoUrl, proposedBy);
  }

  approveProject(projectId, approvedBy) {
    this.db.prepare(`
      UPDATE projects SET status = 'active', approved_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(approvedBy, projectId);

    // Grant points to proposer
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (project) {
      this.addContribution({
        memberId: project.proposed_by,
        type: 'project_proposed',
        points: 30,
        evidence: { project_name: project.name, approved_by: approvedBy },
        source: 'manual',
      });
    }
  }

  getProjects(status = null) {
    if (status) {
      return this.db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY created_at DESC').all(status);
    }
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  }

  // ──── Analysis Tracking ────

  getLastAnalysisEnd(channelId) {
    const row = this.db.prepare(
      'SELECT time_range_end FROM analysis_runs WHERE channel_id = ? ORDER BY time_range_end DESC LIMIT 1'
    ).get(channelId);
    return row?.time_range_end || null;
  }

  /**
   * Check if a conversation time range was already analyzed for a channel.
   * Uses overlap detection — if any recorded run covers this conversation's
   * start AND end timestamps, we've already scored it.
   */
  hasAnalyzedConversation(channelId, convoStart, convoEnd) {
    const row = this.db.prepare(`
      SELECT 1 FROM analysis_runs
      WHERE channel_id = ?
        AND time_range_start <= ?
        AND time_range_end >= ?
      LIMIT 1
    `).get(channelId, convoStart, convoEnd);
    return !!row;
  }

  recordAnalysisRun({ channelId, channelName, timeRangeStart, timeRangeEnd, model, messagesAnalyzed, conversationsScored, contributionsCreated, inputTokens, outputTokens, costEstimate }) {
    return this.db.prepare(`
      INSERT INTO analysis_runs (channel_id, channel_name, time_range_start, time_range_end, model_used, messages_analyzed, conversations_scored, contributions_created, input_tokens, output_tokens, cost_estimate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(channelId, channelName, timeRangeStart, timeRangeEnd, model, messagesAnalyzed, conversationsScored, contributionsCreated, inputTokens, outputTokens, costEstimate);
  }

  // ──── Stats ────

  getStats() {
    const members = this.db.prepare('SELECT COUNT(*) as cnt FROM members WHERE total_points > 0').get().cnt;
    const contributions = this.db.prepare('SELECT COUNT(*) as cnt FROM contributions').get().cnt;
    const totalPoints = this.db.prepare('SELECT COALESCE(SUM(points), 0) as total FROM contributions').get().total;
    const vouches = this.db.prepare('SELECT COUNT(*) as cnt FROM vouches').get().cnt;
    const runs = this.db.prepare('SELECT COUNT(*) as cnt FROM analysis_runs').get().cnt;
    const season = this.getActiveSeason();
    return { members, contributions, totalPoints, vouches, analysisRuns: runs, activeSeason: season };
  }

  // ──── GitHub Events (dedup) ────

  /**
   * Check if a GitHub event was already processed.
   * event_id format: "type:repo:id" — e.g. "pr_merged:openclaw/openclaw:42"
   */
  hasGithubEvent(eventId) {
    return !!this.db.prepare('SELECT 1 FROM github_events WHERE event_id = ?').get(eventId);
  }

  recordGithubEvent({ eventId, eventType, repo, githubAuthor, discordId, pointsAwarded, dryRun = false }) {
    return this.db.prepare(`
      INSERT OR IGNORE INTO github_events (event_id, event_type, repo, github_author, discord_id, points_awarded, dry_run)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, eventType, repo, githubAuthor, discordId || null, pointsAwarded, dryRun ? 1 : 0);
  }

  getGithubStats() {
    return this.db.prepare(`
      SELECT event_type, COUNT(*) as count, SUM(points_awarded) as total_points
      FROM github_events WHERE dry_run = 0
      GROUP BY event_type
    `).all();
  }

  // ──── GitHub User Map ────

  /**
   * Build a reverse map: github_username (lowercase) -> discord_id
   * Merges DB-linked users (via /linkgithub) with manual config overrides.
   */
  buildGithubUserMap(configUserMap = {}) {
    const map = {};

    // DB-linked users (from /linkgithub)
    const members = this.db.prepare(
      'SELECT discord_id, github_username FROM members WHERE github_username IS NOT NULL'
    ).all();
    for (const m of members) {
      map[m.github_username.toLowerCase()] = m.discord_id;
    }

    // Config overrides: { "discord_id": "github_username" }
    for (const [discordId, githubUsername] of Object.entries(configUserMap)) {
      map[githubUsername.toLowerCase()] = discordId;
    }

    return map;
  }

  // ──── Voice Sessions ────

  startVoiceSession(channelId, channelName, initiatorId) {
    return this.db.prepare(`
      INSERT INTO voice_sessions (channel_id, channel_name, initiator_id, participant_ids, peak_participants)
      VALUES (?, ?, ?, json_array(?), 1)
    `).run(channelId, channelName, initiatorId, initiatorId);
  }

  getActiveVoiceSession(channelId) {
    return this.db.prepare(
      'SELECT * FROM voice_sessions WHERE channel_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1'
    ).get(channelId);
  }

  updateVoiceSession(sessionId, participantIds, peakParticipants) {
    return this.db.prepare(`
      UPDATE voice_sessions 
      SET participant_ids = ?, peak_participants = ?
      WHERE id = ?
    `).run(JSON.stringify(participantIds), peakParticipants, sessionId);
  }

  endVoiceSession(sessionId) {
    return this.db.prepare(`
      UPDATE voice_sessions SET ended_at = datetime('now') WHERE id = ?
    `).run(sessionId);
  }

  markVoiceSessionHostAwarded(sessionId) {
    return this.db.prepare(
      'UPDATE voice_sessions SET host_awarded = 1 WHERE id = ?'
    ).run(sessionId);
  }

  // ──── Challenges / Bounties ────

  createChallenge({ title, description, points, createdBy, proofRequired = null, deadline = null }) {
    return this.db.prepare(`
      INSERT INTO challenges (title, description, points, created_by, proof_required, deadline)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(title, description || null, points, createdBy || null, proofRequired, deadline || null);
  }

  listChallenges(status = null) {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM challenges WHERE status = ? ORDER BY created_at DESC'
      ).all(status);
    }
    return this.db.prepare('SELECT * FROM challenges ORDER BY created_at DESC').all();
  }

  getChallenge(id) {
    return this.db.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
  }

  /**
   * Claim a challenge (mark as claimed, assign to memberId).
   * Only works when status = 'open'.
   */
  claimChallenge(id, memberId) {
    const challenge = this.getChallenge(id);
    if (!challenge) return { ok: false, reason: 'Challenge not found' };
    if (challenge.status !== 'open') return { ok: false, reason: `Challenge is already ${challenge.status}` };

    this.db.prepare(`
      UPDATE challenges SET status = 'claimed', assigned_to = ? WHERE id = ?
    `).run(memberId, id);
    return { ok: true };
  }

  /**
   * Complete a challenge — mark done, award points to assigned_to.
   * adminId is who approved it.
   */
  completeChallenge(id, adminId) {
    const challenge = this.getChallenge(id);
    if (!challenge) return { ok: false, reason: 'Challenge not found' };
    if (challenge.status === 'completed') return { ok: false, reason: 'Already completed' };
    if (challenge.status === 'cancelled') return { ok: false, reason: 'Challenge is cancelled' };
    if (!challenge.assigned_to) return { ok: false, reason: 'No one has claimed this challenge' };

    this.db.prepare(`
      UPDATE challenges SET status = 'completed', completed_at = datetime('now') WHERE id = ?
    `).run(id);

    // Award points
    this.addContribution({
      memberId: challenge.assigned_to,
      type: 'challenge_completed',
      points: challenge.points,
      evidence: { challenge_id: id, title: challenge.title, approved_by: adminId },
      source: 'manual',
    });

    return { ok: true, awardedTo: challenge.assigned_to, points: challenge.points };
  }

  // ──── Streak Tracking ────

  /**
   * Update the daily activity streak for a member.
   * Called automatically from addContribution.
   * Awards bonus points at streak milestones (3, 7, 14, 30-day).
   */
  updateStreak(discordId) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const streak = this.db.prepare(
      'SELECT * FROM member_streaks WHERE member_id = ?'
    ).get(discordId);

    if (!streak) {
      // First-ever contribution — create streak record
      this.db.prepare(`
        INSERT INTO member_streaks (member_id, current_streak, longest_streak, last_active_date)
        VALUES (?, 1, 1, ?)
      `).run(discordId, today);
      return;
    }

    const last = streak.last_active_date;

    if (last === today) {
      // Already active today — nothing to do
      return;
    }

    // Calculate yesterday
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    let newStreak;
    if (last === yesterday) {
      // Consecutive day — extend streak
      newStreak = streak.current_streak + 1;
    } else {
      // Gap in activity — reset to 1
      newStreak = 1;
    }

    const newLongest = Math.max(newStreak, streak.longest_streak);

    this.db.prepare(`
      UPDATE member_streaks
      SET current_streak = ?, longest_streak = ?, last_active_date = ?, updated_at = datetime('now')
      WHERE member_id = ?
    `).run(newStreak, newLongest, today, discordId);

    // Award streak milestone bonus points (only at exact milestone, not every day)
    const MILESTONES = [
      { days: 30, pts: 30 },
      { days: 14, pts: 15 },
      { days: 7,  pts: 7  },
      { days: 3,  pts: 3  },
    ];

    for (const m of MILESTONES) {
      if (newStreak === m.days) {
        this.db.prepare(`
          INSERT INTO contributions (member_id, type, points, source, evidence)
          VALUES (?, 'streak_bonus', ?, 'streak', json_object('streak_days', ?))
        `).run(discordId, m.pts, m.days);

        // Recalc points after awarding bonus (don't recurse via addContribution)
        this.recalcMemberPoints(discordId);
        break; // Only one milestone per day
      }
    }
  }

  /**
   * Get a member's streak info.
   */
  getMemberStreak(discordId) {
    return this.db.prepare(
      'SELECT * FROM member_streaks WHERE member_id = ?'
    ).get(discordId) || { current_streak: 0, longest_streak: 0, last_active_date: null };
  }

  // ──── Anti-gaming check ────

  getDailyConversationPoints(memberId) {
    return this.db.prepare(`
      SELECT COALESCE(SUM(points), 0) as total FROM contributions
      WHERE member_id = ? 
        AND type IN ('helpful_conversation', 'teaching_moment', 'tool_share', 'reaction_bonus')
        AND created_at >= date('now')
    `).get(memberId).total;
  }

  /**
   * Returns the daily conversation point cap for a member based on their level.
   * - Level 1-2: 50 pts/day
   * - Level 3-4: 75 pts/day
   * - Level 5-6: 100 pts/day
   * - Level 7: 150 pts/day
   */
  getDailyCapForMember(discordId) {
    const member = this.getMember(discordId);
    const level = member?.level || 1;
    if (level >= 7) return 150;
    if (level >= 5) return 100;
    if (level >= 3) return 75;
    return 50; // levels 1-2
  }

  close() {
    this.db.close();
  }
}
