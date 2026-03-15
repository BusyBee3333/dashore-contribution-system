import React from "react";
import {
  Embed,
  EmbedField,
  EmbedTitle,
  EmbedFooter,
} from "@answeroverflow/discordjs-react";
import { linkGitHub, upsertMember } from "../db.js";

// ── Colors ─────────────────────────────────────────────────────────────────

const COLOR_SUCCESS = 0x2ecc71; // green
const COLOR_ERROR   = 0xe74c3c; // red

// ── Component ──────────────────────────────────────────────────────────────

export function LinkGitHubResult({
  discordId,
  username,
  displayName,
  githubUsername,
}: {
  discordId: string;
  username: string;
  displayName: string;
  githubUsername: string;
}) {
  // Ensure member record exists before linking
  upsertMember(discordId, username, displayName);

  const success = linkGitHub(discordId, githubUsername);

  if (!success) {
    return (
      <Embed color={COLOR_ERROR}>
        <EmbedTitle>❌ GitHub Link Failed</EmbedTitle>
        <EmbedField
          name="⛔ Reason"
          value="> You don't have a member record yet. Earn some points first, or ask an admin."
          inline={false}
        />
        <EmbedFooter text="Earn points in the community · Then re-run /linkgithub" />
      </Embed>
    );
  }

  const profileUrl = `https://github.com/${githubUsername}`;

  return (
    <Embed color={COLOR_SUCCESS}>
      <EmbedTitle>🐙 GitHub Account Linked!</EmbedTitle>

      {/* 3-column header grid */}
      <EmbedField
        name="👤 Discord"
        value={`<@${discordId}>`}
        inline={true}
      />
      <EmbedField
        name="🐙 GitHub"
        value={`[\`${githubUsername}\`](${profileUrl})`}
        inline={true}
      />
      <EmbedField
        name="✅ Status"
        value="**LINKED**"
        inline={true}
      />

      {/* Visual separator */}
      <EmbedField name="\u200b" value="\u200b" inline={false} />

      {/* What gets tracked */}
      <EmbedField
        name="🔍 What Gets Tracked"
        value={
          "🐙 **PR Merged** · 👀 **PR Review** · 🐛 **Bug Reports**\nAll auto-credited to your profile when detected"
        }
        inline={false}
      />

      <EmbedFooter text="Link is instant · No approval needed · Update anytime with /linkgithub" />
    </Embed>
  );
}
