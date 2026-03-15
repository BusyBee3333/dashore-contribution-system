import React, { useState } from "react";
import {
  Embed,
  EmbedField,
  EmbedTitle,
  EmbedFooter,
  Button,
  ActionRow,
} from "@answeroverflow/discordjs-react";
import { getLeaderboard, getStats, LEVELS } from "../db.js";

// ── Colors ─────────────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<number, number> = {
  1: 0x95a5a6, // Newcomer    – grey
  2: 0x3498db, // Participant – blue
  3: 0x2ecc71, // Contributor – green
  4: 0x9b59b6, // Regular     – purple
  5: 0xf1c40f, // Champion    – gold
  6: 0xe67e22, // Legend      – orange
  7: 0xe74c3c, // Architect   – red
};

const LEVEL_DOTS: Record<number, string> = {
  1: "⬜",
  2: "🔵",
  3: "🟢",
  4: "🟣",
  5: "🟡",
  6: "🟠",
  7: "🔴",
};

const MEDALS = ["🥇", "🥈", "🥉"];

// ── Helpers ────────────────────────────────────────────────────────────────

function levelBadge(level: number, name: string): string {
  return `${LEVEL_DOTS[level] ?? "⬜"} ${name}`;
}

function levelColorForMember(level: number): string {
  // Returns a decorative colored circle for the name display
  return LEVEL_DOTS[level] ?? "⬜";
}

// ── Component ──────────────────────────────────────────────────────────────

export function LeaderboardDashboard({ initialSeason = false }: { initialSeason?: boolean }) {
  const [season, setSeason] = useState(initialSeason);

  const members = getLeaderboard(season, 15);
  const stats = getStats();

  const totalPts = stats.totalPoints;
  const memberCount = stats.members;
  const seasonName = stats.activeSeason ? stats.activeSeason.name : "No Active Season";

  // All-time → gold; season → blurple
  const embedColor = season ? 0x5865f2 : 0xf1c40f;

  const top3 = members.slice(0, 3);
  const rest = members.slice(3);

  const restText =
    rest.length > 0
      ? rest
          .map((m, i) => {
            const rank = i + 4;
            const name = m.display_name || m.username;
            const pts = season ? m.season_points : m.total_points;
            const dot = levelColorForMember(m.level);
            return `\`${rank.toString().padStart(2, " ")}\` ${dot} **${name}** — ${pts.toLocaleString()} pts *(${m.level_name})*`;
          })
          .join("\n")
      : "_No other contributors yet_";

  const emptyMsg = "No contributions recorded yet — be the first! 🚀";

  return (
    <>
      <Embed color={embedColor}>
        <EmbedTitle>
          {season ? "🗓️" : "🏆"} Contribution Leaderboard —{" "}
          {season ? "This Season" : "All Time"}
        </EmbedTitle>

        {/* Summary stat row */}
        <EmbedField
          name="📊 Overview"
          value={`**Members:** ${memberCount.toLocaleString()} • **Total Pts:** ${totalPts.toLocaleString()} • **Season:** ${seasonName}`}
          inline={false}
        />

        {/* Visual separator */}
        <EmbedField name="\u200b" value="\u200b" inline={false} />

        {/* ── Top 3 Podium (3-column inline grid) ── */}
        {top3.length === 0 ? (
          <EmbedField name="😶 Empty" value={emptyMsg} inline={false} />
        ) : (
          <>
            {top3.map((m, i) => {
              const name = m.display_name || m.username;
              const pts = season ? m.season_points : m.total_points;
              return (
                <EmbedField
                  key={m.discord_id}
                  name={`${MEDALS[i]} ${name}`}
                  value={`**${pts.toLocaleString()}** pts\n${levelBadge(m.level, m.level_name)}`}
                  inline={true}
                />
              );
            })}
            {/* Pad to 3 columns so Discord renders the row cleanly */}
            {top3.length === 1 && (
              <>
                <EmbedField name="\u200b" value="\u200b" inline={true} />
                <EmbedField name="\u200b" value="\u200b" inline={true} />
              </>
            )}
            {top3.length === 2 && (
              <EmbedField name="\u200b" value="\u200b" inline={true} />
            )}
          </>
        )}

        {/* ── Rankings 4–15 ── */}
        {rest.length > 0 && (
          <>
            <EmbedField name="\u200b" value="\u200b" inline={false} />
            <EmbedField
              name={`📋 Rankings 4–${3 + rest.length}`}
              value={restText}
              inline={false}
            />
          </>
        )}

        {/* Visual separator before legend */}
        <EmbedField name="\u200b" value="\u200b" inline={false} />

        {/* Level guide — compact inline columns */}
        <EmbedField
          name="🔵 Lv1–3"
          value={LEVELS.slice(0, 3)
            .map((l) => `${levelBadge(l.level, l.name)} · ${l.min.toLocaleString()}+ pts`)
            .join("\n")}
          inline={true}
        />
        <EmbedField
          name="🟡 Lv4–5"
          value={LEVELS.slice(3, 5)
            .map((l) => `${levelBadge(l.level, l.name)} · ${l.min.toLocaleString()}+ pts`)
            .join("\n")}
          inline={true}
        />
        <EmbedField
          name="🔴 Lv6–7"
          value={LEVELS.slice(5)
            .map((l) => `${levelBadge(l.level, l.name)} · ${l.min.toLocaleString()}+ pts`)
            .join("\n")}
          inline={true}
        />

        <EmbedFooter
          text={`Showing top ${members.length} contributor${members.length !== 1 ? "s" : ""} · Use buttons to switch views`}
        />
      </Embed>

      <ActionRow>
        <Button
          label="🌐 All Time"
          style={season ? "Secondary" : "Primary"}
          onClick={() => setSeason(false)}
          disabled={!season}
        />
        <Button
          label="🗓️ This Season"
          style={season ? "Primary" : "Secondary"}
          onClick={() => setSeason(true)}
          disabled={season}
        />
      </ActionRow>
    </>
  );
}
