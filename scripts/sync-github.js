#!/usr/bin/env node

/**
 * GitHub Contribution Sync
 * 
 * Polls merged PRs, PR reviews, and closed issues from tracked repos.
 * Awards contribution points to linked Discord members.
 * Uses `gh api` (GitHub CLI) — no tokens needed beyond gh auth.
 * 
 * Usage:
 *   node scripts/sync-github.js
 *   node scripts/sync-github.js --days 30
 *   node scripts/sync-github.js --since 2026-01-01T00:00:00Z
 *   node scripts/sync-github.js --dry-run --verbose
 *   node scripts/sync-github.js --dry-run --days 90 --verbose
 */

import { ContributionDB } from '../src/db.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──── CLI Flags ────

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    flags[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
    if (flags[key] !== true) i++;
  }
}

const dryRun  = flags['dry-run'] === true;
const verbose = flags['verbose'] === true || flags['v'] === true;

// Determine since date
let sinceISO;
const now = new Date();
if (flags.since) {
  sinceISO = new Date(flags.since).toISOString();
} else if (flags.days) {
  sinceISO = new Date(now - parseInt(flags.days) * 86400000).toISOString();
} else {
  // Default: last 7 days
  sinceISO = new Date(now - 7 * 86400000).toISOString();
}
const sinceDate = sinceISO.slice(0, 10); // YYYY-MM-DD for gh CLI

// ──── Config ────

let config;
try {
  config = JSON.parse(readFileSync(resolve(__dirname, '../config/config.json'), 'utf-8'));
} catch {
  console.error('Missing config/config.json');
  process.exit(1);
}

const GH = '/opt/homebrew/bin/gh';
const REPOS = config.github?.tracked_repos || [];
const POINTS = config.points;

// ──── DB ────

const db = new ContributionDB(
  resolve(__dirname, '..', config.contribution_db || './data/contributions.db')
).init();

const githubToDiscord = db.buildGithubUserMap(config.github?.user_map || {});

// ──── Header ────

console.log('\n=== GitHub Contribution Sync ===');
console.log(`Since:        ${sinceISO}`);
console.log(`Repos:        ${REPOS.length ? REPOS.join(', ') : '(none configured)'}`);
console.log(`Linked users: ${Object.keys(githubToDiscord).length}`);
console.log(`Dry run:      ${dryRun}`);
console.log(`Verbose:      ${verbose}`);
console.log('');

if (!REPOS.length) {
  console.log('No repos configured — add them to config.json github.tracked_repos');
  db.close();
  process.exit(0);
}

// ──── gh API helpers ────

/**
 * Call `gh api` and return parsed JSON. Returns [] or {} on error.
 */
function ghApi(endpoint, opts = {}) {
  const cmd = [GH, 'api', endpoint];
  if (opts.paginate) cmd.push('--paginate');

  const result = spawnSync(cmd[0], cmd.slice(1), {
    encoding: 'utf-8',
    timeout: 30000,
    env: process.env,
  });

  if (result.status !== 0) {
    if (verbose) console.error(`  [gh] ${endpoint} error: ${result.stderr?.trim()}`);
    return opts.paginate ? [] : null;
  }

  try {
    if (opts.paginate) {
      // Paginated output is newline-delimited JSON pages; combine arrays
      return result.stdout.trim().split('\n')
        .filter(Boolean)
        .flatMap(line => {
          try { return JSON.parse(line); } catch { return []; }
        });
    }
    return JSON.parse(result.stdout);
  } catch {
    return opts.paginate ? [] : null;
  }
}

/**
 * gh pr list via CLI (faster than API for simple cases)
 */
function ghCli(...args) {
  const result = spawnSync(GH, args, {
    encoding: 'utf-8',
    timeout: 30000,
    env: process.env,
  });
  if (result.status !== 0) {
    if (verbose) console.error(`  [gh cli] error: ${result.stderr?.trim()}`);
    return null;
  }
  try { return JSON.parse(result.stdout); } catch { return null; }
}

