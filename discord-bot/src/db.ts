/**
 * DB helper — readonly access to contributions.db
 * All write operations (vouch, linkGitHub) use a writable connection.
 */

import Database from "better-sqlite3";

const DB_PATH =
  process.env.DB_PATH ||
  "/Users/jakeshore/.clawdbot/workspace/contribution-system/data/contributions.db";

// Open a single shared connection
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Ensure community project tables exist (idempotent)
db.exec(`
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

// ──── Types ────────────────────────────────────────────────────────────────

export interface Member {
  discord_id: string;
  username: string;
  display_name: string | null;
  github_username: string | null;
  total_points: number;
  season_points: number;
  level: number;
  level_name: string;
  first_seen_at: string;
  updated_at: string;
}

export interface Contribution {
  id: number;
  member_id: string;
  type: string;
  points: number;
  raw_score: number | null;
  multiplier: number;
  evidence: string | null;
  channel_id: string | null;
  channel_name: string | null;
  source: string;
  season_id: number | null;
  created_at: string;
}

export interface PointBreakdown {
  type: string;
  count: number;
  total_points: number;
}

export interface Season {
  id: number;
  name: string;
  start_date: string;
  end_date: string | null;
  active: number;
  created_at: string;
}

export interface VouchCheck {
  allowed: boolean;
  reason?: string;
}

export interface Stats {
  members: number;
  contributions: number;
  totalPoints: number;
  vouches: number;
  analysisRuns: number;
  activeSeason: Season | null | undefined;
}

export interface TypeBreakdown {
  type: string;
  count: number;
  total_points: number;
}

// ──── Levels ───────────────────────────────────────────────────────────────

export const LEVELS = [
  { level: 1, name: "Newcomer",    min: 0,    emoji: "(._. )" },
  { level: 2, name: "Participant", min: 50,   emoji: "( ._.)" },
  { level: 3, name: "Contributor", min: 200,  emoji: "(o_o )" },
  { level: 4, name: "Regular",     min: 500,  emoji: "( ^_^)" },
  { level: 5, name: "Champion",    min: 1000, emoji: "(*_* )" },
  { level: 6, name: "Legend",      min: 2500, emoji: "(!!!)" },
  { level: 7, name: "Architect",   min: 5000, emoji: "(GOD)" },
];

export function getLevelInfo(totalPoints: number) {
  // Find current level (highest level whose min <= totalPoints)
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (totalPoints >= LEVELS[i].min) {
      const current = LEVELS[i];
      const next = LEVELS[i + 1] || null;
      return { current, next };
    }
  }
  return { current: LEVELS[0], next: LEVELS[1] };
}

export function buildProgressBar(totalPoints: number, blocks = 10): string {
  const { current, next } = getLevelInfo(totalPoints);
  if (!next) return "🟩".repeat(blocks) + " **MAX LEVEL**";
  const progress = totalPoints - current.min;
  const needed = next.min - current.min;
  const filled = Math.min(blocks, Math.floor((progress / needed) * blocks));
  return "🟩".repeat(filled) + "⬜".repeat(blocks - filled) + ` ${progress}/${needed}`;
}

// ──── Query functions ──────────────────────────────────────────────────────

export function getLeaderboard(season = false, limit = 15): Member[] {
  const col = season ? "season_points" : "total_points";
  return db.prepare(`
    SELECT discord_id, username, display_name, total_points, season_points, level, level_name
    FROM members
    WHERE ${col} > 0
    ORDER BY ${col} DESC
    LIMIT ?
  `).all(limit) as Member[];
}

export function getMember(discordId: string): Member | undefined {
  return db.prepare("SELECT * FROM members WHERE discord_id = ?").get(discordId) as Member | undefined;
}

export function getPointBreakdown(discordId: string): PointBreakdown[] {
  return db.prepare(`
    SELECT type, COUNT(*) as count, SUM(points) as total_points
    FROM contributions
    WHERE member_id = ?
    GROUP BY type
    ORDER BY total_points DESC
  `).all(discordId) as PointBreakdown[];
}

export function getRecentContributions(discordId: string, limit = 5): Contribution[] {
  return db.prepare(`
    SELECT * FROM contributions
    WHERE member_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(discordId, limit) as Contribution[];
}

