import React, { useState } from "react";
import {
  Embed,
  EmbedField,
  EmbedTitle,
  EmbedFooter,
  Button,
  ActionRow,
} from "@answeroverflow/discordjs-react";
import { getMember, getContributionHistory, getLevelInfo, upsertMember } from "../db.js";

// ── Level Colors ───────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<number, number> = {
  1: 0x95a5a6,
  2: 0x3498db,
  3: 0x2ecc71,
  4: 0x9b59b6,
  5: 0xf1c40f,
  6: 0xe67e22,
  7: 0xe74c3c,
};

// ── Type Emojis ────────────────────────────────────────────────────────────

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

function formatTypeName(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr + (dateStr.endsWith("Z") ? "" : "Z")).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr.slice(0, 10);
  }
}

/** Extract a short human-readable note from the JSON evidence field */
function parseEvidence(evidence: string | null): string {
  if (!evidence) return "";
  try {
    const obj = JSON.parse(evidence);

    // Vouch: { vouched_by, reason }
    if (obj.reason && typeof obj.reason === "string") {
      const snip = obj.reason.slice(0, 60);
      return snip.length < obj.reason.length ? `"${snip}…"` : `"${snip}"`;
    }

    // GitHub: { pr_number, repo, title }
    if (obj.pr_number) {
      const title = obj.title ? ` — ${String(obj.title).slice(0, 40)}` : "";
      return `PR #${obj.pr_number}${obj.repo ? ` (${obj.repo})` : ""}${title}`;
    }

    // project_approved: { project_id, title }
    if (obj.title && typeof obj.title === "string") {
      return `"${String(obj.title).slice(0, 50)}"`;
    }

    // channel-based: { channel }
    if (obj.channel) return `#${obj.channel}`;

    // Fallback: first string value
    const firstStr = Object.values(obj).find((v) => typeof v === "string");
    if (firstStr) return String(firstStr).slice(0, 60);
  } catch {
    // Not JSON — just return raw string trimmed
    return String(evidence).slice(0, 60);
  }
  return "";
}

const PAGE_SIZE = 10;

// ── History Embed ──────────────────────────────────────────────────────────

export function ContributionHistory({
  discordId,
  username,
  displayName,
  isSelf,
}: {
  discordId: string;
  username: string;
  displayName: string;
  isSelf: boolean;
}) {
  const [page, setPage] = useState(0);

  // Ensure member record exists
  upsertMember(discordId, username, displayName);

  const member = getMember(discordId);
  const { rows, total } = getContributionHistory(discordId, page, PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const memberName = member?.display_name || member?.username || username;
  const totalPts = member?.total_points ?? 0;
  const { current } = getLevelInfo(totalPts);
  const embedColor = LEVEL_COLORS[current.level] ?? 0x95a5a6;

  // ── Build rows ──────────────────────────────────────────────────────────
  let historyText: string;
  if (rows.length === 0) {
    historyText = "_No contributions recorded yet._";
  } else {
    historyText = rows
      .map((c) => {
        const emoji = typeEmoji(c.type);
        const name = formatTypeName(c.type);
        const date = formatDate(c.created_at);
        const evidence = parseEvidence(c.evidence);
        const evidencePart = evidence ? ` — ${evidence}` : "";
        const channel = c.channel_name ? ` [#${c.channel_name}]` : "";
        return `\`${date}\` ${emoji} **+${c.points}** ${name}${channel}${evidencePart}`;
      })
      .join("\n");
  }

  const title = isSelf ? "📜 Your Contribution History" : `📜 ${memberName}'s Contribution History`;

  return (
    <>
      <Embed color={embedColor}>
        <EmbedTitle>{title}</EmbedTitle>

        <EmbedField
          name="📊 Stats"
          value={`**${total}** total events • **${totalPts.toLocaleString()}** pts all time`}
          inline={false}
        />

        <EmbedField name="\u200b" value="\u200b" inline={false} />

        <EmbedField
          name={`🕒 Events (page ${page + 1} / ${totalPages})`}
          value={historyText}
          inline={false}
        />

        <EmbedFooter
          text={`Showing ${rows.length === 0 ? 0 : page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total} · ${totalPages} page${totalPages !== 1 ? "s" : ""}`}
        />
      </Embed>

      <ActionRow>
        <Button
          label="◀ Prev"
          style="Secondary"
          disabled={page === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
        />
        <Button
          label={`${page + 1} / ${totalPages}`}
          style="Secondary"
          disabled={true}
          onClick={() => {}}
        />
        <Button
          label="Next ▶"
          style="Secondary"
          disabled={page >= totalPages - 1}
          onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
        />
      </ActionRow>
    </>
  );
}
