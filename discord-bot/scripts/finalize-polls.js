#!/usr/bin/env node
// finalize-polls.js
//
// Finalizes community project polls whose voting period has ended.
// Run every 5 minutes via cron:
//   clawdbot cron add "every 5 minutes: node /path/to/finalize-polls.js"
//
// Uses Discord REST directly (no bot client needed).

import { createRequire } from "module";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from discord-bot dir
const envPath = resolve(__dirname, "../.env");
try {
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // .env optional if env vars already set
}

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { REST, Routes } = await import("discord.js");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DB_PATH =
  process.env.DB_PATH ||
  "/Users/jakeshore/.clawdbot/workspace/contribution-system/data/contributions.db";

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error("[finalize-polls] Missing BOT_TOKEN or CLIENT_ID");
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

// ── Helpers ────────────────────────────────────────────────────────────────

function getActiveSeason() {
  return db.prepare("SELECT * FROM seasons WHERE active = 1 ORDER BY id DESC LIMIT 1").get();
}

function recalcMemberPoints(discordId) {
  const total = db.prepare(
    "SELECT COALESCE(SUM(points), 0) as total FROM contributions WHERE member_id = ?"
  ).get(discordId).total;

  const season = getActiveSeason();
  let seasonPoints = 0;
  if (season) {
    seasonPoints = db.prepare(
      "SELECT COALESCE(SUM(points), 0) as total FROM contributions WHERE member_id = ? AND season_id = ?"
    ).get(discordId, season.id).total;
  }

  const LEVELS = [
    { level: 1, name: "Newcomer", min: 0 },
    { level: 2, name: "Participant", min: 50 },
    { level: 3, name: "Contributor", min: 200 },
    { level: 4, name: "Regular", min: 500 },
    { level: 5, name: "Champion", min: 1000 },
    { level: 6, name: "Legend", min: 2500 },
    { level: 7, name: "Architect", min: 5000 },
  ];

  const memberLevel = [...LEVELS].reverse().find((l) => total >= l.min) ?? LEVELS[0];
  db.prepare(`
    UPDATE members SET total_points = ?, season_points = ?, level = ?, level_name = ?, updated_at = datetime('now')
    WHERE discord_id = ?
  `).run(total, seasonPoints, memberLevel.level, memberLevel.name, discordId);
}

