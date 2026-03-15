#!/usr/bin/env node
/**
 * Create Level Roles
 *
 * Creates Discord roles for each contribution level and writes their IDs
 * back into config/config.json.
 *
 * Usage:
 *   BOT_TOKEN=... GUILD_ID=... node scripts/create-level-roles.js
 *   BOT_TOKEN=... node scripts/create-level-roles.js  # reads guild_id from config
 *
 * Safe to re-run — skips roles that already exist by name.
 */

import { REST, Routes } from 'discord.js';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, '../config/config.json');

// ──── Load config ────

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf-8'));
} catch {
  console.error('Cannot read config/config.json');
  process.exit(1);
}

const TOKEN = process.env.BOT_TOKEN || process.env[config.discord_token_env || 'DISCORD_BOT_TOKEN'];
if (!TOKEN) {
  console.error('Set BOT_TOKEN (or DISCORD_BOT_TOKEN) env var');
  process.exit(1);
}

const GUILD_ID = process.env.GUILD_ID || config.guild_id;
if (!GUILD_ID) {
  console.error('Set GUILD_ID env var or guild_id in config.json');
  process.exit(1);
}

// ──── Role definitions ────
// Must match config.levels names exactly.

const ROLE_COLORS = {
  Newcomer: 0x95a5a6,    // grey
  Participant: 0x3498db,  // blue
  Contributor: 0x2ecc71,  // green
  Regular: 0x9b59b6,      // purple
  Champion: 0xf1c40f,     // gold
  Legend: 0xe67e22,        // orange
  Architect: 0xe74c3c,     // red
};

// ──── Main ────

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function main() {
  console.log(`[create-level-roles] fetching existing roles for guild ${GUILD_ID}...`);

  // Fetch current guild roles
  const existingRoles = await rest.get(Routes.guildRoles(GUILD_ID));
  const existingByName = {};
  for (const r of existingRoles) {
    existingByName[r.name] = r;
  }

  const levels = config.levels || [];
  const updatedLevels = [];

  for (const levelDef of levels) {
    const { name, level } = levelDef;
    const color = ROLE_COLORS[name] ?? 0x99aab5;

    let roleId = levelDef.role_id || '';

    // Skip if already configured
    if (roleId) {
      // Verify it still exists
      const found = existingRoles.find(r => r.id === roleId);
      if (found) {
        console.log(`[create-level-roles] Level ${level} "${name}" — role already exists (${roleId}), skipping`);
        updatedLevels.push({ ...levelDef });
        continue;
      } else {
        console.warn(`[create-level-roles] Level ${level} "${name}" — configured role_id ${roleId} not found, recreating`);
        roleId = '';
      }
    }

    // Check by name
    if (existingByName[name]) {
      roleId = existingByName[name].id;
      console.log(`[create-level-roles] Level ${level} "${name}" — found existing role by name (${roleId})`);
    } else {
      // Create the role
      const created = await rest.post(Routes.guildRoles(GUILD_ID), {
        body: {
          name,
          color,
          hoist: false,        // set true to show separately in member list
          mentionable: true,
          permissions: '0',
        },
      });
      roleId = created.id;
      console.log(`[create-level-roles] Level ${level} "${name}" — created role (${roleId})`);

      // Small delay
      await new Promise(r => setTimeout(r, 500));
    }

    updatedLevels.push({ ...levelDef, role_id: roleId });
  }

  // Write updated config
  config.levels = updatedLevels;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`\n[create-level-roles] config.json updated with role IDs`);

  console.log('\nSummary:');
  for (const l of updatedLevels) {
    console.log(`  Lv.${l.level} ${l.name.padEnd(12)} → ${l.role_id || '(none)'}`);
  }
}

main().catch(err => {
  console.error('[create-level-roles] fatal:', err.message);
  process.exit(1);
});
