/**
 * DaShore Contribution Leaderboard — Web Server
 * 
 * Standalone Express app serving a public leaderboard, member profiles,
 * and activity feed. Read-only connection to the contributions SQLite DB.
 */

import express from 'express';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3851;
const DB_PATH = resolve(__dirname, '..', 'data', 'contributions.db');

// ─── Database ───────────────────────────────────────────────────────────────

let db = null;

function getDb() {
  if (db) return db;
  if (!existsSync(DB_PATH)) return null;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    db.pragma('journal_mode = WAL');
    return db;
  } catch (err) {
    console.error('Failed to open database:', err.message);
    return null;
  }
}

// ─── Level Colors ───────────────────────────────────────────────────────────

const LEVEL_COLORS = {
  'Newcomer': '#6b7280',
  'Participant': '#22c55e',
  'Contributor': '#3b82f6',
  'Regular': '#a855f7',
  'Champion': '#eab308',
  'Legend': '#f97316',
  'Architect': '#ef4444',
};

const LEVEL_THRESHOLDS = [
  { level: 7, name: 'Architect', min: 5000 },
  { level: 6, name: 'Legend', min: 2500 },
  { level: 5, name: 'Champion', min: 1000 },
  { level: 4, name: 'Regular', min: 500 },
  { level: 3, name: 'Contributor', min: 200 },
  { level: 2, name: 'Participant', min: 50 },
  { level: 1, name: 'Newcomer', min: 0 },
];

function getNextLevel(currentLevel) {
  const idx = LEVEL_THRESHOLDS.findIndex(l => l.level === currentLevel);
  if (idx <= 0) return null; // Already max or not found
  return LEVEL_THRESHOLDS[idx - 1];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatType(type) {
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr + 'Z').getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, len = 80) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

// ─── Shared CSS ─────────────────────────────────────────────────────────────