function finalizeProject(project) {
  const yesVotes = project.votes_yes;
  const noVotes = project.votes_no;
  const totalVotes = yesVotes + noVotes;
  const totalEligible = project.total_eligible_voters || 1;
  const yesPct = totalVotes > 0 ? yesVotes / totalVotes : 0;
  const participationPct = totalVotes / totalEligible;

  const passed = yesPct >= 0.6 && participationPct >= 0.5;

  let status;
  if (passed) {
    status = "active";
    db.prepare(
      "UPDATE community_projects SET status = 'active', approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(project.id);

    // Award proposer 30 pts
    const season = getActiveSeason();
    const seasonId = season?.id ?? null;
    db.prepare("INSERT OR IGNORE INTO members (discord_id, username, display_name) VALUES (?, ?, ?)").run(
      project.proposed_by, project.proposed_by, null
    );
    db.prepare(`
      INSERT INTO contributions (member_id, type, points, evidence, source, season_id)
      VALUES (?, 'project_approved', 30, ?, 'manual', ?)
    `).run(project.proposed_by, JSON.stringify({ project_id: project.id, title: project.title }), seasonId);
    recalcMemberPoints(project.proposed_by);
  } else if (project.attempt_number >= 2) {
    status = "cooldown";
    db.prepare(
      "UPDATE community_projects SET status = 'cooldown', last_failed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(project.id);
  } else {
    status = "rejected";
    db.prepare(
      "UPDATE community_projects SET status = 'rejected', updated_at = datetime('now') WHERE id = ?"
    ).run(project.id);
  }

  return { status, passed, yesVotes, noVotes, totalVotes, totalEligible, yesPct, participationPct };
}

function buildFinalEmbed(project, result) {
  const { yesVotes, noVotes, totalVotes, totalEligible, yesPct, participationPct, status } = result;
  const yesPctStr = (yesPct * 100).toFixed(1);
  const partPctStr = (participationPct * 100).toFixed(1);

  const resultLine =
    status === "active"
      ? "✅ **APPROVED** — This project is now active!"
      : status === "cooldown"
      ? "❌ **REJECTED** — Proposer must wait 7 days before re-proposing"
      : "❌ **REJECTED** — Proposer may try again immediately";

  return {
    title: `📋 Project Proposal: ${project.title}`,
    color: status === "active" ? 0x57f287 : 0xed4245,
    fields: [
      { name: "📝 Description", value: project.description || "_No description_", inline: false },
      project.repo_url ? { name: "🔗 Repository", value: project.repo_url, inline: true } : null,
      { name: "👤 Proposed By", value: `<@${project.proposed_by}>`, inline: true },
      { name: "⏰ Voting", value: "**Voting closed**", inline: true },
      {
        name: "📊 Final Votes",
        value: `✅ Yes: **${yesVotes}** | ❌ No: **${noVotes}** | ${totalVotes}/${totalEligible} members voted\n${yesPctStr}% yes · ${partPctStr}% participation`,
        inline: false,
      },
      { name: "📋 Result", value: resultLine, inline: false },
    ].filter(Boolean),
    footer: "Community Project Voting — Finalized",
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  const expiredProjects = db.prepare(`
    SELECT * FROM community_projects
    WHERE status = 'voting' AND poll_ends_at <= ?
  `).all(now);

  if (expiredProjects.length === 0) {
    console.log("[finalize-polls] No expired polls.");
    return;
  }

  console.log(`[finalize-polls] Finalizing ${expiredProjects.length} poll(s)...`);

  for (const project of expiredProjects) {
    console.log(`[finalize-polls] Processing project #${project.id}: ${project.title}`);

    try {
      const result = finalizeProject(project);
      const { status, yesVotes, noVotes, totalVotes, totalEligible, yesPct, participationPct } = result;

      const yesPctStr = (yesPct * 100).toFixed(1);
      const partPctStr = (participationPct * 100).toFixed(1);

      // 1. Edit the original poll message
      if (project.poll_message_id && project.poll_channel_id) {
        try {
          const embedData = buildFinalEmbed(project, result);
          const embed = {
            title: embedData.title,
            color: embedData.color,
            fields: embedData.fields,
            footer: { text: embedData.footer },
            timestamp: new Date().toISOString(),
          };

          await rest.patch(
            Routes.channelMessage(project.poll_channel_id, project.poll_message_id),
            { body: { embeds: [embed], components: [] } }
          );
          console.log(`  ✅ Updated poll message for project #${project.id}`);
        } catch (editErr) {
          console.error(`  ⚠️ Could not edit poll message:`, editErr.message);
        }

        // 2. Post follow-up result message
        try {
          let followUpContent;
          if (result.passed) {
            followUpContent = `✅ **Approved!** **${project.title}** is now a community project! Congratulations to <@${project.proposed_by}>! (+30 pts awarded)\n> ${yesPctStr}% yes votes, ${partPctStr}% participation`;
          } else {
            const retryMsg =
              status === "cooldown"
                ? "This was the 2nd attempt — proposer must wait 7 days."
                : "This was the 1st attempt — proposer may try again immediately.";
            followUpContent = `❌ **Rejected.** **${project.title}** did not pass the vote.\n> ${yesVotes}/${totalVotes} yes votes (${yesPctStr}%), ${partPctStr}% participation.\n> ${retryMsg}`;
          }

          await rest.post(Routes.channelMessages(project.poll_channel_id), {
            body: { content: followUpContent },
          });
          console.log(`  ✅ Posted follow-up for project #${project.id}: ${status}`);
        } catch (followErr) {
          console.error(`  ⚠️ Could not post follow-up:`, followErr.message);
        }
      }
    } catch (err) {
      console.error(`  ❌ Error finalizing project #${project.id}:`, err.message);
    }
  }

  console.log("[finalize-polls] Done.");
}

main().catch((err) => {
  console.error("[finalize-polls] Fatal error:", err);
  process.exit(1);
});
