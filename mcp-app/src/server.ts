#!/usr/bin/env node
/**
 * Contribution System MCP App Server
 * DaShore Incubator — contribution leaderboard, profiles, stats, GitHub activity
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool, registerAppResource } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── DB setup ─────────────────────────────────────────────────────────────────

const DB_PATH = resolve(__dirname, '../../data/contributions.db');

function openDb() {
  if (!existsSync(DB_PATH)) {
    throw new Error(`Database not found at ${DB_PATH}`);
  }
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

// ── Level config ─────────────────────────────────────────────────────────────

const LEVEL_THRESHOLDS = [
  { level: 7, name: 'Architect', min: 5000, emoji: '(GOD)' },
  { level: 6, name: 'Legend',    min: 2500, emoji: '(!!!)' },
  { level: 5, name: 'Champion',  min: 1000, emoji: '(*_* )' },
  { level: 4, name: 'Regular',   min: 500,  emoji: '( ^_^)' },
  { level: 3, name: 'Contributor', min: 200, emoji: '(o_o )' },
  { level: 2, name: 'Participant', min: 50,  emoji: '( ._.)' },
  { level: 1, name: 'Newcomer',  min: 0,    emoji: '(._. )' },
];

function getLevel(points: number) {
  return LEVEL_THRESHOLDS.find(l => points >= l.min) ?? LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1];
}

function getNextLevel(currentLevel: number) {
  const idx = LEVEL_THRESHOLDS.findIndex(l => l.level === currentLevel);
  // Next level is the one before current in the array (higher threshold)
  if (idx > 0) return LEVEL_THRESHOLDS[idx - 1];
  return null;
}

// ── UI Resource path ──────────────────────────────────────────────────────────

const UI_RESOURCE_URI = 'ui://contribution-system/dashboard.html';

function loadUiHtml(): string {
  // Built UI is at dist/ui/index.html (vite singlefile output)
  const builtPath = resolve(__dirname, '../../dist/ui/index.html');
  if (existsSync(builtPath)) {
    return readFileSync(builtPath, 'utf-8');
  }
  // Fallback minimal HTML if UI not built yet
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Contribution Dashboard</title>
<style>body{font-family:sans-serif;padding:20px;background:#1a1a2e;color:#e2e8f0}</style>
</head>
<body><h1>📊 Contribution Dashboard</h1><p>UI not built yet. Run <code>npm run build:ui</code></p></body>
</html>`;
}

// ── Server setup ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'contribution-system',
  version: '1.0.0',
});

// ── Tool: contribution_leaderboard ────────────────────────────────────────────

registerAppTool(
  server,
  'contribution_leaderboard',
  {
    title: 'Contribution Leaderboard',
    description: 'View the DaShore Incubator contribution leaderboard with rankings, levels, and points.',
    inputSchema: {
      type: z.enum(['alltime', 'season']).optional().default('alltime').describe('Leaderboard type: alltime or season'),
      limit: z.number().min(1).max(50).optional().default(15).describe('Number of entries to show (max 50)'),
    },
    _meta: { ui: { resourceUri: UI_RESOURCE_URI } },
  },
  async ({ type = 'alltime', limit = 15 }) => {
    const db = openDb();
    try {
      const orderCol = type === 'season' ? 'season_points' : 'total_points';
      const rows = db.prepare(`
        SELECT discord_id, username, display_name, total_points, season_points, level, level_name
        FROM members
        WHERE ${orderCol} > 0
        ORDER BY ${orderCol} DESC
        LIMIT ?
      `).all(limit) as Array<{
        discord_id: string; username: string; display_name: string | null;
        total_points: number; season_points: number; level: number; level_name: string;
      }>;

      const activeSeason = db.prepare('SELECT name FROM seasons WHERE active = 1 ORDER BY id DESC LIMIT 1').get() as { name: string } | undefined;

      const entries = rows.map((r, i) => ({
        rank: i + 1,
        discord_id: r.discord_id,
        username: r.display_name || r.username,
        total_points: r.total_points,
        season_points: r.season_points,
        level: r.level,
        level_name: r.level_name,
        level_emoji: getLevel(r.total_points).emoji,
      }));

      const structuredContent = {
        view: 'leaderboard',
        type,
        limit,
        active_season: activeSeason?.name ?? null,
        entries,
        level_thresholds: LEVEL_THRESHOLDS,
      };

      const textFallback = [
        `# ${type === 'season' ? 'Season' : 'All-Time'} Leaderboard${activeSeason ? ` — ${activeSeason.name}` : ''}`,
        '',
        entries.map(e =>
          `${e.rank}. ${e.username} — ${type === 'season' ? e.season_points : e.total_points} pts | ${e.level_emoji} ${e.level_name}`
        ).join('\n'),
      ].join('\n');

      return {
        content: [{ type: 'text' as const, text: textFallback }],
        structuredContent,
      };
    } finally {
      db.close();
    }
  }
);

// ── Tool: contribution_profile ────────────────────────────────────────────────

registerAppTool(
  server,
  'contribution_profile',
  {
    title: 'Member Profile',
    description: 'View a member\'s contribution profile: points, level, breakdown by type, and recent activity.',
    inputSchema: {
      username: z.string().describe('Discord username (or display name) to look up'),
    },
    _meta: { ui: { resourceUri: UI_RESOURCE_URI } },
  },
  async ({ username }) => {
    const db = openDb();
    try {
      // Search by username or display_name (case-insensitive)
      const member = db.prepare(`
        SELECT * FROM members
        WHERE LOWER(username) = LOWER(?) OR LOWER(display_name) = LOWER(?)
        LIMIT 1
      `).get(username, username) as {
        discord_id: string; username: string; display_name: string | null;
        github_username: string | null; total_points: number; season_points: number;
        level: number; level_name: string; first_seen_at: string;
      } | undefined;

      if (!member) {
        const structuredContent = { view: 'profile', error: `No member found with username "${username}"` };
        return {
          content: [{ type: 'text' as const, text: `Member "${username}" not found.` }],
          structuredContent,
        };
      }

      // Contribution breakdown by type
      const breakdown = db.prepare(`
        SELECT type, COUNT(*) as count, SUM(points) as total_points
        FROM contributions
        WHERE member_id = ?
        GROUP BY type
        ORDER BY total_points DESC
      `).all(member.discord_id) as Array<{ type: string; count: number; total_points: number }>;

      // Recent contributions (last 10)
      const recent = db.prepare(`
        SELECT type, points, source, channel_name, created_at, evidence
        FROM contributions
        WHERE member_id = ?
        ORDER BY created_at DESC
        LIMIT 10
      `).all(member.discord_id) as Array<{
        type: string; points: number; source: string;
        channel_name: string | null; created_at: string; evidence: string | null;
      }>;

      // Level progress
      const currentLevelInfo = getLevel(member.total_points);
      const nextLevelInfo = getNextLevel(currentLevelInfo.level);
      const progressPct = nextLevelInfo
        ? Math.min(100, Math.round(((member.total_points - currentLevelInfo.min) / (nextLevelInfo.min - currentLevelInfo.min)) * 100))
        : 100;

      const structuredContent = {
        view: 'profile',
        member: {
          discord_id: member.discord_id,
          username: member.display_name || member.username,
          raw_username: member.username,
          github_username: member.github_username,
          total_points: member.total_points,
          season_points: member.season_points,
          level: currentLevelInfo.level,
          level_name: currentLevelInfo.name,
          level_emoji: currentLevelInfo.emoji,
          next_level: nextLevelInfo ? {
            level: nextLevelInfo.level,
            name: nextLevelInfo.name,
            min_points: nextLevelInfo.min,
            points_needed: nextLevelInfo.min - member.total_points,
          } : null,
          progress_pct: progressPct,
          first_seen_at: member.first_seen_at,
        },
        breakdown: breakdown.map(b => ({
          type: b.type,
          count: b.count,
          total_points: b.total_points,
        })),
        recent: recent.map(r => ({
          type: r.type,
          points: r.points,
          source: r.source,
          channel: r.channel_name,
          created_at: r.created_at,
        })),
        level_thresholds: LEVEL_THRESHOLDS,
      };

      const textFallback = [
        `# ${member.display_name || member.username}'s Profile`,
        `Level ${currentLevelInfo.level} ${currentLevelInfo.emoji} ${currentLevelInfo.name}`,
        `Total Points: ${member.total_points} | Season Points: ${member.season_points}`,
        member.github_username ? `GitHub: @${member.github_username}` : '',
        '',
        '## Contribution Breakdown',
        breakdown.map(b => `  ${b.type}: ${b.count}x (+${b.total_points} pts)`).join('\n'),
        '',
        '## Recent Activity',
        recent.map(r => `  [${r.created_at.slice(0, 10)}] ${r.type} +${r.points} pts`).join('\n'),
      ].filter(Boolean).join('\n');

      return {
        content: [{ type: 'text' as const, text: textFallback }],
        structuredContent,
      };
    } finally {
      db.close();
    }
  }
);

// ── Tool: contribution_stats ───────────────────────────────────────────────────

registerAppTool(
  server,
  'contribution_stats',
  {
    title: 'Contribution Stats',
    description: 'System-wide statistics for the DaShore Incubator contribution system.',
    inputSchema: {},
    _meta: { ui: { resourceUri: UI_RESOURCE_URI } },
  },
  async () => {
    const db = openDb();
    try {
      const members = (db.prepare('SELECT COUNT(*) as cnt FROM members WHERE total_points > 0').get() as { cnt: number }).cnt;
      const contributions = (db.prepare('SELECT COUNT(*) as cnt FROM contributions').get() as { cnt: number }).cnt;
      const totalPoints = (db.prepare('SELECT COALESCE(SUM(points), 0) as total FROM contributions').get() as { total: number }).total;
      const vouches = (db.prepare('SELECT COUNT(*) as cnt FROM vouches').get() as { cnt: number }).cnt;
      const analysisRuns = (db.prepare('SELECT COUNT(*) as cnt FROM analysis_runs').get() as { cnt: number }).cnt;
      const activeSeason = db.prepare('SELECT * FROM seasons WHERE active = 1 ORDER BY id DESC LIMIT 1').get() as {
        id: number; name: string; start_date: string;
      } | undefined;

      // Contribution type breakdown
      const typeBreakdown = db.prepare(`
        SELECT type, COUNT(*) as count, SUM(points) as total_points
        FROM contributions
        GROUP BY type
        ORDER BY total_points DESC
      `).all() as Array<{ type: string; count: number; total_points: number }>;

      // Top 5 contributors
      const topContributors = db.prepare(`
        SELECT username, display_name, total_points, level, level_name
        FROM members
        WHERE total_points > 0
        ORDER BY total_points DESC
        LIMIT 5
      `).all() as Array<{
        username: string; display_name: string | null;
        total_points: number; level: number; level_name: string;
      }>;

      // Season stats if active
      let seasonStats = null;
      if (activeSeason) {
        const seasonContribs = (db.prepare('SELECT COUNT(*) as cnt, COALESCE(SUM(points), 0) as pts FROM contributions WHERE season_id = ?').get(activeSeason.id) as { cnt: number; pts: number });
        seasonStats = {
          name: activeSeason.name,
          start_date: activeSeason.start_date,
          contributions: seasonContribs.cnt,
          points_awarded: seasonContribs.pts,
        };
      }

      const structuredContent = {
        view: 'stats',
        stats: {
          total_members: members,
          total_contributions: contributions,
          total_points: totalPoints,
          vouches,
          analysis_runs: analysisRuns,
        },
        active_season: seasonStats,
        type_breakdown: typeBreakdown,
        top_contributors: topContributors.map((c, i) => ({
          rank: i + 1,
          username: c.display_name || c.username,
          total_points: c.total_points,
          level: c.level,
          level_name: c.level_name,
          level_emoji: getLevel(c.total_points).emoji,
        })),
        level_thresholds: LEVEL_THRESHOLDS,
      };

      const textFallback = [
        '# DaShore Incubator — Contribution Stats',
        `Members: ${members} | Contributions: ${contributions} | Total Points: ${totalPoints}`,
        activeSeason ? `Active Season: ${activeSeason.name}` : 'No active season',
        `Vouches: ${vouches} | Analysis Runs: ${analysisRuns}`,
        '',
        '## Top Contributors',
        topContributors.map((c, i) =>
          `  ${i + 1}. ${c.display_name || c.username} — ${c.total_points} pts (${c.level_name})`
        ).join('\n'),
      ].join('\n');

      return {
        content: [{ type: 'text' as const, text: textFallback }],
        structuredContent,
      };
    } finally {
      db.close();
    }
  }
);

// ── Tool: github_contributions ────────────────────────────────────────────────

registerAppTool(
  server,
  'github_contributions',
  {
    title: 'GitHub Contributions',
    description: 'View GitHub contribution activity — PRs merged, reviews, issues. Filter by username.',
    inputSchema: {
      username: z.string().optional().describe('Filter to a specific GitHub or Discord username (optional)'),
    },
    _meta: { ui: { resourceUri: UI_RESOURCE_URI } },
  },
  async ({ username }) => {
    const db = openDb();
    try {
      // If username provided, try to find discord_id or match github_author
      let memberFilter: string | null = null;
      let githubFilter: string | null = null;

      if (username) {
        const member = db.prepare(`
          SELECT discord_id, github_username FROM members
          WHERE LOWER(username) = LOWER(?) OR LOWER(display_name) = LOWER(?) OR LOWER(github_username) = LOWER(?)
          LIMIT 1
        `).get(username, username, username) as { discord_id: string; github_username: string | null } | undefined;

        if (member) {
          memberFilter = member.discord_id;
          githubFilter = member.github_username;
        } else {
          // Try direct github_author match
          githubFilter = username;
        }
      }

      // Per-user summary
      let summaryQuery = `
        SELECT 
          github_author,
          discord_id,
          SUM(CASE WHEN event_type = 'pr_merged' THEN 1 ELSE 0 END) as prs_merged,
          SUM(CASE WHEN event_type = 'pr_review' THEN 1 ELSE 0 END) as pr_reviews,
          SUM(CASE WHEN event_type = 'bug_report_github' THEN 1 ELSE 0 END) as bug_reports,
          COUNT(*) as total_events,
          SUM(points_awarded) as total_points
        FROM github_events
        WHERE dry_run = 0
      `;
      const summaryParams: string[] = [];

      if (githubFilter) {
        summaryQuery += ` AND LOWER(github_author) = LOWER(?)`;
        summaryParams.push(githubFilter);
      } else if (memberFilter) {
        summaryQuery += ` AND discord_id = ?`;
        summaryParams.push(memberFilter);
      }

      summaryQuery += ` GROUP BY github_author ORDER BY total_points DESC LIMIT 20`;

      const summary = db.prepare(summaryQuery).all(...summaryParams) as Array<{
        github_author: string; discord_id: string | null;
        prs_merged: number; pr_reviews: number; bug_reports: number;
        total_events: number; total_points: number;
      }>;

      // Recent events
      let eventsQuery = `
        SELECT event_id, event_type, repo, github_author, discord_id, points_awarded, created_at
        FROM github_events
        WHERE dry_run = 0
      `;
      const eventParams: string[] = [];

      if (githubFilter) {
        eventsQuery += ` AND LOWER(github_author) = LOWER(?)`;
        eventParams.push(githubFilter);
      } else if (memberFilter) {
        eventsQuery += ` AND discord_id = ?`;
        eventParams.push(memberFilter);
      }

      eventsQuery += ` ORDER BY created_at DESC LIMIT 25`;

      const recentEvents = db.prepare(eventsQuery).all(...eventParams) as Array<{
        event_id: string; event_type: string; repo: string;
        github_author: string; discord_id: string | null;
        points_awarded: number; created_at: string;
      }>;

      // Overall GitHub stats
      const totalStats = db.prepare(`
        SELECT 
          COUNT(*) as total_events,
          SUM(points_awarded) as total_points,
          COUNT(DISTINCT github_author) as unique_contributors
        FROM github_events WHERE dry_run = 0
      `).get() as { total_events: number; total_points: number; unique_contributors: number };

      const structuredContent = {
        view: 'github',
        filter_username: username ?? null,
        total_stats: totalStats,
        user_summary: summary,
        recent_events: recentEvents,
      };

      const textFallback = [
        `# GitHub Contributions${username ? ` — ${username}` : ''}`,
        `Total Events: ${totalStats.total_events} | Total Points: ${totalStats.total_points} | Contributors: ${totalStats.unique_contributors}`,
        '',
        '## Contributors',
        summary.map(s =>
          `  @${s.github_author}: ${s.prs_merged} PRs, ${s.pr_reviews} reviews, ${s.bug_reports} reports → ${s.total_points} pts`
        ).join('\n'),
        '',
        '## Recent Events',
        recentEvents.slice(0, 10).map(e =>
          `  [${e.created_at.slice(0, 10)}] ${e.event_type} by @${e.github_author} on ${e.repo} (+${e.points_awarded}pts)`
        ).join('\n'),
      ].join('\n');

      return {
        content: [{ type: 'text' as const, text: textFallback }],
        structuredContent,
      };
    } finally {
      db.close();
    }
  }
);

// ── UI Resource ───────────────────────────────────────────────────────────────

registerAppResource(
  server,
  'Contribution Dashboard UI',
  UI_RESOURCE_URI,
  {
    description: 'Interactive React dashboard for the DaShore Incubator contribution system',
  },
  async () => ({
    contents: [
      {
        uri: UI_RESOURCE_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: loadUiHtml(),
      },
    ],
  })
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
