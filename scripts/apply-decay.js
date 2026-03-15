#!/usr/bin/env node

/**
 * Apply Decay to Contributions
 *
 * Decays points on old contributions by the configured rate.
 * Points never fall below min_points. Logs all changes to decay_log.
 * Recalculates all affected member totals after applying decay.
 *
 * Usage:
 *   node scripts/apply-decay.js
 *   node scripts/apply-decay.js --dry-run
 *   node scripts/apply-decay.js --dry-run --verbose
 *   node scripts/apply-decay.js --verbose
 */

import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──── Parse Args ────

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    flags[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
    if (flags[key] !== true) i++;
  }
}

const dryRun = flags['dry-run'] === true;
const verbose = flags['verbose'] === true || flags['v'] === true;

// ──── Load Config ────

let config;
try {
  config = JSON.parse(readFileSync(resolve(__dirname, '../config/config.json'), 'utf-8'));
} catch {
  console.error('Missing config/config.json');
  process.exit(1);
}

const decay = config.decay;
if (!decay?.enabled) {
  console.log('Decay is disabled in config. Set decay.enabled = true to enable.');
  process.exit(0);
}

const { rate, interval_days, min_points } = decay;

if (typeof rate !== 'number' || rate <= 0 || rate >= 1) {
  console.error(`Invalid decay rate: ${rate}. Must be between 0 and 1 (e.g. 0.95).`);
  process.exit(1);
}

console.log(`\n=== Contribution Decay ===`);
console.log(`Rate: ${((1 - rate) * 100).toFixed(0)}% decay per ${interval_days}-day period (keep ${(rate * 100).toFixed(0)}%)`);
console.log(`Min points floor: ${min_points}`);
console.log(`Dry run: ${dryRun}`);
console.log('');

// ──── Open DB ────

const dbPath = resolve(__dirname, '..', config.contribution_db || './data/contributions.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Ensure decay_log table exists (backward-compatible)
db.exec(`
  CREATE TABLE IF NOT EXISTS decay_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contribution_id INTEGER REFERENCES contributions(id),
    old_points INTEGER,
    new_points INTEGER,
    decay_rate REAL,
    applied_at TEXT DEFAULT (datetime('now'))
  );
`);

// ──── Find Contributions to Decay ────

const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - interval_days);
const cutoffISO = cutoff.toISOString().replace('T', ' ').slice(0, 19);

// Skip pending_github_claim (0-point bookkeeping rows) and already-minimum rows
const contributions = db.prepare(`
  SELECT id, member_id, points, type
  FROM contributions
  WHERE created_at <= ?
    AND points > ?
    AND type != 'pending_github_claim'
`).all(cutoffISO, min_points);

console.log(`Cutoff date: ${cutoffISO}`);
console.log(`Eligible contributions (older than ${interval_days} days, points > ${min_points}): ${contributions.length}\n`);

if (!contributions.length) {
  console.log('Nothing to decay.');
  db.close();
  process.exit(0);
}

// ──── Apply Decay in a Transaction ────

const applyDecayStmt = db.prepare('UPDATE contributions SET points = ? WHERE id = ?');
const logDecayStmt = db.prepare(`
  INSERT INTO decay_log (contribution_id, old_points, new_points, decay_rate)
  VALUES (?, ?, ?, ?)
`);

let decayed = 0;
let skipped = 0;
const affectedMembers = new Set();

const applyAll = db.transaction(() => {
  for (const contrib of contributions) {
    const newPoints = Math.max(min_points, Math.round(contrib.points * rate));

    if (newPoints === contrib.points) {
      // No change (already at or would round to same value)
      if (verbose) {
        console.log(`  [skip] #${contrib.id} ${contrib.type}: ${contrib.points} pts — no change after rounding`);
      }
      skipped++;
      continue;
    }

    if (verbose) {
      console.log(`  [decay] #${contrib.id} ${contrib.type}: ${contrib.points} -> ${newPoints} pts (member ${contrib.member_id})`);
    }

    if (!dryRun) {
      applyDecayStmt.run(newPoints, contrib.id);
      logDecayStmt.run(contrib.id, contrib.points, newPoints, rate);
    }

    affectedMembers.add(contrib.member_id);
    decayed++;
  }
});

applyAll();

// ──── Recalculate Member Totals ────

if (!dryRun && affectedMembers.size > 0) {
  console.log(`\nRecalculating totals for ${affectedMembers.size} affected member(s)...`);

  const levels = [
    { level: 7, name: 'Architect', min: 5000 },
    { level: 6, name: 'Legend', min: 2500 },
    { level: 5, name: 'Champion', min: 1000 },
    { level: 4, name: 'Regular', min: 500 },
    { level: 3, name: 'Contributor', min: 200 },
    { level: 2, name: 'Participant', min: 50 },
    { level: 1, name: 'Newcomer', min: 0 },
  ];

  const activeSeason = db.prepare(
    'SELECT * FROM seasons WHERE active = 1 ORDER BY id DESC LIMIT 1'
  ).get();

  const getTotalStmt = db.prepare(
    'SELECT COALESCE(SUM(points), 0) as total FROM contributions WHERE member_id = ?'
  );
  const getSeasonStmt = db.prepare(
    'SELECT COALESCE(SUM(points), 0) as total FROM contributions WHERE member_id = ? AND season_id = ?'
  );
  const updateMemberStmt = db.prepare(`
    UPDATE members SET
      total_points = ?, season_points = ?,
      level = ?, level_name = ?,
      updated_at = datetime('now')
    WHERE discord_id = ?
  `);

  const recalcAll = db.transaction(() => {
    for (const memberId of affectedMembers) {
      const total = getTotalStmt.get(memberId).total;

      let seasonPoints = 0;
      if (activeSeason) {
        seasonPoints = getSeasonStmt.get(memberId, activeSeason.id).total;
      }

      const memberLevel = levels.find(l => total >= l.min) || levels[levels.length - 1];
      updateMemberStmt.run(total, seasonPoints, memberLevel.level, memberLevel.name, memberId);

      if (verbose) {
        console.log(`  ${memberId}: ${total} pts (Lv.${memberLevel.level} ${memberLevel.name})`);
      }
    }
  });

  recalcAll();
}

// ──── Summary ────

console.log(`\n=== Decay Summary ===`);
console.log(`Contributions decayed: ${decayed}${dryRun ? ' (dry run — no changes written)' : ''}`);
console.log(`Skipped (no change): ${skipped}`);
console.log(`Members affected: ${affectedMembers.size}${dryRun ? ' (would be)' : ''}`);

if (dryRun) {
  console.log('\n[dry-run] No changes were written to the database.');
}

db.close();
