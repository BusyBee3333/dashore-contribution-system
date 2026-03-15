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
  getMember,
  getPointBreakdown,
  getRecentContributions,
  getLevelInfo,
  upsertMember,
} from "../db.js";

// ── Level Colors ───────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<number, number> = {
  1: 0x95a5a6, // Newcomer    – grey
  2: 0x3498db, // Participant – blue
  3: 0x2ecc71, // Contributor – green
  4: 0x9b59b6, // Regular     – purple
  5: 0xf1c40f, // Champion    – gold
  6: 0xe67e22, // Legend      – orange
  7: 0xe74c3c, // Architect   – red
};

const LEVEL_BADGES: Record<number, string> = {
  1: "⬜ Newcomer",
  2: "🔵 Participant",
  3: "🟢 Contributor",
  4: "🟣 Regular",
  5: "🟡 Champion",
  6: "🟠 Legend",
  7: "🔴 Architect",
};

// ── Contribution Type Emojis ───────────────────────────────────────────────

const TYPE_EMOJIS: Record<string, string> = {
  helpful_conversation: "💬",
  teaching_moment:      "📚",
  tool_share:           "🔧",
  pr_merged:            "🐙",
  pr_review:            "👀",
  bug_report_github:    "🐛",
  peer_vouch:           "🤝",
  event_hosted:         "🎪",
  event_attended:       "🎫",
  reaction_bonus:       "⭐",
  manual_grant:         "🎁",
  streak_bonus:         "🔥",
  project_proposed:     "📋",
  project_approved:     "🚀",
};