const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  a { color: #e94560; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Header */
  .header {
    background: #16213e;
    border-bottom: 2px solid #0f3460;
    padding: 1rem 2rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .header .brand {
    font-size: 1.4rem;
    font-weight: 700;
    color: #e94560;
    letter-spacing: -0.02em;
  }
  .header .brand span { color: #e0e0e0; font-weight: 400; }
  .header nav { display: flex; gap: 1.25rem; }
  .header nav a {
    color: #a0a0b8;
    font-weight: 500;
    font-size: 0.95rem;
    transition: color 0.15s;
  }
  .header nav a:hover, .header nav a.active { color: #e94560; text-decoration: none; }

  /* Main */
  .main { flex: 1; max-width: 960px; width: 100%; margin: 0 auto; padding: 1.5rem 1rem; }

  /* Footer */
  .footer {
    text-align: center;
    padding: 1.25rem;
    color: #555;
    font-size: 0.8rem;
    border-top: 1px solid #16213e;
  }

  /* Card */
  .card {
    background: #16213e;
    border-radius: 10px;
    padding: 1.25rem;
    margin-bottom: 1rem;
    border: 1px solid #0f3460;
  }

  /* Toggle */
  .toggle-row {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
  }
  .toggle-btn {
    padding: 0.45rem 1rem;
    border-radius: 6px;
    border: 1px solid #0f3460;
    background: transparent;
    color: #a0a0b8;
    cursor: pointer;
    font-size: 0.9rem;
    transition: all 0.15s;
  }
  .toggle-btn.active, .toggle-btn:hover {
    background: #e94560;
    color: #fff;
    border-color: #e94560;
  }

  /* Table */
  .lb-table { width: 100%; border-collapse: collapse; }
  .lb-table th {
    text-align: left;
    padding: 0.6rem 0.75rem;
    color: #888;
    font-weight: 600;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid #0f3460;
  }
  .lb-table td {
    padding: 0.65rem 0.75rem;
    border-bottom: 1px solid rgba(15, 52, 96, 0.4);
    vertical-align: middle;
  }
  .lb-table tr:hover td { background: rgba(15, 52, 96, 0.3); }
  .rank { font-weight: 700; color: #888; width: 3rem; text-align: center; }
  .rank-1 { color: #eab308; font-size: 1.1em; }
  .rank-2 { color: #c0c0c0; }
  .rank-3 { color: #cd7f32; }
  .level-badge {
    display: inline-block;
    padding: 0.15rem 0.55rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    color: #fff;
  }
  .points { font-weight: 700; font-variant-numeric: tabular-nums; }
  .type-tag {
    font-size: 0.78rem;
    color: #a0a0b8;
    background: rgba(15, 52, 96, 0.5);
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
  }
  .member-name { font-weight: 600; }

  /* Profile */
  .profile-header {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    flex-wrap: wrap;
  }
  .profile-header .avatar-circle {
    width: 64px; height: 64px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 1.6rem; font-weight: 700; color: #fff;
  }
  .profile-header .info h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  .profile-header .info .meta { color: #888; font-size: 0.9rem; }

  .stats-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0.75rem;
    margin: 1.25rem 0;
  }
  .stat-card {
    background: rgba(15, 52, 96, 0.4);
    border-radius: 8px;
    padding: 0.9rem;
    text-align: center;
  }
  .stat-card .value { font-size: 1.5rem; font-weight: 700; color: #e94560; }
  .stat-card .label { font-size: 0.78rem; color: #888; margin-top: 0.2rem; }

  /* Progress bar */
  .progress-wrap { margin: 1rem 0; }
  .progress-label { font-size: 0.85rem; color: #a0a0b8; margin-bottom: 0.4rem; }
  .progress-bar {
    height: 12px;
    background: rgba(15, 52, 96, 0.6);
    border-radius: 6px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #e94560, #f97316);
    border-radius: 6px;
    transition: width 0.4s;
  }

  /* Bar chart (CSS-only) */
  .bar-chart { margin: 1rem 0; }
  .bar-row {
    display: flex;
    align-items: center;
    margin-bottom: 0.5rem;
    gap: 0.75rem;
  }
  .bar-label { min-width: 140px; font-size: 0.85rem; color: #a0a0b8; text-align: right; }
  .bar-track { flex: 1; height: 20px; background: rgba(15, 52, 96, 0.4); border-radius: 4px; overflow: hidden; }
  .bar-fill {
    height: 100%;
    border-radius: 4px;
    display: flex;
    align-items: center;
    padding-left: 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: #fff;
    min-width: fit-content;
  }

  /* Activity */
  .activity-item {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid rgba(15, 52, 96, 0.3);
  }
  .activity-item:last-child { border-bottom: none; }
  .activity-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    margin-top: 0.45rem;
    flex-shrink: 0;
  }
  .activity-body { flex: 1; }
  .activity-body .who { font-weight: 600; }
  .activity-body .what { color: #a0a0b8; font-size: 0.88rem; margin-top: 0.15rem; }
  .activity-body .when { color: #555; font-size: 0.78rem; margin-top: 0.2rem; }
  .activity-points {
    font-weight: 700;
    color: #e94560;
    white-space: nowrap;
    font-size: 0.95rem;
    margin-top: 0.1rem;
  }

  /* Vouch list */
  .vouch-item { padding: 0.5rem 0; border-bottom: 1px solid rgba(15, 52, 96, 0.3); }
  .vouch-item:last-child { border-bottom: none; }
  .vouch-from { font-weight: 600; }
  .vouch-reason { color: #a0a0b8; font-size: 0.88rem; }
  .vouch-date { color: #555; font-size: 0.78rem; }

  /* Empty state */
  .empty {
    text-align: center;
    padding: 3rem 1rem;
    color: #555;
    font-size: 1.1rem;
  }

  /* Responsive */
  @media (max-width: 640px) {
    .header { padding: 0.75rem 1rem; }
    .header .brand { font-size: 1.1rem; }
    .lb-table th, .lb-table td { padding: 0.5rem 0.4rem; font-size: 0.85rem; }
    .bar-label { min-width: 100px; font-size: 0.78rem; }
    .hide-mobile { display: none; }
    .profile-header .avatar-circle { width: 48px; height: 48px; font-size: 1.2rem; }
  }
`;

// ─── Layout ─────────────────────────────────────────────────────────────────

function layout(title, body, activePage = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — DaShore Incubator</title>
  ${activePage === 'activity' ? '<meta http-equiv="refresh" content="60">' : ''}
  <style>${CSS}</style>
</head>
<body>
  <div class="header">
    <div class="brand">DaShore <span>Incubator</span></div>
    <nav>
      <a href="/" class="${activePage === 'leaderboard' ? 'active' : ''}">Leaderboard</a>
      <a href="/activity" class="${activePage === 'activity' ? 'active' : ''}">Activity</a>
    </nav>
  </div>
  <div class="main">${body}</div>
  <div class="footer">Powered by DaShore Contribution System</div>
</body>
</html>`;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const app = express();

// --- Leaderboard ---
app.get('/', (req, res) => {
  const database = getDb();
  const season = req.query.season === '1';

  if (!database) {
    return res.send(layout('Leaderboard', '<div class="empty">No database found. Contributions will appear here once the system is running.</div>', 'leaderboard'));
  }

  let activeSeason = null;
  try {
    activeSeason = database.prepare('SELECT * FROM seasons WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
  } catch {}

  const orderCol = season && activeSeason ? 'season_points' : 'total_points';
  let rows = [];
  try {
    rows = database.prepare(`
      SELECT 
        m.discord_id, m.username, m.display_name,
        m.total_points, m.season_points, m.level, m.level_name
      FROM members m
      WHERE m.${orderCol} > 0
      ORDER BY m.${orderCol} DESC
      LIMIT 50
    `).all();
  } catch {}

  // Get top contribution type per member
  const topTypes = {};
  for (const row of rows) {
    try {
      const top = database.prepare(`
        SELECT type, SUM(points) as tp FROM contributions
        WHERE member_id = ? GROUP BY type ORDER BY tp DESC LIMIT 1
      `).get(row.discord_id);
      if (top) topTypes[row.discord_id] = top.type;
    } catch {}
  }

  let tableRows = '';
  rows.forEach((row, i) => {
    const rank = i + 1;
    const rankClass = rank <= 3 ? ` rank-${rank}` : '';
    const displayName = escapeHtml(row.display_name || row.username);
    const color = LEVEL_COLORS[row.level_name] || '#6b7280';
    const pts = season && activeSeason ? row.season_points : row.total_points;
    const topType = topTypes[row.discord_id];

    tableRows += `
      <tr>
        <td class="rank${rankClass}">${rank}</td>
        <td><a href="/profile/${escapeHtml(row.discord_id)}" class="member-name">${displayName}</a></td>
        <td><span class="level-badge" style="background:${color}">${escapeHtml(row.level_name)}</span></td>
        <td class="points">${pts.toLocaleString()}</td>
        <td class="hide-mobile">${topType ? `<span class="type-tag">${escapeHtml(formatType(topType))}</span>` : ''}</td>
      </tr>`;
  });

  const body = `
    <div class="toggle-row">
      <a href="/?season=0" class="toggle-btn ${!season ? 'active' : ''}">All Time</a>
      ${activeSeason ? `<a href="/?season=1" class="toggle-btn ${season ? 'active' : ''}">Season: ${escapeHtml(activeSeason.name)}</a>` : ''}
    </div>
    ${rows.length === 0 ? '<div class="empty">No contributions yet. Be the first!</div>' : `
    <div class="card" style="padding:0; overflow-x:auto;">
      <table class="lb-table">
        <thead><tr>
          <th style="text-align:center">#</th>
          <th>Member</th>
          <th>Level</th>
          <th>Points</th>
          <th class="hide-mobile">Top Type</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`}`;

  res.send(layout('Leaderboard', body, 'leaderboard'));
});

// --- Member Profile ---
app.get('/profile/:memberId', (req, res) => {
  const database = getDb();
  if (!database) {
    return res.send(layout('Profile', '<div class="empty">Database not available.</div>'));
  }

  const memberId = req.params.memberId;
  let member;
  try {
    member = database.prepare(`
      SELECT m.*, COALESCE(ms.current_streak, 0) AS current_streak,
             COALESCE(ms.longest_streak, 0) AS longest_streak
      FROM members m
      LEFT JOIN member_streaks ms ON ms.member_id = m.discord_id
      WHERE m.discord_id = ?
    `).get(memberId);
  } catch {}

  if (!member) {
    return res.send(layout('Profile', '<div class="empty">Member not found.</div>'));
  }

  const displayName = member.display_name || member.username;
  const color = LEVEL_COLORS[member.level_name] || '#6b7280';
  const initial = (displayName[0] || '?').toUpperCase();

  // Progress to next level
  const nextLevel = getNextLevel(member.level);
  const currentThreshold = LEVEL_THRESHOLDS.find(l => l.level === member.level);
  let progressPct = 100;
  let progressLabel = 'Max level reached!';
  if (nextLevel && currentThreshold) {
    const range = nextLevel.min - currentThreshold.min;
    const progress = member.total_points - currentThreshold.min;
    progressPct = Math.min(100, Math.max(0, Math.round((progress / range) * 100)));
    progressLabel = `${member.total_points.toLocaleString()} / ${nextLevel.min.toLocaleString()} pts to ${nextLevel.name}`;
  }

  // Points breakdown
  let breakdown = [];
  try {
    breakdown = database.prepare(`
      SELECT type, COUNT(*) as count, SUM(points) as total_points
      FROM contributions WHERE member_id = ?
      GROUP BY type ORDER BY total_points DESC
    `).all(memberId);
  } catch {}

  const maxBreakdown = breakdown.length > 0 ? breakdown[0].total_points : 1;
  const barColors = ['#e94560', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#06b6d4'];

  let breakdownHtml = '';
  breakdown.forEach((b, i) => {
    const pct = Math.max(2, Math.round((b.total_points / maxBreakdown) * 100));
    const barColor = barColors[i % barColors.length];
    breakdownHtml += `
      <div class="bar-row">
        <div class="bar-label">${escapeHtml(formatType(b.type))}</div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${pct}%; background:${barColor};">${b.total_points} pts</div>
        </div>
      </div>`;
  });

  // Recent contributions
  let contributions = [];
  try {
    contributions = database.prepare(`
      SELECT * FROM contributions WHERE member_id = ?
      ORDER BY created_at DESC LIMIT 20
    `).all(memberId);
  } catch {}

  let contribHtml = '';
  if (contributions.length === 0) {
    contribHtml = '<div class="empty" style="padding:1rem">No contributions yet.</div>';
  } else {
    contributions.forEach(c => {
      let evidenceSummary = '';
      if (c.evidence) {
        try {
          const ev = JSON.parse(c.evidence);
          if (ev.summary) evidenceSummary = truncate(ev.summary);
          else if (ev.reason) evidenceSummary = truncate(ev.reason);
          else if (ev.pr_title) evidenceSummary = truncate(ev.pr_title);
          else if (ev.channel_name) evidenceSummary = `#${ev.channel_name}`;
        } catch {}
      }
      contribHtml += `
        <div class="activity-item">
          <div class="activity-dot" style="background:${LEVEL_COLORS[member.level_name] || '#6b7280'}"></div>
          <div class="activity-body">
            <div>${escapeHtml(formatType(c.type))}</div>
            ${evidenceSummary ? `<div class="what">${escapeHtml(evidenceSummary)}</div>` : ''}
            <div class="when">${timeAgo(c.created_at)}${c.channel_name ? ` · #${escapeHtml(c.channel_name)}` : ''}</div>
          </div>
          <div class="activity-points">+${c.points}</div>
        </div>`;
    });
  }

  // Vouches received
  let vouches = [];
  try {
    vouches = database.prepare(`
      SELECT v.*, m.username AS voter_username, m.display_name AS voter_display_name
      FROM vouches v
      JOIN members m ON v.voter_id = m.discord_id
      WHERE v.recipient_id = ?
      ORDER BY v.created_at DESC LIMIT 20
    `).all(memberId);
  } catch {}

  let vouchHtml = '';
  if (vouches.length === 0) {
    vouchHtml = '<div style="color:#555; padding:0.5rem 0;">No vouches received yet.</div>';
  } else {
    vouches.forEach(v => {
      const voterName = v.voter_display_name || v.voter_username;
      vouchHtml += `
        <div class="vouch-item">
          <span class="vouch-from">${escapeHtml(voterName)}</span>
          ${v.reason ? `<span class="vouch-reason"> — ${escapeHtml(truncate(v.reason, 120))}</span>` : ''}
          <div class="vouch-date">${timeAgo(v.created_at)} · +${v.points} pts</div>
        </div>`;
    });
  }

  const body = `
    <div class="card">
      <div class="profile-header">
        <div class="avatar-circle" style="background:${color}">${initial}</div>
        <div class="info">
          <h1>${escapeHtml(displayName)}</h1>
          <div class="meta">
            <span class="level-badge" style="background:${color}">${escapeHtml(member.level_name)}</span>
            ${member.github_username ? ` · <a href="https://github.com/${escapeHtml(member.github_username)}" target="_blank">@${escapeHtml(member.github_username)}</a>` : ''}
          </div>
        </div>
      </div>

      <div class="stats-row">
        <div class="stat-card">
          <div class="value">${member.total_points.toLocaleString()}</div>
          <div class="label">Total Points</div>
        </div>
        <div class="stat-card">
          <div class="value">${member.season_points.toLocaleString()}</div>
          <div class="label">Season Points</div>
        </div>
        <div class="stat-card">
          <div class="value">${member.current_streak}</div>
          <div class="label">Day Streak</div>
        </div>
        <div class="stat-card">
          <div class="value">${breakdown.length}</div>
          <div class="label">Contribution Types</div>
        </div>
      </div>

      <div class="progress-wrap">
        <div class="progress-label">${progressLabel}</div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${progressPct}%"></div>
        </div>
      </div>
    </div>

    ${breakdown.length > 0 ? `
    <div class="card">
      <h3 style="margin-bottom:0.75rem; font-size:1rem; color:#a0a0b8;">Points Breakdown</h3>
      <div class="bar-chart">${breakdownHtml}</div>
    </div>` : ''}

    <div class="card">
      <h3 style="margin-bottom:0.75rem; font-size:1rem; color:#a0a0b8;">Recent Contributions</h3>
      ${contribHtml}
    </div>

    <div class="card">
      <h3 style="margin-bottom:0.75rem; font-size:1rem; color:#a0a0b8;">Vouches Received (${vouches.length})</h3>
      ${vouchHtml}
    </div>
  `;

  res.send(layout(`${displayName} — Profile`, body));
});

// --- Activity Feed ---
app.get('/activity', (req, res) => {
  const database = getDb();
  if (!database) {
    return res.send(layout('Activity', '<div class="empty">Database not available.</div>', 'activity'));
  }

  let items = [];
  try {
    items = database.prepare(`
      SELECT c.*, m.username, m.display_name, m.level_name
      FROM contributions c
      JOIN members m ON c.member_id = m.discord_id
      ORDER BY c.created_at DESC
      LIMIT 50
    `).all();
  } catch {}

  let itemsHtml = '';
  if (items.length === 0) {
    itemsHtml = '<div class="empty">No activity yet.</div>';
  } else {
    items.forEach(item => {
      const name = item.display_name || item.username;
      const color = LEVEL_COLORS[item.level_name] || '#6b7280';

      let evidenceSummary = '';
      if (item.evidence) {
        try {
          const ev = JSON.parse(item.evidence);
          if (ev.summary) evidenceSummary = truncate(ev.summary);
          else if (ev.reason) evidenceSummary = truncate(ev.reason);
          else if (ev.pr_title) evidenceSummary = truncate(ev.pr_title);
          else if (ev.title) evidenceSummary = truncate(ev.title);
          else if (ev.channel_name) evidenceSummary = `#${ev.channel_name}`;
        } catch {}
      }

      itemsHtml += `
        <div class="activity-item">
          <div class="activity-dot" style="background:${color}"></div>
          <div class="activity-body">
            <span class="who"><a href="/profile/${escapeHtml(item.member_id)}">${escapeHtml(name)}</a></span>
            <span style="color:#888">earned</span>
            <span class="type-tag">${escapeHtml(formatType(item.type))}</span>
            ${evidenceSummary ? `<div class="what">${escapeHtml(evidenceSummary)}</div>` : ''}
            <div class="when">${timeAgo(item.created_at)}${item.channel_name ? ` · #${escapeHtml(item.channel_name)}` : ''}</div>
          </div>
          <div class="activity-points">+${item.points}</div>
        </div>`;
    });
  }

  const body = `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
        <h3 style="font-size:1rem; color:#a0a0b8;">Recent Activity</h3>
        <span style="font-size:0.75rem; color:#555;">Auto-refreshes every 60s</span>
      </div>
      ${itemsHtml}
    </div>`;

  res.send(layout('Activity Feed', body, 'activity'));
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🏆 DaShore Leaderboard running at http://localhost:${PORT}`);
  if (getDb()) {
    console.log(`📊 Database connected: ${DB_PATH}`);
  } else {
    console.log(`⚠️  Database not found at ${DB_PATH} — will show empty state`);
  }
});
