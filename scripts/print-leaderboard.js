#!/usr/bin/env node

/**
 * Quick CLI leaderboard print
 */

import { ContributionDB } from '../src/db.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let config;
try {
  config = JSON.parse(readFileSync(resolve(__dirname, '../config/config.json'), 'utf-8'));
} catch {
  console.error('Missing config/config.json');
  process.exit(1);
}

const db = new ContributionDB(resolve(__dirname, '..', config.contribution_db || './data/contributions.db')).init();

const isSeason = process.argv.includes('--season');
const leaders = db.getLeaderboard({ limit: 20, season: isSeason });

console.log(isSeason ? '\n=== Season Leaderboard ===' : '\n=== All-Time Leaderboard ===');
console.log('');

if (!leaders.length) {
  console.log('  No contributions yet!');
} else {
  for (let i = 0; i < leaders.length; i++) {
    const m = leaders[i];
    const name = (m.display_name || m.username).padEnd(20);
    const pts = String(isSeason ? m.season_points : m.total_points).padStart(5);
    console.log(`  ${String(i + 1).padStart(2)}. ${name} ${pts} pts  Lv.${m.level} ${m.level_name}`);
  }
}

console.log('');
const stats = db.getStats();
console.log(`Contributors: ${stats.members} | Total points: ${stats.totalPoints} | Vouches: ${stats.vouches} | Analysis runs: ${stats.analysisRuns}`);

db.close();
