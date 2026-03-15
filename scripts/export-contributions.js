#!/usr/bin/env node
/**
 * Export Contributions
 *
 * Exports the contributions database to CSV or JSON files.
 *
 * Usage:
 *   node scripts/export-contributions.js [options]
 *
 * Options:
 *   --format csv|json      Output format (default: csv)
 *   --output <dir>         Output directory (default: ./exports)
 *   --since <date>         Only include records on/after this date (ISO 8601 or YYYY-MM-DD)
 *   --db <path>            Path to SQLite DB (default: from config)
 *   --help                 Show this help
 *
 * Output files:
 *   contributions.{csv,json}
 *   members.{csv,json}
 *   leaderboard.{csv,json}
 *   github_events.{csv,json}
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──── Args ────

function parseArgs(argv) {
  const args = { format: 'csv', output: './exports', since: null, db: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--format': args.format = argv[++i]; break;
      case '--output': args.output = argv[++i]; break;
      case '--since': args.since = argv[++i]; break;
      case '--db': args.db = argv[++i]; break;
      case '--help': case '-h': args.help = true; break;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
Export Contributions — exports the contribution DB to CSV/JSON

Usage:
  node scripts/export-contributions.js [options]

Options:
  --format csv|json      Output format (default: csv)
  --output <dir>         Output directory (default: ./exports)
  --since <date>         Only include records on/after date (YYYY-MM-DD or ISO)
  --db <path>            Path to SQLite DB file
  --help                 Show help

Examples:
  node scripts/export-contributions.js
  node scripts/export-contributions.js --format json --output /tmp/dump
  node scripts/export-contributions.js --since 2025-01-01 --format csv
`);
  process.exit(0);
}

if (!['csv', 'json'].includes(args.format)) {
  console.error(`Invalid --format "${args.format}" — must be csv or json`);
  process.exit(1);
}

// ──── Load config + DB ────

const configPath = resolve(__dirname, '../config/config.json');
let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf-8'));
} catch {
  console.error('Cannot read config/config.json');
  process.exit(1);
}

const dbPath = args.db
  ? resolve(args.db)
  : resolve(__dirname, '..', config.contribution_db || './data/contributions.db');

let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (err) {
  console.error(`Cannot open database at ${dbPath}: ${err.message}`);
  process.exit(1);
}

const outputDir = resolve(args.output);
mkdirSync(outputDir, { recursive: true });

// ──── Helpers ────

function sinceClause(col) {
  return args.since ? `AND ${col} >= '${args.since}'` : '';
}

/**
 * Convert array of objects to CSV string.
 */
function toCsv(rows) {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const header = keys.map(k => JSON.stringify(k)).join(',');
  const lines = rows.map(row =>
    keys.map(k => {
      const v = row[k];
      if (v === null || v === undefined) return '';
      if (typeof v === 'string' && (v.includes(',') || v.includes('"') || v.includes('\n'))) {
        return '"' + v.replace(/"/g, '""') + '"';
      }
      return String(v);
    }).join(',')
  );
  return [header, ...lines].join('\n');
}

function writeOutput(name, rows) {
  const ext = args.format;
  const filePath = join(outputDir, `${name}.${ext}`);
  let content;
  if (ext === 'json') {
    content = JSON.stringify(rows, null, 2);
  } else {
    content = toCsv(rows);
  }
  writeFileSync(filePath, content, 'utf-8');
  console.log(`  → ${filePath} (${rows.length} rows)`);
}

// ──── Queries ────

console.log(`[export] format=${args.format} output=${outputDir}${args.since ? ` since=${args.since}` : ''}\n`);

// contributions
const contributions = db.prepare(`
  SELECT id, member_id, type, points, raw_score, multiplier, source,
         channel_id, channel_name, season_id, created_at,
         evidence, message_ids
  FROM contributions
  WHERE 1=1 ${sinceClause('created_at')}
  ORDER BY created_at DESC
`).all();
writeOutput('contributions', contributions);

// members
const members = db.prepare(`
  SELECT discord_id, username, display_name, github_username,
         total_points, season_points, level, level_name,
         first_seen_at, updated_at
  FROM members
  ORDER BY total_points DESC
`).all();
writeOutput('members', members);

// leaderboard (top 100 all-time)
const leaderboard = db.prepare(`
  SELECT ROW_NUMBER() OVER (ORDER BY total_points DESC) as rank,
         discord_id, username, display_name, github_username,
         total_points, season_points, level, level_name
  FROM members
  WHERE total_points > 0
  ORDER BY total_points DESC
  LIMIT 100
`).all();
writeOutput('leaderboard', leaderboard);

// github_events
const githubEvents = db.prepare(`
  SELECT id, event_id, event_type, repo, github_author, discord_id,
         points_awarded, dry_run, created_at
  FROM github_events
  WHERE 1=1 ${sinceClause('created_at')}
  ORDER BY created_at DESC
`).all();
writeOutput('github_events', githubEvents);

db.close();
console.log('\n[export] done');