function typeEmoji(type: string): string {
  return TYPE_EMOJIS[type] ?? "🏅";
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatTypeName(type: string): string {
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function buildLevelProgressBar(totalPoints: number, blocks = 10): string {
  const { current, next } = getLevelInfo(totalPoints);
  if (!next) return "🟩".repeat(blocks) + " **MAX LEVEL** 🎉";
  const progress = totalPoints - current.min;
  const needed = next.min - current.min;
  const filled = Math.min(blocks, Math.floor((progress / needed) * blocks));
  const pct = Math.round((progress / needed) * 100);
  return (
    "🟩".repeat(filled) +
    "⬜".repeat(blocks - filled) +
    ` **${progress.toLocaleString()}/${needed.toLocaleString()} pts** (${pct}%)`
  );
}

// ── Profile Embed ──────────────────────────────────────────────────────────

function ProfileEmbed({
  discordId,
  username,
  displayName,
  isSelf,
  nonce,
}: {
  discordId: string;
  username: string;
  displayName: string;
  isSelf: boolean;
  nonce: number;
}) {
  // Ensure member exists
  upsertMember(discordId, username, displayName);

  const member = getMember(discordId);
  const breakdown = getPointBreakdown(discordId);
  const recent = getRecentContributions(discordId, 5);

  if (!member) {
    return (
      <Embed color={0xed4245}>
        <EmbedTitle>❌ Member Not Found</EmbedTitle>
        <EmbedField
          name="Not in the system"
          value="This user hasn't earned any contribution points yet."
          inline={false}
        />
      </Embed>
    );
  }

  const totalPoints = member.total_points ?? 0;
  const seasonPoints = member.season_points ?? 0;
  const { current, next } = getLevelInfo(totalPoints);
  const embedColor = LEVEL_COLORS[current.level] ?? 0x95a5a6;
  const levelBadge = LEVEL_BADGES[current.level] ?? `Lv${current.level} ${current.name}`;

  const name = member.display_name || member.username;

  const githubLine = member.github_username
    ? `[\`${member.github_username}\`](https://github.com/${member.github_username}) 🔗`
    : "_Not linked — use `/linkgithub`_";

  // ── Breakdown — 2-column "table" via paired inline fields ──
  const topBreakdown = breakdown.slice(0, 8);
  const typeNames =
    topBreakdown.length > 0
      ? topBreakdown
          .map((b) => `${typeEmoji(b.type)} ${formatTypeName(b.type)}`)
          .join("\n")
      : "_None yet_";
  const typeStats =
    topBreakdown.length > 0
      ? topBreakdown
          .map((b) => `**${b.total_points}** pts × ${b.count}`)
          .join("\n")
      : "\u200b";

  // ── Recent contributions ──
  const recentText =
    recent.length > 0
      ? recent
          .map(
            (c) =>
              `${typeEmoji(c.type)} **+${c.points}** ${formatTypeName(c.type)} *(${formatDate(c.created_at)})*`
          )
          .join("\n")
      : "_No contributions yet_";

  const progressBar = buildLevelProgressBar(totalPoints, 10);

  return (
    <Embed color={embedColor}>
      <EmbedTitle>
        {isSelf ? "🌟 Your Profile" : `👤 ${name}'s Profile`}
      </EmbedTitle>

      {/* ── Header 3-column grid ── */}
      <EmbedField
        name="⭐ Total Points"
        value={`**${totalPoints.toLocaleString()}**`}
        inline={true}
      />
      <EmbedField
        name="🗓️ Season Points"
        value={`**${seasonPoints.toLocaleString()}**`}
        inline={true}
      />
      <EmbedField
        name="🏅 Level"
        value={`**${levelBadge}**\nLv${current.level}`}
        inline={true}
      />

      {/* Visual separator */}
      <EmbedField name="\u200b" value="\u200b" inline={false} />

      {/* Progress bar */}
      <EmbedField
        name={`📈 Progress to ${next ? next.name : "MAX"}`}
        value={progressBar}
        inline={false}
      />

      {/* GitHub */}
      <EmbedField
        name="🐙 GitHub"
        value={githubLine}
        inline={false}
      />

      {/* Visual separator */}
      <EmbedField name="\u200b" value="\u200b" inline={false} />

      {/* ── Breakdown 2-column table ── */}
      <EmbedField
        name="🏅 Contribution Type"
        value={typeNames}
        inline={true}
      />
      <EmbedField
        name="📊 Points × Count"
        value={typeStats}
        inline={true}
      />
      {/* Third column spacer to keep layout */}
      <EmbedField name="\u200b" value="\u200b" inline={true} />

      {/* Visual separator */}
      <EmbedField name="\u200b" value="\u200b" inline={false} />

      {/* Recent contributions */}
      <EmbedField
        name="🕒 Recent 5 Contributions"
        value={recentText}
        inline={false}
      />

      <EmbedFooter
        text={`Member since ${formatDate(member.first_seen_at)} · ${nonce > 0 ? "Refreshed" : "Live data"}`}
      />
    </Embed>
  );
}

// ── Exports ────────────────────────────────────────────────────────────────

export function MyPointsProfile({
  discordId,
  username,
  displayName,
}: {
  discordId: string;
  username: string;
  displayName: string;
}) {
  const [nonce, setNonce] = useState(0);

  return (
    <>
      <ProfileEmbed
        discordId={discordId}
        username={username}
        displayName={displayName}
        isSelf={true}
        nonce={nonce}
      />
      <ActionRow>
        <Button
          label="🔄 Refresh"
          style="Secondary"
          onClick={() => setNonce((n) => n + 1)}
        />
      </ActionRow>
    </>
  );
}

export function UserProfile({
  discordId,
  username,
  displayName,
}: {
  discordId: string;
  username: string;
  displayName: string;
}) {
  const [nonce, setNonce] = useState(0);

  return (
    <>
      <ProfileEmbed
        discordId={discordId}
        username={username}
        displayName={displayName}
        isSelf={false}
        nonce={nonce}
      />
      <ActionRow>
        <Button
          label="🔄 Refresh"
          style="Secondary"
          onClick={() => setNonce((n) => n + 1)}
        />
      </ActionRow>
    </>
  );
}