// ──── Point Calculation ────

function calcPRPoints(pr) {
  const changes = (pr.additions || 0) + (pr.deletions || 0);
  const base = POINTS.pr_merged.base || 10;
  const max  = POINTS.pr_merged.max  || 30;

  if (changes === 0) return base;
  if (changes < 20)  return base;
  if (changes < 100) return Math.min(Math.round(base * 1.5), max);
  if (changes < 500) return Math.min(Math.round(base * 2.0), max);
  return max; // large PR
}

function calcReviewPoints(state) {
  const base = POINTS.pr_review?.base || 5;
  const max  = POINTS.pr_review?.max  || 10;
  // Approved reviews worth more than comments
  return state === 'APPROVED' ? max : base;
}

function calcIssuePoints(issue) {
  const base = POINTS.bug_report_github?.base || 5;
  const isBug = issue.labels?.some(l =>
    l.name.toLowerCase().includes('bug') ||
    l.name.toLowerCase().includes('defect') ||
    l.name.toLowerCase().includes('fix')
  );
  return isBug ? base + 3 : base;
}

// ──── Award Helper ────

/**
 * Awards a contribution if not already recorded.
 * Returns points awarded (0 if skipped).
 */
function award({ eventId, eventType, repo, ghUser, discordId, points, evidence }) {
  if (!discordId) {
    if (verbose) console.log(`      no linked Discord for @${ghUser}, skipping`);
    return 0;
  }

  if (!dryRun && db.hasGithubEvent(eventId)) {
    if (verbose) console.log(`      [dedup] ${eventId} already processed`);
    return 0;
  }

  const tag = dryRun ? '[dry] ' : '';
  console.log(`    ${tag}+${points} pts -> @${ghUser} (${discordId}) — ${eventType}`);

  if (!dryRun) {
    // Ensure member row exists
    db.db.prepare(`
      INSERT OR IGNORE INTO members (discord_id, username) VALUES (?, ?)
    `).run(discordId, ghUser);

    db.addContribution({
      memberId: discordId,
      type: eventType,
      points,
      evidence: { ...evidence, repo, github_username: ghUser },
      source: 'github_sync',
    });

    db.recordGithubEvent({ eventId, eventType, repo, githubAuthor: ghUser, discordId, pointsAwarded: points });
  } else {
    db.recordGithubEvent({ eventId, eventType, repo, githubAuthor: ghUser, discordId, pointsAwarded: points, dryRun: true });
  }

  return points;
}

// ──── Main Sync ────

let totalContributions = 0;
let totalPoints = 0;
let skippedUnlinked = 0;