export function getContributionHistory(
  discordId: string,
  page: number,
  pageSize = 10
): { rows: Contribution[]; total: number } {
  const offset = page * pageSize;
  const rows = db.prepare(`
    SELECT * FROM contributions
    WHERE member_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(discordId, pageSize, offset) as Contribution[];

  const total = (db.prepare(
    "SELECT COUNT(*) as cnt FROM contributions WHERE member_id = ?"
  ).get(discordId) as any).cnt as number;

  return { rows, total };
}

export function getStats(): Stats {
  const members = (db.prepare("SELECT COUNT(*) as cnt FROM members WHERE total_points > 0").get() as any).cnt;
  const contributions = (db.prepare("SELECT COUNT(*) as cnt FROM contributions").get() as any).cnt;
  const totalPoints = (db.prepare("SELECT COALESCE(SUM(points), 0) as total FROM contributions").get() as any).total;
  const vouches = (db.prepare("SELECT COUNT(*) as cnt FROM vouches").get() as any).cnt;
  const analysisRuns = (db.prepare("SELECT COUNT(*) as cnt FROM analysis_runs").get() as any).cnt;
  const activeSeason = getActiveSeason();
  return { members, contributions, totalPoints, vouches, analysisRuns, activeSeason };
}

export function getContributionTypeBreakdown(): TypeBreakdown[] {
  return db.prepare(`
    SELECT type, COUNT(*) as count, SUM(points) as total_points
    FROM contributions
    GROUP BY type
    ORDER BY total_points DESC
  `).all() as TypeBreakdown[];
}

export function canVouch(voterId: string, recipientId: string): VouchCheck {
  if (voterId === recipientId) {
    return { allowed: false, reason: "can't vouch yourself, stinky 🙃" };
  }

  const todayCount = (db.prepare(`
    SELECT COUNT(*) as cnt FROM vouches
    WHERE voter_id = ? AND created_at >= date('now')
  `).get(voterId) as any).cnt;
  if (todayCount >= 3) {
    return { allowed: false, reason: "you've used all 3 vouches today — try again tomorrow ⏳" };
  }

  const weekCount = (db.prepare(`
    SELECT COUNT(*) as cnt FROM vouches
    WHERE voter_id = ? AND recipient_id = ? AND created_at >= date('now', '-7 days')
  `).get(voterId, recipientId) as any).cnt;
  if (weekCount >= 1) {
    return { allowed: false, reason: "you already vouched for this person this week 🔁" };
  }

  return { allowed: true };
}

export function addVouch(
  voterId: string,
  recipientId: string,
  reason: string,
  points = 5
): void {
  const season = getActiveSeason();
  const seasonId = season?.id ?? null;

  db.prepare(`
    INSERT INTO vouches (voter_id, recipient_id, reason, points, season_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(voterId, recipientId, reason, points, seasonId);

  db.prepare(`
    INSERT INTO contributions (member_id, type, points, evidence, source, season_id)
    VALUES (?, 'peer_vouch', ?, ?, 'peer_vote', ?)
  `).run(
    recipientId,
    points,
    JSON.stringify({ vouched_by: voterId, reason }),
    seasonId
  );

  // Recalc member points
  recalcMemberPoints(recipientId);
}

export function linkGitHub(discordId: string, username: string): boolean {
  const result = db.prepare(
    "UPDATE members SET github_username = ?, updated_at = datetime('now') WHERE discord_id = ?"
  ).run(username, discordId);
  return result.changes > 0;
}

export function getActiveSeason(): Season | undefined {
  return db.prepare(
    "SELECT * FROM seasons WHERE active = 1 ORDER BY id DESC LIMIT 1"
  ).get() as Season | undefined;
}

export function upsertMember(
  discordId: string,
  username: string,
  displayName?: string | null
): void {
  db.prepare(`
    INSERT INTO members (discord_id, username, display_name)
    VALUES (?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      username = excluded.username,
      display_name = COALESCE(excluded.display_name, display_name),
      updated_at = datetime('now')
  `).run(discordId, username, displayName ?? null);
}

// ──── Internal helpers ─────────────────────────────────────────────────────

function recalcMemberPoints(discordId: string): void {
  const total = (db.prepare(
    "SELECT COALESCE(SUM(points), 0) as total FROM contributions WHERE member_id = ?"
  ).get(discordId) as any).total;

  const season = getActiveSeason();
  let seasonPoints = 0;
  if (season) {
    seasonPoints = (db.prepare(
      "SELECT COALESCE(SUM(points), 0) as total FROM contributions WHERE member_id = ? AND season_id = ?"
    ).get(discordId, season.id) as any).total;
  }

  const levels = [...LEVELS].reverse();
  const memberLevel = levels.find((l) => total >= l.min) ?? LEVELS[0];

  db.prepare(`
    UPDATE members SET
      total_points = ?, season_points = ?,
      level = ?, level_name = ?,
      updated_at = datetime('now')
    WHERE discord_id = ?
  `).run(total, seasonPoints, memberLevel.level, memberLevel.name, discordId);
}

// ──── Community Projects ───────────────────────────────────────────────────

export interface CommunityProject {
  id: number;
  title: string;
  description: string | null;
  repo_url: string | null;
  proposed_by: string;
  status: string;
  poll_message_id: string | null;
  poll_channel_id: string | null;
  poll_ends_at: string | null;
  votes_yes: number;
  votes_no: number;
  total_eligible_voters: number;
  attempt_number: number;
  last_failed_at: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectTask {
  id: number;
  project_id: number;
  title: string;
  description: string | null;
  status: string;
  claimed_by: string | null;
  created_by: string;
  points: number;
  created_at: string;
  updated_at: string;
}

export interface VoteResult {
  success: boolean;
  alreadyVoted: boolean;
}

export interface FinalizeResult {
  status: "active" | "rejected" | "cooldown";
  passed: boolean;
  yesVotes: number;
  noVotes: number;
  totalVotes: number;
  totalEligible: number;
  yesPct: number;
  participationPct: number;
}

export interface ProposeCheck {
  allowed: boolean;
  retryAfter?: string;
}

export function proposeProject(opts: {
  title: string;
  description: string | null;
  repoUrl: string | null;
  proposedBy: string;
  totalEligibleVoters: number;
  pollEndsAt: string;
  attempt: number;
}): CommunityProject {
  const result = db.prepare(`
    INSERT INTO community_projects
      (title, description, repo_url, proposed_by, status, total_eligible_voters, poll_ends_at, attempt_number)
    VALUES (?, ?, ?, ?, 'voting', ?, ?, ?)
  `).run(
    opts.title,
    opts.description,
    opts.repoUrl,
    opts.proposedBy,
    opts.totalEligibleVoters,
    opts.pollEndsAt,
    opts.attempt,
  );
  return db.prepare("SELECT * FROM community_projects WHERE id = ?").get(result.lastInsertRowid) as CommunityProject;
}

export function getProject(id: number): CommunityProject | undefined {
  return db.prepare("SELECT * FROM community_projects WHERE id = ?").get(id) as CommunityProject | undefined;
}

export function listProjects(status?: string): CommunityProject[] {
  if (status) {
    return db.prepare("SELECT * FROM community_projects WHERE status = ? ORDER BY created_at DESC").all(status) as CommunityProject[];
  }
  return db.prepare(
    "SELECT * FROM community_projects WHERE status IN ('active','voting') ORDER BY created_at DESC"
  ).all() as CommunityProject[];
}

export function updateProjectPollMessage(projectId: number, messageId: string, channelId: string): void {
  db.prepare(`
    UPDATE community_projects SET poll_message_id = ?, poll_channel_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(messageId, channelId, projectId);
}

export function castVote(projectId: number, voterId: string, vote: "yes" | "no"): VoteResult {
  try {
    db.prepare(`
      INSERT INTO project_votes (project_id, voter_id, vote) VALUES (?, ?, ?)
    `).run(projectId, voterId, vote);

    // Update tally on the project row
    if (vote === "yes") {
      db.prepare("UPDATE community_projects SET votes_yes = votes_yes + 1, updated_at = datetime('now') WHERE id = ?").run(projectId);
    } else {
      db.prepare("UPDATE community_projects SET votes_no = votes_no + 1, updated_at = datetime('now') WHERE id = ?").run(projectId);
    }
    return { success: true, alreadyVoted: false };
  } catch (e: any) {
    if (e?.code === "SQLITE_CONSTRAINT_UNIQUE" || (e?.message ?? "").includes("UNIQUE")) {
      return { success: false, alreadyVoted: true };
    }
    throw e;
  }
}

export function getVotes(projectId: number): { yes: number; no: number; total: number } {
  const row = db.prepare("SELECT votes_yes, votes_no FROM community_projects WHERE id = ?").get(projectId) as any;
  if (!row) return { yes: 0, no: 0, total: 0 };
  return { yes: row.votes_yes, no: row.votes_no, total: row.votes_yes + row.votes_no };
}

export function finalizeProject(projectId: number): FinalizeResult {
  const project = db.prepare("SELECT * FROM community_projects WHERE id = ?").get(projectId) as CommunityProject;
  if (!project) throw new Error(`Project ${projectId} not found`);

  const yesVotes = project.votes_yes;
  const noVotes = project.votes_no;
  const totalVotes = yesVotes + noVotes;
  const totalEligible = project.total_eligible_voters || 1;
  const yesPct = totalVotes > 0 ? yesVotes / totalVotes : 0;
  const participationPct = totalVotes / totalEligible;

  const passed = yesPct >= 0.6 && participationPct >= 0.5;

  let status: "active" | "rejected" | "cooldown";
  if (passed) {
    status = "active";
    db.prepare(`
      UPDATE community_projects SET status = 'active', approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `).run(projectId);

    // Award proposer 30 pts
    const season = getActiveSeason();
    const seasonId = season?.id ?? null;
    db.prepare(`
      INSERT OR IGNORE INTO members (discord_id, username, display_name) VALUES (?, ?, ?)
    `).run(project.proposed_by, project.proposed_by, null);
    db.prepare(`
      INSERT INTO contributions (member_id, type, points, evidence, source, season_id)
      VALUES (?, 'project_approved', 30, ?, 'manual', ?)
    `).run(project.proposed_by, JSON.stringify({ project_id: projectId, title: project.title }), seasonId);
    recalcMemberPoints(project.proposed_by);
  } else if (project.attempt_number >= 2) {
    status = "cooldown";
    db.prepare(`
      UPDATE community_projects SET status = 'cooldown', last_failed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `).run(projectId);
  } else {
    status = "rejected";
    db.prepare(`
      UPDATE community_projects SET status = 'rejected', updated_at = datetime('now') WHERE id = ?
    `).run(projectId);
  }

  return { status, passed, yesVotes, noVotes, totalVotes, totalEligible, yesPct, participationPct };
}

export function canPropose(memberId: string): ProposeCheck {
  // Check if they have a cooldown from a failed attempt_number=2 in the last 7 days
  const row = db.prepare(`
    SELECT last_failed_at FROM community_projects
    WHERE proposed_by = ? AND status = 'cooldown'
    ORDER BY last_failed_at DESC LIMIT 1
  `).get(memberId) as any;

  if (!row || !row.last_failed_at) return { allowed: true };

  const failedAt = new Date(row.last_failed_at + "Z");
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const retryAt = new Date(failedAt.getTime() + sevenDays);

  if (Date.now() < retryAt.getTime()) {
    return { allowed: false, retryAfter: retryAt.toISOString() };
  }
  return { allowed: true };
}

export function countEligibleVoters(): number {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM members WHERE total_points >= 0").get() as any;
  return row?.cnt ?? 0;
}

export function addProjectTask(opts: {
  projectId: number;
  title: string;
  description: string | null;
  points: number;
  createdBy: string;
}): ProjectTask {
  const result = db.prepare(`
    INSERT INTO project_tasks (project_id, title, description, points, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(opts.projectId, opts.title, opts.description, opts.points, opts.createdBy);
  return db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(result.lastInsertRowid) as ProjectTask;
}

export function listProjectTasks(projectId: number, status?: string): ProjectTask[] {
  if (status) {
    return db.prepare("SELECT * FROM project_tasks WHERE project_id = ? AND status = ? ORDER BY created_at DESC")
      .all(projectId, status) as ProjectTask[];
  }
  return db.prepare("SELECT * FROM project_tasks WHERE project_id = ? ORDER BY created_at DESC")
    .all(projectId) as ProjectTask[];
}

export function claimTask(taskId: number, memberId: string): { ok: boolean; reason?: string } {
  const task = db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(taskId) as ProjectTask | undefined;
  if (!task) return { ok: false, reason: "Task not found" };
  if (task.status !== "open") return { ok: false, reason: `Task is already ${task.status}` };

  db.prepare(`
    UPDATE project_tasks SET claimed_by = ?, status = 'claimed', updated_at = datetime('now') WHERE id = ?
  `).run(memberId, taskId);
  return { ok: true };
}

export function getProjectTaskCounts(projectId: number): { open: number; claimed: number; done: number } {
  const rows = db.prepare(`
    SELECT status, COUNT(*) as cnt FROM project_tasks WHERE project_id = ? GROUP BY status
  `).all(projectId) as any[];
  const map: Record<string, number> = {};
  for (const r of rows) map[r.status] = r.cnt;
  return { open: map.open ?? 0, claimed: map.claimed ?? 0, done: map.done ?? 0 };
}
