import React, { useState, useCallback } from 'react';
import { useApp, useHostStyleVariables, type App as McpApp } from '@modelcontextprotocol/ext-apps/react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LevelThreshold {
  level: number;
  name: string;
  min: number;
  emoji: string;
}

interface LeaderboardEntry {
  rank: number;
  discord_id: string;
  username: string;
  total_points: number;
  season_points: number;
  level: number;
  level_name: string;
  level_emoji: string;
}

interface LeaderboardData {
  view: 'leaderboard';
  type: 'alltime' | 'season';
  limit: number;
  active_season: string | null;
  entries: LeaderboardEntry[];
  level_thresholds: LevelThreshold[];
}

interface ProfileMember {
  discord_id: string;
  username: string;
  raw_username: string;
  github_username: string | null;
  total_points: number;
  season_points: number;
  level: number;
  level_name: string;
  level_emoji: string;
  next_level: { level: number; name: string; min_points: number; points_needed: number } | null;
  progress_pct: number;
  first_seen_at: string;
}

interface ProfileData {
  view: 'profile';
  error?: string;
  member?: ProfileMember;
  breakdown?: Array<{ type: string; count: number; total_points: number }>;
  recent?: Array<{ type: string; points: number; source: string; channel: string | null; created_at: string }>;
  level_thresholds: LevelThreshold[];
}

interface StatsData {
  view: 'stats';
  stats: {
    total_members: number;
    total_contributions: number;
    total_points: number;
    vouches: number;
    analysis_runs: number;
  };
  active_season: { name: string; start_date: string; contributions: number; points_awarded: number } | null;
  type_breakdown: Array<{ type: string; count: number; total_points: number }>;
  top_contributors: Array<{
    rank: number;
    username: string;
    total_points: number;
    level: number;
    level_name: string;
    level_emoji: string;
  }>;
  level_thresholds: LevelThreshold[];
}

interface GithubData {
  view: 'github';
  filter_username: string | null;
  total_stats: { total_events: number; total_points: number; unique_contributors: number };
  user_summary: Array<{
    github_author: string;
    discord_id: string | null;
    prs_merged: number;
    pr_reviews: number;
    bug_reports: number;
    total_events: number;
    total_points: number;
  }>;
  recent_events: Array<{
    event_id: string;
    event_type: string;
    repo: string;
    github_author: string;
    discord_id: string | null;
    points_awarded: number;
    created_at: string;
  }>;
}

type ViewData = LeaderboardData | ProfileData | StatsData | GithubData;

// ── Level colors ──────────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<number, string> = {
  7: '#f59e0b', // gold — Architect
  6: '#a855f7', // purple — Legend
  5: '#3b82f6', // blue — Champion
  4: '#22c55e', // green — Regular
  3: '#06b6d4', // teal — Contributor
  2: '#94a3b8', // slate — Participant
  1: '#6b7280', // gray — Newcomer
};

const RANK_MEDALS: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

// ── Shared components ─────────────────────────────────────────────────────────

function LevelBadge({ level, name, emoji }: { level: number; name: string; emoji: string }) {
  const color = LEVEL_COLORS[level] ?? '#6b7280';
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '2px 8px',
      borderRadius: '4px',
      border: `1px solid ${color}40`,
      background: `${color}18`,
      color,
      fontFamily: 'var(--font-mono, monospace)',
      fontSize: '0.75rem',
      fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>
      <span style={{ fontFamily: 'monospace' }}>{emoji}</span>
      <span>{name}</span>
    </span>
  );
}

function ProgressBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{
      width: '100%',
      height: '6px',
      borderRadius: '3px',
      background: 'var(--color-background-tertiary, rgba(255,255,255,0.1))',
      overflow: 'hidden',
    }}>
      <div style={{
        height: '100%',
        width: `${Math.min(100, pct)}%`,
        background: color,
        borderRadius: '3px',
        transition: 'width 0.4s ease',
      }} />
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div style={{
      background: 'var(--color-background-secondary, rgba(255,255,255,0.05))',
      border: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
      borderRadius: '8px',
      padding: '16px',
      flex: '1 1 140px',
    }}>
      <div style={{
        fontSize: '0.7rem',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: 'var(--color-text-secondary, #94a3b8)',
        marginBottom: '6px',
      }}>{label}</div>
      <div style={{
        fontSize: '1.6rem',
        fontWeight: 700,
        fontFamily: 'var(--font-mono, monospace)',
        color: 'var(--color-text-primary, #f1f5f9)',
      }}>{value}</div>
      {sub && <div style={{ fontSize: '0.7rem', color: 'var(--color-text-tertiary, #64748b)', marginTop: '2px' }}>{sub}</div>}
    </div>
  );
}

// ── View: Leaderboard ─────────────────────────────────────────────────────────

function LeaderboardView({ data }: { data: LeaderboardData }) {
  const { entries, type, active_season } = data;
  const maxPts = entries.length > 0
    ? (type === 'season' ? entries[0].season_points : entries[0].total_points)
    : 1;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--color-text-primary, #f1f5f9)' }}>
            {type === 'season' ? '🏆 Season Leaderboard' : '🏆 All-Time Leaderboard'}
          </h2>
          {active_season && (
            <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary, #94a3b8)' }}>
              Active season: {active_season}
            </div>
          )}
        </div>
        <div style={{
          fontSize: '0.7rem', fontWeight: 600, padding: '3px 10px',
          borderRadius: '20px',
          background: type === 'season' ? '#a855f720' : '#f59e0b20',
          color: type === 'season' ? '#a855f7' : '#f59e0b',
          border: `1px solid ${type === 'season' ? '#a855f740' : '#f59e0b40'}`,
        }}>
          {type === 'season' ? 'SEASON' : 'ALL-TIME'}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {entries.map((entry) => {
          const pts = type === 'season' ? entry.season_points : entry.total_points;
          const barPct = maxPts > 0 ? (pts / maxPts) * 100 : 0;
          const color = LEVEL_COLORS[entry.level] ?? '#6b7280';
          const medal = RANK_MEDALS[entry.rank];

          return (
            <div key={entry.discord_id} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '10px 12px',
              borderRadius: '8px',
              background: 'var(--color-background-secondary, rgba(255,255,255,0.04))',
              border: `1px solid ${entry.rank <= 3 ? color + '40' : 'var(--color-border-primary, rgba(255,255,255,0.06))'}`,
              transition: 'background 0.15s',
            }}>
              {/* Rank */}
              <div style={{
                minWidth: '30px',
                textAlign: 'center',
                fontFamily: 'var(--font-mono, monospace)',
                fontWeight: 700,
                fontSize: '0.85rem',
                color: medal ? color : 'var(--color-text-tertiary, #64748b)',
              }}>
                {medal ?? `#${entry.rank}`}
              </div>

              {/* Name + level */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                  <span style={{
                    fontWeight: 600,
                    fontSize: '0.9rem',
                    color: 'var(--color-text-primary, #f1f5f9)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>{entry.username}</span>
                  <LevelBadge level={entry.level} name={entry.level_name} emoji={entry.level_emoji} />
                </div>
                <ProgressBar pct={barPct} color={color} />
              </div>

              {/* Points */}
              <div style={{ textAlign: 'right', minWidth: '80px' }}>
                <div style={{
                  fontFamily: 'var(--font-mono, monospace)',
                  fontWeight: 700,
                  fontSize: '0.95rem',
                  color,
                }}>{pts.toLocaleString()}</div>
                {type !== 'season' && entry.season_points > 0 && (
                  <div style={{ fontSize: '0.65rem', color: 'var(--color-text-tertiary, #64748b)' }}>
                    {entry.season_points.toLocaleString()} this season
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {entries.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--color-text-tertiary, #64748b)' }}>
          No contributions yet. Be the first! 🚀
        </div>
      )}
    </div>
  );
}

// ── View: Profile ─────────────────────────────────────────────────────────────

function formatType(t: string) {
  return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function ProfileView({ data }: { data: ProfileData }) {
  if (data.error) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--color-text-danger, #ef4444)' }}>
        ⚠️ {data.error}
      </div>
    );
  }
  if (!data.member) return null;

  const { member, breakdown = [], recent = [] } = data;
  const color = LEVEL_COLORS[member.level] ?? '#6b7280';
  const totalBreakdownPts = breakdown.reduce((s, b) => s + b.total_points, 0) || 1;

  return (
    <div>
      {/* Header card */}
      <div style={{
        padding: '20px',
        borderRadius: '12px',
        background: `linear-gradient(135deg, ${color}18 0%, var(--color-background-secondary, rgba(255,255,255,0.04)) 100%)`,
        border: `1px solid ${color}40`,
        marginBottom: '16px',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--color-text-primary, #f1f5f9)', marginBottom: '6px' }}>
              {member.username}
            </h2>
            <LevelBadge level={member.level} name={member.level_name} emoji={member.level_emoji} />
            {member.github_username && (
              <div style={{ marginTop: '8px', fontSize: '0.78rem', color: 'var(--color-text-secondary, #94a3b8)' }}>
                🔗 github.com/{member.github_username}
              </div>
            )}
            <div style={{ marginTop: '4px', fontSize: '0.72rem', color: 'var(--color-text-tertiary, #64748b)' }}>
              Member since {member.first_seen_at.slice(0, 10)}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '1.8rem', fontWeight: 800, fontFamily: 'var(--font-mono, monospace)', color }}>
                {member.total_points.toLocaleString()}
              </div>
              <div style={{ fontSize: '0.68rem', color: 'var(--color-text-secondary, #94a3b8)', fontWeight: 600, textTransform: 'uppercase' }}>Total</div>
            </div>
            {member.season_points > 0 && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '1.8rem', fontWeight: 800, fontFamily: 'var(--font-mono, monospace)', color: '#a855f7' }}>
                  {member.season_points.toLocaleString()}
                </div>
                <div style={{ fontSize: '0.68rem', color: 'var(--color-text-secondary, #94a3b8)', fontWeight: 600, textTransform: 'uppercase' }}>Season</div>
              </div>
            )}
          </div>
        </div>

        {/* Level progress */}
        {member.next_level && (
          <div style={{ marginTop: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary, #94a3b8)' }}>
                Progress to <strong style={{ color }}>{member.next_level.name}</strong>
              </span>
              <span style={{ fontSize: '0.72rem', fontFamily: 'var(--font-mono, monospace)', color: 'var(--color-text-secondary, #94a3b8)' }}>
                {member.total_points.toLocaleString()} / {member.next_level.min_points.toLocaleString()} pts
              </span>
            </div>
            <ProgressBar pct={member.progress_pct} color={color} />
            <div style={{ fontSize: '0.68rem', color: 'var(--color-text-tertiary, #64748b)', marginTop: '4px', textAlign: 'right' }}>
              {member.next_level.points_needed.toLocaleString()} pts to go
            </div>
          </div>
        )}
        {!member.next_level && (
          <div style={{ marginTop: '12px', fontSize: '0.8rem', color, fontWeight: 600 }}>
            ✨ Maximum level achieved!
          </div>
        )}
      </div>

      {/* Contribution breakdown */}
      {breakdown.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary, #94a3b8)', marginBottom: '10px' }}>
            Contribution Breakdown
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {breakdown.map(b => {
              const barPct = (b.total_points / totalBreakdownPts) * 100;
              return (
                <div key={b.type} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ minWidth: '160px', fontSize: '0.78rem', color: 'var(--color-text-secondary, #94a3b8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {formatType(b.type)}
                  </div>
                  <div style={{ flex: 1 }}>
                    <ProgressBar pct={barPct} color={color} />
                  </div>
                  <div style={{ minWidth: '80px', textAlign: 'right', fontSize: '0.75rem', fontFamily: 'var(--font-mono, monospace)', color: 'var(--color-text-primary, #f1f5f9)' }}>
                    <span style={{ fontWeight: 700 }}>+{b.total_points}</span>
                    <span style={{ color: 'var(--color-text-tertiary, #64748b)' }}> ×{b.count}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent activity */}
      {recent.length > 0 && (
        <div>
          <h3 style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary, #94a3b8)', marginBottom: '10px' }}>
            Recent Activity
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {recent.map((r, i) => (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '8px 10px',
                borderRadius: '6px',
                background: 'var(--color-background-secondary, rgba(255,255,255,0.03))',
                border: '1px solid var(--color-border-primary, rgba(255,255,255,0.06))',
              }}>
                <div style={{ fontSize: '0.68rem', fontFamily: 'var(--font-mono, monospace)', color: 'var(--color-text-tertiary, #64748b)', minWidth: '70px' }}>
                  {r.created_at.slice(0, 10)}
                </div>
                <div style={{ flex: 1, fontSize: '0.78rem', color: 'var(--color-text-secondary, #94a3b8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {formatType(r.type)}
                  {r.channel && <span style={{ color: 'var(--color-text-tertiary, #64748b)' }}> · #{r.channel}</span>}
                </div>
                <div style={{ fontSize: '0.78rem', fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color }}>
                  +{r.points}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── View: Stats ───────────────────────────────────────────────────────────────

function StatsView({ data }: { data: StatsData }) {
  const { stats, active_season, type_breakdown, top_contributors } = data;
  const maxTypePts = type_breakdown.length > 0 ? type_breakdown[0].total_points : 1;

  return (
    <div>
      <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--color-text-primary, #f1f5f9)', marginBottom: '16px' }}>
        📊 System Stats
      </h2>

      {/* Stat cards */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '20px' }}>
        <StatCard label="Members" value={stats.total_members.toLocaleString()} />
        <StatCard label="Contributions" value={stats.total_contributions.toLocaleString()} />
        <StatCard label="Total Points" value={stats.total_points.toLocaleString()} />
        <StatCard label="Vouches" value={stats.vouches.toLocaleString()} />
        <StatCard label="Analysis Runs" value={stats.analysis_runs.toLocaleString()} />
        {active_season && (
          <StatCard
            label="Active Season"
            value={active_season.name}
            sub={`${active_season.contributions.toLocaleString()} contribs · ${active_season.points_awarded.toLocaleString()} pts`}
          />
        )}
      </div>

      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        {/* Type breakdown chart */}
        {type_breakdown.length > 0 && (
          <div style={{ flex: '1 1 260px' }}>
            <h3 style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary, #94a3b8)', marginBottom: '10px' }}>
              Contribution Types
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {type_breakdown.slice(0, 10).map((t) => {
                const barPct = (t.total_points / maxTypePts) * 100;
                return (
                  <div key={t.type}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                      <span style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary, #94a3b8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '160px' }}>
                        {formatType(t.type)}
                      </span>
                      <span style={{ fontSize: '0.72rem', fontFamily: 'var(--font-mono, monospace)', color: 'var(--color-text-primary, #f1f5f9)', flexShrink: 0, marginLeft: '8px' }}>
                        {t.total_points.toLocaleString()} <span style={{ color: 'var(--color-text-tertiary, #64748b)' }}>({t.count}×)</span>
                      </span>
                    </div>
                    <ProgressBar pct={barPct} color="#3b82f6" />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Top contributors mini-leaderboard */}
        {top_contributors.length > 0 && (
          <div style={{ flex: '1 1 220px' }}>
            <h3 style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary, #94a3b8)', marginBottom: '10px' }}>
              Top Contributors
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {top_contributors.map((c) => {
                const color = LEVEL_COLORS[c.level] ?? '#6b7280';
                const medal = RANK_MEDALS[c.rank];
                return (
                  <div key={c.rank} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 10px',
                    borderRadius: '6px',
                    background: 'var(--color-background-secondary, rgba(255,255,255,0.04))',
                    border: `1px solid ${c.rank <= 3 ? color + '30' : 'var(--color-border-primary, rgba(255,255,255,0.06))'}`,
                  }}>
                    <span style={{ fontSize: '0.9rem', minWidth: '22px' }}>{medal ?? `#${c.rank}`}</span>
                    <span style={{ flex: 1, fontSize: '0.82rem', fontWeight: 600, color: 'var(--color-text-primary, #f1f5f9)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.username}
                    </span>
                    <span style={{ fontSize: '0.78rem', fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color }}>
                      {c.total_points.toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── View: GitHub ──────────────────────────────────────────────────────────────

const EVENT_ICONS: Record<string, string> = {
  pr_merged: '🔀',
  pr_review: '👁️',
  bug_report_github: '🐛',
};

function GithubView({ data }: { data: GithubData }) {
  const { total_stats, user_summary, recent_events, filter_username } = data;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--color-text-primary, #f1f5f9)' }}>
          🐙 GitHub Contributions
        </h2>
        {filter_username && (
          <span style={{ fontSize: '0.75rem', padding: '3px 10px', borderRadius: '20px', background: '#3b82f620', color: '#3b82f6', border: '1px solid #3b82f640' }}>
            @{filter_username}
          </span>
        )}
      </div>

      {/* Summary stats */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '20px' }}>
        <StatCard label="Total Events" value={total_stats.total_events.toLocaleString()} />
        <StatCard label="Points Awarded" value={total_stats.total_points.toLocaleString()} />
        {!filter_username && <StatCard label="Contributors" value={total_stats.unique_contributors.toLocaleString()} />}
      </div>

      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        {/* Per-user table */}
        {user_summary.length > 0 && (
          <div style={{ flex: '1 1 280px', overflowX: 'auto' }}>
            <h3 style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary, #94a3b8)', marginBottom: '10px' }}>
              By Contributor
            </h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))' }}>
                  {['Author', '🔀 PRs', '👁️ Reviews', '🐛 Reports', 'Points'].map(h => (
                    <th key={h} style={{ padding: '4px 8px', textAlign: h === 'Author' ? 'left' : 'right', color: 'var(--color-text-tertiary, #64748b)', fontWeight: 600, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {user_summary.map((u) => (
                  <tr key={u.github_author} style={{ borderBottom: '1px solid var(--color-border-primary, rgba(255,255,255,0.05))' }}>
                    <td style={{ padding: '8px', color: 'var(--color-text-primary, #f1f5f9)', fontWeight: 500 }}>
                      @{u.github_author}
                    </td>
                    <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'var(--font-mono, monospace)', color: 'var(--color-text-secondary, #94a3b8)' }}>
                      {u.prs_merged}
                    </td>
                    <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'var(--font-mono, monospace)', color: 'var(--color-text-secondary, #94a3b8)' }}>
                      {u.pr_reviews}
                    </td>
                    <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'var(--font-mono, monospace)', color: 'var(--color-text-secondary, #94a3b8)' }}>
                      {u.bug_reports}
                    </td>
                    <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color: '#3b82f6' }}>
                      {u.total_points}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Recent events */}
        {recent_events.length > 0 && (
          <div style={{ flex: '1 1 220px' }}>
            <h3 style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary, #94a3b8)', marginBottom: '10px' }}>
              Recent Events
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {recent_events.slice(0, 15).map((e) => (
                <div key={e.event_id} style={{
                  display: 'flex',
                  gap: '8px',
                  padding: '7px 10px',
                  borderRadius: '6px',
                  background: 'var(--color-background-secondary, rgba(255,255,255,0.03))',
                  border: '1px solid var(--color-border-primary, rgba(255,255,255,0.06))',
                  alignItems: 'center',
                }}>
                  <span style={{ fontSize: '0.9rem', flexShrink: 0 }}>
                    {EVENT_ICONS[e.event_type] ?? '⚡'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-primary, #f1f5f9)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      @{e.github_author}
                      <span style={{ color: 'var(--color-text-tertiary, #64748b)' }}> · {e.repo.split('/').pop()}</span>
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--color-text-tertiary, #64748b)' }}>
                      {e.created_at.slice(0, 10)}
                    </div>
                  </div>
                  <div style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color: '#3b82f6', flexShrink: 0 }}>
                    +{e.points_awarded}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {user_summary.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--color-text-tertiary, #64748b)' }}>
          No GitHub events recorded yet.
        </div>
      )}
    </div>
  );
}

// ── Loading / Error states ────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '40px', color: 'var(--color-text-secondary, #94a3b8)' }}>
      <span style={{ fontSize: '1.2rem', animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
      <span>Loading contribution data…</span>
      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

function WelcomeState() {
  return (
    <div style={{ textAlign: 'center', padding: '32px 20px' }}>
      <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>🏆</div>
      <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--color-text-primary, #f1f5f9)', marginBottom: '8px' }}>
        DaShore Incubator Contributions
      </h2>
      <p style={{ fontSize: '0.82rem', color: 'var(--color-text-secondary, #94a3b8)', maxWidth: '320px', margin: '0 auto', lineHeight: 1.5 }}>
        Use the slash commands to explore the leaderboard, view member profiles,
        see system stats, or browse GitHub contributions.
      </p>
      <div style={{ marginTop: '20px', display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center' }}>
        {[
          { cmd: '/contribution_leaderboard', desc: 'Rankings' },
          { cmd: '/contribution_profile', desc: 'Member card' },
          { cmd: '/contribution_stats', desc: 'System stats' },
          { cmd: '/github_contributions', desc: 'GitHub activity' },
        ].map(({ cmd, desc }) => (
          <div key={cmd} style={{
            padding: '6px 12px',
            borderRadius: '6px',
            background: 'var(--color-background-secondary, rgba(255,255,255,0.05))',
            border: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
            fontSize: '0.72rem',
            color: 'var(--color-text-secondary, #94a3b8)',
          }}>
            <code style={{ color: '#3b82f6', fontFamily: 'var(--font-mono, monospace)' }}>{cmd}</code>
            <span style={{ marginLeft: '6px' }}>{desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────

export function App() {
  const [viewData, setViewData] = useState<ViewData | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const onAppCreated = useCallback((app: McpApp) => {

    app.ontoolinput = () => {
      setIsLoading(true);
    };

    app.ontoolresult = (result) => {
      setIsLoading(false);
      if (result.structuredContent && typeof result.structuredContent === 'object' && 'view' in result.structuredContent) {
        setViewData(result.structuredContent as ViewData);
      }
    };

    app.ontoolcancelled = () => {
      setIsLoading(false);
    };
  }, []);

  const { app, isConnected, error } = useApp({
    appInfo: { name: 'contribution-dashboard', version: '1.0.0' },
    capabilities: {},
    onAppCreated,
  });

  useHostStyleVariables(app, app?.getHostContext());

  const renderContent = () => {
    if (error) {
      return (
        <div style={{ padding: '20px', color: 'var(--color-text-danger, #ef4444)', fontSize: '0.85rem' }}>
          ⚠️ Connection error: {error.message}
        </div>
      );
    }
    if (!isConnected || isLoading) return <LoadingState />;
    if (!viewData) return <WelcomeState />;

    switch (viewData.view) {
      case 'leaderboard': return <LeaderboardView data={viewData} />;
      case 'profile':     return <ProfileView data={viewData} />;
      case 'stats':       return <StatsView data={viewData} />;
      case 'github':      return <GithubView data={viewData} />;
      default:            return <WelcomeState />;
    }
  };

  return (
    <div style={{
      minHeight: '200px',
      fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
      color: 'var(--color-text-primary, #f1f5f9)',
      padding: `
        max(12px, env(safe-area-inset-top))
        max(16px, env(safe-area-inset-right))
        max(12px, env(safe-area-inset-bottom))
        max(16px, env(safe-area-inset-left))
      `.replace(/\s+/g, ' ').trim(),
    }}>
      {renderContent()}
    </div>
  );
}
