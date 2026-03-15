import React from "react";
import {
  Embed,
  EmbedField,
  EmbedTitle,
  EmbedFooter,
} from "@answeroverflow/discordjs-react";

// ── Colors ─────────────────────────────────────────────────────────────────

const COLOR_VOTING  = 0xe67e22; // orange — active voting
const COLOR_PASSED  = 0x2ecc71; // green  — approved
const COLOR_FAILED  = 0xe74c3c; // red    — rejected
const COLOR_SUCCESS = 0x2ecc71;
const COLOR_ERROR   = 0xe74c3c;

// ── Helpers ────────────────────────────────────────────────────────────────

function buildVoteBar(yes: number, total: number, blocks = 10): string {
  if (total === 0) return "⬜".repeat(blocks) + " **0 votes**";
  const filled = Math.min(blocks, Math.round((yes / total) * blocks));
  const pct    = Math.round((yes / total) * 100);
  return (
    "🟩".repeat(filled) +
    "⬜".repeat(blocks - filled) +
    ` **${yes}/${total}** (${pct}%)`
  );
}

function buildParticipationBar(voted: number, eligible: number, blocks = 10): string {
  if (eligible === 0) return "⬜".repeat(blocks) + " **0 members**";
  const filled = Math.min(blocks, Math.round((voted / eligible) * blocks));
  const pct    = Math.round((voted / eligible) * 100);
  return (
    "🟦".repeat(filled) +
    "⬜".repeat(blocks - filled) +
    ` **${voted}/${eligible} members** (${pct}%)`
  );
}

// ── Ephemeral Reply to Proposer ────────────────────────────────────────────

export function ProposeProjectResult({
  ok,
  title,
  reason,
}: {
  ok: boolean;
  title?: string;
  reason?: string;
}) {
  if (!ok) {
    return (
      <Embed color={COLOR_ERROR}>
        <EmbedTitle>❌ Cannot Propose Project</EmbedTitle>

        <EmbedField
          name="⛔ Reason"
          value={`> ${reason ?? "Unknown error"}`}
          inline={false}
        />

        <EmbedFooter text="Try again when your cooldown expires" />
      </Embed>
    );
  }

  return (
    <Embed color={COLOR_SUCCESS}>
      <EmbedTitle>🚀 Proposal Submitted!</EmbedTitle>

      <EmbedField
        name="📋 Project Title"
        value={`**${title}**`}
        inline={false}
      />

      <EmbedField
        name="⏰ Voting Window"
        value="**24 hours**"
        inline={true}
      />
      <EmbedField
        name="🎯 Required Threshold"
        value="**60% yes · 50% participation**"
        inline={true}
      />
      <EmbedField name={"u200b"} value={"u200b"} inline={true} />

      <EmbedField
        name="📣 Next Steps"
        value="Your proposal is now live in the voting channel. Share it with the community to get votes!"
        inline={false}
      />

      <EmbedFooter text="Voting ends in 24 hours · Results posted automatically" />
    </Embed>
  );
}

// ── Poll Embed Data Builder (for initial post & live updates) ─────────────

export function buildPollEmbedData(opts: {
  title: string;
  description: string | null;
  repoUrl: string | null;
  proposedBy: string;
  pollEndsAt: string;
  votesYes: number;
  votesNo: number;
  totalEligible: number;
  finalized?: boolean;
  finalStatus?: string;
}) {
  const totalVoted  = opts.votesYes + opts.votesNo;
  const yesTotal    = opts.votesYes + opts.votesNo;
  const yesPct      = yesTotal > 0 ? Math.round((opts.votesYes / yesTotal) * 100) : 0;
  const partPct     = opts.totalEligible > 0
    ? Math.round((totalVoted / opts.totalEligible) * 100)
    : 0;

  // Dynamic color
  const color = opts.finalized
    ? opts.finalStatus === "active"
      ? COLOR_PASSED
      : COLOR_FAILED
    : COLOR_VOTING;

  // Vote progress bar
  const voteBar = buildVoteBar(opts.votesYes, yesTotal, 10);

  // Participation bar
  const partBar = buildParticipationBar(totalVoted, opts.totalEligible, 10);

  // Threshold status indicators
  const yesCheck  = yesPct  >= 60  ? "✅" : yesPct  >= 40 ? "🟡" : "❌";
  const partCheck = partPct >= 50  ? "✅" : partPct >= 30 ? "🟡" : "❌";

  const fields: { name: string; value: string; inline?: boolean }[] = [
    {
      name: "📝 Description",
      value: opts.description || "_No description provided_",
      inline: false,
    },
  ];

  if (opts.repoUrl) {
    fields.push({
      name: "🔗 Repository",
      value: opts.repoUrl,
      inline: true,
    });
  }

  fields.push(
    {
      name: "👤 Proposed By",
      value: `<@${opts.proposedBy}>`,
      inline: true,
    },
    {
      name: "⏰ Voting Ends",
      value: opts.finalized
        ? "**Voting closed**"
        : `<t:${Math.floor(new Date(opts.pollEndsAt).getTime() / 1000)}:R>`,
      inline: true,
    },
    // Separator
    {
      name: "\u200b",
      value: "\u200b",
      inline: false,
    },
    // Vote bar
    {
      name: `🗳️ Yes Votes`,
      value: voteBar,
      inline: false,
    },
    // Participation bar
    {
      name: `👥 Participation`,
      value: partBar,
      inline: false,
    },
    // Separator
    {
      name: "\u200b",
      value: "\u200b",
      inline: false,
    },
    // Threshold requirements — prominent 3-column row
    {
      name: `${yesCheck} Yes Threshold`,
      value: `**${yesPct}% / 60%** needed\n${opts.votesYes} yes · ${opts.votesNo} no`,
      inline: true,
    },
    {
      name: `${partCheck} Participation`,
      value: `**${partPct}% / 50%** needed\n${totalVoted}/${opts.totalEligible} voted`,
      inline: true,
    },
    {
      name: "\u200b",
      value: "\u200b",
      inline: true,
    },
  );

  // Final result block
  if (opts.finalized && opts.finalStatus) {
    const statusLine =
      opts.finalStatus === "active"
        ? "✅ **APPROVED** — This project is now **ACTIVE**! 🚀"
        : opts.finalStatus === "cooldown"
        ? "❌ **REJECTED** — Proposer must wait **7 days** before re-proposing"
        : "❌ **REJECTED** — Proposer may try again immediately";

    fields.push(
      {
        name: "\u200b",
        value: "\u200b",
        inline: false,
      },
      {
        name: "📋 Final Result",
        value: statusLine,
        inline: false,
      }
    );
  }

  return {
    title: `📋 Project Proposal: **${opts.title}**`,
    color,
    fields,
    footer: "Community Project Voting · Needs 60% yes + 50% participation",
  };
}
