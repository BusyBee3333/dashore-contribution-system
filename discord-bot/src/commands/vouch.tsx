import React from "react";
import {
  Embed,
  EmbedField,
  EmbedTitle,
  EmbedFooter,
} from "@answeroverflow/discordjs-react";
import { canVouch, addVouch, upsertMember, getMember } from "../db.js";

// ── Colors ─────────────────────────────────────────────────────────────────

const SUCCESS_COLOR = 0x2ecc71; // bright green
const ERROR_COLOR   = 0xe74c3c; // red

const VOUCH_POINTS = 5;

// ── Level Colors for recipient badge ──────────────────────────────────────

const LEVEL_DOTS: Record<number, string> = {
  1: "⬜",
  2: "🔵",
  3: "🟢",
  4: "🟣",
  5: "🟡",
  6: "🟠",
  7: "🔴",
};

// ── Helpers ────────────────────────────────────────────────────────────────

function levelDot(level: number): string {
  return LEVEL_DOTS[level] ?? "⬜";
}

// ── Component ──────────────────────────────────────────────────────────────

export function VouchResult({
  voterId,
  voterUsername,
  recipientId,
  recipientUsername,
  recipientDisplayName,
  reason,
}: {
  voterId: string;
  voterUsername: string;
  recipientId: string;
  recipientUsername: string;
  recipientDisplayName: string;
  reason: string;
}) {
  // Ensure both members exist
  upsertMember(voterId, voterUsername, voterUsername);
  upsertMember(recipientId, recipientUsername, recipientDisplayName);

  const check = canVouch(voterId, recipientId);

  if (!check.allowed) {
    return (
      <Embed color={ERROR_COLOR}>
        <EmbedTitle>❌ Vouch Failed</EmbedTitle>

        <EmbedField
          name="⛔ Reason"
          value={`> ${check.reason ?? "Unknown error"}`}
          inline={false}
        />

        <EmbedField
          name="👤 You Tried To Vouch"
          value={`**${recipientDisplayName || recipientUsername}** (<@${recipientId}>)`}
          inline={true}
        />
        <EmbedField
          name="🚦 Rules"
          value="**3** vouches/day total\n**1** vouch/week per person"
          inline={true}
        />
        <EmbedField name="\u200b" value="\u200b" inline={true} />

        <EmbedFooter text="Try again when the restriction lifts" />
      </Embed>
    );
  }

  // Perform the vouch
  addVouch(voterId, recipientId, reason, VOUCH_POINTS);

  // Get updated recipient stats
  const recipient = getMember(recipientId);
  const updatedTotal  = recipient?.total_points  ?? VOUCH_POINTS;
  const updatedSeason = recipient?.season_points ?? VOUCH_POINTS;
  const recipientLevel    = recipient?.level     ?? 1;
  const recipientLvName   = recipient?.level_name ?? "Newcomer";

  const recipientName = recipientDisplayName || recipientUsername;
  const voterName     = voterUsername;

  return (
    <Embed color={SUCCESS_COLOR}>
      <EmbedTitle>🎉 Vouch Recorded!</EmbedTitle>

      {/* ── Recipient header ── */}
      <EmbedField
        name="✊ Vouched For"
        value={`**${recipientName}** (<@${recipientId}>)\n${levelDot(recipientLevel)} ${recipientLvName}`}
        inline={true}
      />
      <EmbedField
        name="⭐ Points Awarded"
        value={`**+${VOUCH_POINTS} pts** to recipient`}
        inline={true}
      />
      <EmbedField
        name="📊 Their New Total"
        value={`**${updatedTotal.toLocaleString()}** pts total\n**${updatedSeason.toLocaleString()}** pts this season`}
        inline={true}
      />

      {/* Visual separator */}
      <EmbedField name="\u200b" value="\u200b" inline={false} />

      {/* Reason block */}
      <EmbedField
        name="💬 Reason"
        value={`> ${reason}`}
        inline={false}
      />

      <EmbedFooter
        text={`Vouched by ${voterName} · 3 vouches/day · 1 per person/week · Anti-gaming enforced`}
      />
    </Embed>
  );
}