for (const repo of REPOS) {
  console.log(`\nRepo: ${repo}`);

  // ── Merged PRs ──────────────────────────────────────────

  const prs = ghCli('pr', 'list', '--repo', repo, '--state', 'merged',
    '--json', 'number,title,author,additions,deletions,mergedAt,url',
    '--limit', '200');

  if (!prs) {
    console.log('  [error] Could not fetch PRs — check gh auth / repo access');
  } else {
    const recent = prs.filter(pr => pr.mergedAt >= sinceISO);
    console.log(`  Merged PRs (since ${sinceDate}): ${recent.length}`);

    for (const pr of recent) {
      const ghUser = pr.author?.login?.toLowerCase();
      if (!ghUser) continue;
      const discordId = githubToDiscord[ghUser];
      if (!discordId) { skippedUnlinked++; if (verbose) console.log(`    PR #${pr.number} @${ghUser} — not linked`); continue; }

      const points = calcPRPoints(pr);
      const awarded = award({
        eventId: `pr_merged:${repo}:${pr.number}`,
        eventType: 'pr_merged',
        repo, ghUser, discordId, points,
        evidence: { pr_number: pr.number, title: pr.title, url: pr.url, additions: pr.additions, deletions: pr.deletions },
      });
      if (awarded) { totalContributions++; totalPoints += awarded; }
    }

    // ── PR Reviews ────────────────────────────────────────
    // Only fetch reviews when there are linked users — avoids N*API calls for no benefit

    const linkedUserCount = Object.keys(githubToDiscord).length;
    if (linkedUserCount > 0) {
      if (verbose) console.log(`  Fetching PR reviews for ${recent.length} PRs...`);
      for (const pr of recent) {
        const reviews = ghApi(`/repos/${repo}/pulls/${pr.number}/reviews`);
        if (!reviews) continue;

        for (const review of reviews) {
          if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'].includes(review.state)) continue;
          if (review.submitted_at < sinceISO) continue;

          const ghUser = review.user?.login?.toLowerCase();
          if (!ghUser || ghUser === pr.author?.login?.toLowerCase()) continue; // skip self-reviews
          const discordId = githubToDiscord[ghUser];
          if (!discordId) { skippedUnlinked++; continue; }

          const points = calcReviewPoints(review.state);
          const awarded = award({
            eventId: `pr_review:${repo}:${pr.number}:${review.id}`,
            eventType: 'pr_review',
            repo, ghUser, discordId, points,
            evidence: { pr_number: pr.number, pr_title: pr.title, review_state: review.state, review_id: review.id },
          });
          if (awarded) { totalContributions++; totalPoints += awarded; }
        }

        // Small delay to avoid rate-limiting review fetches
        await new Promise(r => setTimeout(r, 100));
      }
    } else {
      console.log(`  Skipping PR reviews — no linked Discord users yet (use /linkgithub to link)`);
    }
  }

  // ── Issues / Bug Reports ────────────────────────────────

  const issues = ghCli('issue', 'list', '--repo', repo, '--state', 'closed',
    '--json', 'number,title,author,closedAt,labels,url',
    '--limit', '200');

  if (!issues) {
    console.log('  [error] Could not fetch issues');
  } else {
    const recent = issues.filter(i => i.closedAt >= sinceISO);
    console.log(`  Closed issues (since ${sinceDate}): ${recent.length}`);

    for (const issue of recent) {
      const ghUser = issue.author?.login?.toLowerCase();
      if (!ghUser) continue;
      const discordId = githubToDiscord[ghUser];
      if (!discordId) { skippedUnlinked++; if (verbose) console.log(`    Issue #${issue.number} @${ghUser} — not linked`); continue; }

      const points = calcIssuePoints(issue);
      const awarded = award({
        eventId: `bug_report:${repo}:${issue.number}`,
        eventType: 'bug_report_github',
        repo, ghUser, discordId, points,
        evidence: { issue_number: issue.number, title: issue.title, url: issue.url, labels: issue.labels?.map(l => l.name) },
      });
      if (awarded) { totalContributions++; totalPoints += awarded; }
    }
  }
}

// ──── Summary ────

console.log('\n=== Summary ===');
console.log(`Contributions ${dryRun ? '(would be) ' : ''}awarded: ${totalContributions}`);
console.log(`Points        ${dryRun ? '(would be) ' : ''}awarded: ${totalPoints}`);
console.log(`Skipped (no Discord link): ${skippedUnlinked}`);

if (!dryRun) {
  const ghStats = db.getGithubStats();
  if (ghStats.length) {
    console.log('\n--- GitHub Contribution Totals (all time) ---');
    for (const s of ghStats) {
      console.log(`  ${s.event_type}: ${s.count} events, ${s.total_points} pts`);
    }
  }

  if (totalContributions > 0) {
    console.log('\n--- Updated Leaderboard ---');
    const leaders = db.getLeaderboard({ limit: 10 });
    for (const m of leaders) {
      console.log(`  ${m.display_name || m.username}: ${m.total_points} pts (Lv.${m.level} ${m.level_name})`);
    }
  }
}

db.close();
