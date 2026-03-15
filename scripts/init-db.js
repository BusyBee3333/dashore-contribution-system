#!/usr/bin/env node

/**
 * Initialize the contribution database and seed members from discrawl.
 */

import { ContributionDB } from '../src/db.js';
import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let config;
try {
  config = JSON.parse(readFileSync(resolve(__dirname, '../config/config.json'), 'utf-8'));
} catch {
  console.error('Missing config/config.json — copy from config.example.json and fill in');
  process.exit(1);
}

const dbPath = resolve(__dirname, '..', config.contribution_db || './data/contributions.db');
const dataDir = resolve(dbPath, '..');
mkdirSync(dataDir, { recursive: true });

console.log(`Initializing contribution DB at: ${dbPath}`);
const db = new ContributionDB(dbPath).init();

// Seed members from discrawl
const discrawlDbPath = config.discrawl_db?.replace('~', process.env.HOME) || resolve(process.env.HOME, '.discrawl/discrawl.db');
console.log(`Reading members from discrawl: ${discrawlDbPath}`);

const discrawl = new Database(discrawlDbPath, { readonly: true });
const members = discrawl.prepare(`
  SELECT user_id, username, display_name, nick 
  FROM members 
  WHERE guild_id = ? AND bot = 0
`).all(config.guild_id);

let seeded = 0;
for (const m of members) {
  db.upsertMember(m.user_id, m.username, m.nick || m.display_name);
  seeded++;
}

// Start first season
const season = db.getActiveSeason();
if (!season) {
  const now = new Date();
  const seasonName = `${now.toLocaleString('en', { month: 'long' })} ${now.getFullYear()}`;
  db.startSeason(seasonName);
  console.log(`Started first season: "${seasonName}"`);
}

console.log(`Seeded ${seeded} members`);
console.log(`\nDB ready! Stats:`, db.getStats());

discrawl.close();
db.close();
