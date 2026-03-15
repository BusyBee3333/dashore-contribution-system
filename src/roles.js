/**
 * Discord Role Sync
 *
 * Syncs level-based Discord roles when members earn points.
 * Roles are defined in config.levels[].role_id (populated by create-level-roles.js).
 */

/**
 * Get the correct level for a given points total using config.levels.
 * Returns the highest level whose min_points is <= total.
 */
function getLevelForPoints(totalPoints, levels) {
  // Sort descending by min_points
  const sorted = [...levels].sort((a, b) => b.min_points - a.min_points);
  return sorted.find(l => totalPoints >= l.min_points) || sorted[sorted.length - 1];
}

/**
 * Sync a single member's Discord role to match their DB level.
 * Assigns the correct role, removes all other level roles.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} discordId
 * @param {import('./db.js').ContributionDB} db
 * @param {object} config  — full config.json object
 * @returns {{ assigned: string|null, removed: string[], skipped: boolean }}
 */
export async function syncMemberRole(guild, discordId, db, config) {
  const levels = config.levels || [];
  const roleIds = levels.map(l => l.role_id).filter(Boolean);

  if (!roleIds.length) {
    console.warn('[roles] No role_ids configured — run scripts/create-level-roles.js first');
    return { assigned: null, removed: [], skipped: true };
  }

  // Fetch member from guild
  let guildMember;
  try {
    guildMember = await guild.members.fetch(discordId);
  } catch {
    // Member not in guild (left, banned, etc.)
    return { assigned: null, removed: [], skipped: true };
  }

  // Get their DB record
  const dbMember = db.getMember(discordId);
  if (!dbMember) return { assigned: null, removed: [], skipped: true };

  const targetLevel = getLevelForPoints(dbMember.total_points, levels);
  const targetRoleId = targetLevel?.role_id || '';

  const removed = [];

  // Remove all level roles they currently have (except the target)
  for (const roleId of roleIds) {
    if (roleId === targetRoleId) continue;
    if (guildMember.roles.cache.has(roleId)) {
      try {
        await guildMember.roles.remove(roleId, 'contribution-system level sync');
        removed.push(roleId);
      } catch (err) {
        console.warn(`[roles] failed to remove role ${roleId} from ${discordId}:`, err.message);
      }
    }
  }

  // Assign target role if not already present
  let assigned = null;
  if (targetRoleId && !guildMember.roles.cache.has(targetRoleId)) {
    try {
      await guildMember.roles.add(targetRoleId, 'contribution-system level sync');
      assigned = targetRoleId;
    } catch (err) {
      console.warn(`[roles] failed to assign role ${targetRoleId} to ${discordId}:`, err.message);
    }
  }

  return { assigned, removed, skipped: false, level: targetLevel };
}

/**
 * Sync roles for ALL members with points > 0.
 * Iterates in batches to avoid rate-limiting.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('./db.js').ContributionDB} db
 * @param {object} config
 * @returns {{ synced: number, skipped: number, errors: number }}
 */
export async function syncAllRoles(guild, db, config) {
  const members = db.db.prepare('SELECT discord_id FROM members WHERE total_points > 0').all();

  let synced = 0, skipped = 0, errors = 0;

  for (const { discord_id } of members) {
    try {
      const result = await syncMemberRole(guild, discord_id, db, config);
      if (result.skipped) skipped++;
      else synced++;
    } catch (err) {
      console.error(`[roles] error syncing ${discord_id}:`, err.message);
      errors++;
    }

    // Small delay to respect Discord rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[roles] syncAllRoles done — synced=${synced} skipped=${skipped} errors=${errors}`);
  return { synced, skipped, errors };
}
