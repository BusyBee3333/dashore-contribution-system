import React, { useState } from "react";
import {
  Embed,
  EmbedField,
  EmbedTitle,
  EmbedFooter,
  Button,
  ActionRow,
} from "@answeroverflow/discordjs-react";
import {
  getStats,
  getContributionTypeBreakdown,
  getLeaderboard,
} from "../db.js";

// ── Colors ─────────────────────────────────────────────────────────────────

const BLURPLE   = 0x5865f2;
const GOLD      = 0xf1c40f;
const TEAL      = 0x1abc9c;

// ── Type Config ────────────────────────────────────────────────────────────
// Each type gets an emoji AND a specific block color for its bar.

interface TypeConfig {
  emoji: string;
  bar: string; // filled block emoji
}

const TYPE_CONFIG: Record<string, TypeConfig> = {
  helpful_conversation: { emoji: "💬", bar: "🟦" },
  teaching_moment:      { emoji: "📚", bar: "🟨" },
  tool_share:           { emoji: "🔧", bar: "🟫" },
  pr_merged:            { emoji: "🐙", bar: "🟩" },
  pr_review:            { emoji: "👀", bar: "🟩" },
  bug_report_github:    { emoji: "🐛", bar: "🟩" },
  peer_vouch:           { emoji: "🤝", bar: "🟪" },
  event_hosted:         { emoji: "🎪", bar: "🟧" },
  event_attended:       { emoji: "🎫", bar: "🟧" },
  reaction_bonus:       { emoji: "⭐", bar: "🟡" },
  manual_grant:         { emoji: "🎁", bar: "🟥" },
  streak_bonus:         { emoji: "🔥", bar: "🟥" },
  project_proposed:     { emoji: "📋", bar: "🟦" },
  project_approved:     { emoji: "🚀", bar: "🟦" },
};

function getTypeConfig(type: string): TypeConfig {
  return TYPE_CONFIG[type] ?? { emoji: "🏅", bar: "🟦" };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatTypeName(type: string): string {
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildTypedBar(value: number, max: number, blocks = 8, barBlock = "🟦"): string {
  if (max === 0) return "⬜".repeat(blocks);
  const filled = Math.min(blocks, Math.round((value / max) * blocks));
  return barBlock.repeat(filled) + "⬜".repeat(blocks - filled);
}

// ── Component ──────────────────────────────────────────────────────────────

export function StatsPanel() {
  const [showPodium, setShowPodium] = useState(false);

  const stats        = getStats();
  const breakdown    = getContributionTypeBreakdown();
  const top3Members  = getLeaderboard(false, 3);

  const maxPoints = breakdown.length > 0 ? breakdown[0].total_points : 1;

  // ── Breakdown text ──
  const breakdownText =
    breakdown.slice(0, 12).length > 0
      ? breakdown
          .slice(0, 12)
          .map((b) => {
            const cfg = getTypeConfig(b.type);
            const bar = buildTypedBar(b.total_points, maxPoints, 8, cfg.bar);
            return `${cfg.emoji} ${bar} **${formatTypeName(b.type)}** — ${b.total_points.toLocaleString()} pts (${b.count}×)`;
          })
          .join("\n")
      : "_No contributions recorded yet_";

  // ── Podium text ──
  const MEDALS = ["🥇", "🥈", "🥉"];
  const podiumText =
    top3Members.length > 0
      ? top3Members
          .map((m, i) => {
            const name = m.display_name || m.username;
            return `${MEDALS[i]} **${name}** — ${m.total_points.toLocaleString()} pts *(${m.level_name})*`;
          })
          .join("\n")
      : "_No contributors yet_";

  return (
    <>
      {/* ── Main Stats Embed ── */}
      <Embed color={BLURPLE}>
        <EmbedTitle>📊 Contribution System — Global Stats</EmbedTitle>

        {/* 3×2 inline grid */}
        <EmbedField
          name="👥 Members"
          value={`**${stats.members.toLocaleString()}**`}
          inline={true}
        />
        <EmbedField
          name="🏅 Contributions"
          value={`**${stats.contributions.toLocaleString()}**`}
          inline={true}
        />
        <EmbedField
          name="⭐ Total Points"
          value={`**${stats.totalPoints.toLocaleString()}**`}
          inline={true}
        />
        <EmbedField
          name="✊ Vouches Given"
          value={`**${stats.vouches.toLocaleString()}**`}
          inline={true}
        />
        <EmbedField
          name="🤖 AI Analysis Runs"
          value={`**${stats.analysisRuns.toLocaleString()}**`}
          inline={true}
        />
        <EmbedField
          name="🗓️ Active Season"
          value={
            stats.activeSeason
              ? `**${stats.activeSeason.name}**`
              : "_No active season_"
          }
          inline={true}
        />

        <EmbedFooter text="Toggle the podium below · Data updates in real-time" />
      </Embed>

      {/* ── Breakdown Embed ── */}
      <Embed color={TEAL}>
        <EmbedTitle>📈 Points by Contribution Type</EmbedTitle>
        <EmbedField
          name="🟦 💬 Conversations · 🟨 📚 Teaching · 🟩 🐙 GitHub · 🟪 🤝 Vouches · 🟧 🎪 Events"
          value={breakdownText}
          inline={false}
        />
        <EmbedFooter text="Each bar scales to the top category" />
      </Embed>

      {/* ── Optional Podium Embed ── */}
      {showPodium && (
        <Embed color={GOLD}>
          <EmbedTitle>🏆 Top 3 All-Time Contributors</EmbedTitle>
          <EmbedField name="\u200b" value="\u200b" inline={false} />
          {top3Members.length >= 1 && (
            <EmbedField
              name={`🥇 ${top3Members[0].display_name || top3Members[0].username}`}
              value={`**${top3Members[0].total_points.toLocaleString()}** pts\n${top3Members[0].level_name}`}
              inline={true}
            />
          )}
          {top3Members.length >= 2 && (
            <EmbedField
              name={`🥈 ${top3Members[1].display_name || top3Members[1].username}`}
              value={`**${top3Members[1].total_points.toLocaleString()}** pts\n${top3Members[1].level_name}`}
              inline={true}
            />
          )}
          {top3Members.length >= 3 && (
            <EmbedField
              name={`🥉 ${top3Members[2].display_name || top3Members[2].username}`}
              value={`**${top3Members[2].total_points.toLocaleString()}** pts\n${top3Members[2].level_name}`}
              inline={true}
            />
          )}
          {top3Members.length === 0 && (
            <EmbedField
              name="😶 Empty"
              value="_No contributors yet_"
              inline={false}
            />
          )}
        </Embed>
      )}

      <ActionRow>
        <Button
          label={showPodium ? "🙈 Hide Podium" : "🏆 Show Podium"}
          style={showPodium ? "Secondary" : "Primary"}
          onClick={() => setShowPodium((v) => !v)}
        />
      </ActionRow>
    </>
  );
}
