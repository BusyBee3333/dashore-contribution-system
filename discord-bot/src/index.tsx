import "dotenv/config";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  Client,
  GatewayIntentBits,
  Events,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import { DiscordJSReact } from "@answeroverflow/discordjs-react";
import React from "react";
import { LeaderboardDashboard } from "./commands/leaderboard.js";
import { MyPointsProfile, UserProfile } from "./commands/profile.js";
import { StatsPanel } from "./commands/stats.js";
import { VouchResult } from "./commands/vouch.js";
import { LinkGitHubResult } from "./commands/linkgithub.js";
import { ProjectsDashboard } from "./commands/projects.js";
import { ProposeProjectResult, buildPollEmbedData } from "./commands/proposeproject.js";
import { ContributionHistory } from "./commands/history.js";
import {
  canPropose,
  canVouch,
  countEligibleVoters,
  proposeProject,
  updateProjectPollMessage,
  castVote,
  getVotes,
  getProject,
  addProjectTask,
  upsertMember,
} from "./db.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is required in .env file");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

const discordReact = new DiscordJSReact(client, {
  maxInstances: 100,
  wrapper: ({ children }) => <>{children}</>,
});

// Public (non-ephemeral) reply using discordjs-react
function publicReply(interaction: ChatInputCommandInteraction, element: React.ReactNode) {
  const renderer = discordReact.createRenderer(
    { type: "interaction", interaction, ephemeral: false },
    element
  );
  discordReact.activateRenderer(renderer);
}

async function handleCommand(interaction: ChatInputCommandInteraction) {
  const { commandName } = interaction;

  switch (commandName) {
    // ── /leaderboard ──────────────────────────────────────────────────────
    case "leaderboard": {
      const type = interaction.options.getString("type") ?? "alltime";
      const initialSeason = type === "season";
      publicReply(interaction, <LeaderboardDashboard initialSeason={initialSeason} />);
      break;
    }

    // ── /mypoints ─────────────────────────────────────────────────────────
    case "mypoints": {
      const { user } = interaction;
      discordReact.ephemeralReply(
        interaction,
        <MyPointsProfile
          discordId={user.id}
          username={user.username}
          displayName={user.displayName}
        />
      );
      break;
    }

    // ── /profile ──────────────────────────────────────────────────────────
    case "profile": {
      const target = interaction.options.getUser("user", true);
      publicReply(
        interaction,
        <UserProfile
          discordId={target.id}
          username={target.username}
          displayName={target.displayName}
        />
      );
      break;
    }

    // ── /history ──────────────────────────────────────────────────────────
    case "history": {
      const target = interaction.options.getUser("user");
      if (target) {
        publicReply(
          interaction,
          <ContributionHistory
            discordId={target.id}
            username={target.username}
            displayName={target.displayName}
            isSelf={false}
          />
        );
      } else {
        const { user } = interaction;
        discordReact.ephemeralReply(
          interaction,
          <ContributionHistory
            discordId={user.id}
            username={user.username}
            displayName={user.displayName}
            isSelf={true}
          />
        );
      }
      break;
    }

    // ── /stats ────────────────────────────────────────────────────────────
    case "stats": {
      publicReply(interaction, <StatsPanel />);
      break;
    }

    // ── /vouch ────────────────────────────────────────────────────────────
    case "vouch": {
      const recipient = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason", true);
      const { user: voter } = interaction;

      // Vouch result is ephemeral (only sender sees success/fail details)
      discordReact.ephemeralReply(
        interaction,
        <VouchResult
          voterId={voter.id}
          voterUsername={voter.username}
          recipientId={recipient.id}
          recipientUsername={recipient.username}
          recipientDisplayName={recipient.displayName}
          reason={reason}
        />
      );

      // Post to #kudos vouch wall (best effort, non-blocking)
      try {
        const vouchCheck = canVouch(voter.id, recipient.id);
        if (vouchCheck.allowed && interaction.guild) {
          const kudosChannel = interaction.guild.channels.cache.find(
            (c: any) => c.name === "kudos" && c.isTextBased()
          );
          if (kudosChannel && "send" in kudosChannel) {
            (kudosChannel as any).send(
              `✊ **<@${voter.id}>** vouched for **<@${recipient.id}>**: *"${reason}"* — **+5 pts**`
            ).catch((err: Error) => console.error("[vouch-wall] failed:", err.message));
          }
        }
      } catch (err) {
        console.error("[vouch-wall] error:", err);
      }
      break;
    }

    // ── /linkgithub ───────────────────────────────────────────────────────
    case "linkgithub": {
      const githubUsername = interaction.options.getString("username", true).trim();
      const { user } = interaction;

      discordReact.ephemeralReply(
        interaction,
        <LinkGitHubResult
          discordId={user.id}
          username={user.username}
          displayName={user.displayName}
          githubUsername={githubUsername}
        />
      );
      break;
    }

    // ── /projects ─────────────────────────────────────────────────────────
    case "projects": {
      const { user } = interaction;
      publicReply(
        interaction,
        <ProjectsDashboard discordId={user.id} />
      );
      break;
    }

    // ── /proposeproject ───────────────────────────────────────────────────
    case "proposeproject": {
      const { user } = interaction;
      const title = interaction.options.getString("title", true).trim();
      const description = interaction.options.getString("description", true).trim();
      const repo = interaction.options.getString("repo")?.trim() ?? null;

      upsertMember(user.id, user.username, user.displayName);

      // 1. Check cooldown
      const cooldownCheck = canPropose(user.id);
      if (!cooldownCheck.allowed) {
        const retryTs = cooldownCheck.retryAfter
          ? `<t:${Math.floor(new Date(cooldownCheck.retryAfter).getTime() / 1000)}:R>`
          : "soon";
        await interaction.reply({
          content: `❌ You're on cooldown from a failed second attempt. You can propose again ${retryTs}.`,
          ephemeral: true,
        });
        break;
      }

      // 2. Count eligible voters
      const totalEligible = countEligibleVoters();
      const pollEndsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);

      // 3. Create project record
      const project = proposeProject({
        title,
        description,
        repoUrl: repo,
        proposedBy: user.id,
        totalEligibleVoters: totalEligible,
        pollEndsAt,
        attempt: 1,
      });

      // 4. Build the public poll embed
      const pollData = buildPollEmbedData({
        title,
        description,
        repoUrl: repo,
        proposedBy: user.id,
        pollEndsAt,
        votesYes: 0,
        votesNo: 0,
        totalEligible,
        finalized: false,
      });

      const pollEmbed = new EmbedBuilder()
        .setTitle(pollData.title)
        .setColor(pollData.color)
        .setFooter({ text: pollData.footer })
        .setTimestamp();

      for (const f of pollData.fields) {
        pollEmbed.addFields({ name: f.name, value: f.value, inline: f.inline ?? false });
      }

      const voteRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`vote_yes_${project.id}`)
          .setLabel("✅ Vote Yes")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`vote_no_${project.id}`)
          .setLabel("❌ Vote No")
          .setStyle(ButtonStyle.Danger),
      );

      // 5. Initial reply = PUBLIC poll (everyone sees it)
      await interaction.reply({
        embeds: [pollEmbed],
        components: [voteRow],
      });
      const pollMsg = await interaction.fetchReply();
      updateProjectPollMessage(project.id, pollMsg.id, interaction.channelId);

      // 6. Private confirmation for the proposer
      await interaction.followUp({
        content: `✅ Your proposal **${title}** is live! Voting ends in 24 hours.`,
        flags: MessageFlags.Ephemeral,
      });
      break;
    }

    // ── /addtask (admin only) ─────────────────────────────────────────────
    case "addtask": {
      const ADMIN_IDS = new Set(["938238002528911400"]);
      if (!ADMIN_IDS.has(interaction.user.id)) {
        await interaction.reply({ content: "admin only, stinky", ephemeral: true });
        break;
      }

      const projectId = interaction.options.getInteger("project_id", true);
      const taskTitle = interaction.options.getString("title", true).trim();
      const taskDesc = interaction.options.getString("description")?.trim() ?? null;
      const taskPoints = interaction.options.getInteger("points") ?? 10;

      const proj = getProject(projectId);
      if (!proj) {
        await interaction.reply({ content: `Project #${projectId} not found.`, ephemeral: true });
        break;
      }

      const task = addProjectTask({
        projectId,
        title: taskTitle,
        description: taskDesc,
        points: taskPoints,
        createdBy: interaction.user.id,
      });

      await interaction.reply({
        content: `✅ Task **#${task.id}: ${task.title}** (${task.points} pts) added to **${proj.title}**.`,
        ephemeral: true,
      });
      break;
    }

    default: {
      await interaction.reply({ content: "Unknown command!", ephemeral: true });
    }
  }
}

client.once(Events.ClientReady, (c) => {
  // Init voice recording + talk-back (non-blocking)
  initVoice().catch((err) => console.error('[voice] init error:', err.message));

  console.log(`\n🏅 Contribution Bot is online!`);
  console.log(`   Logged in as: ${c.user.tag}`);
  console.log(`   Serving ${c.guilds.cache.size} guild(s)`);
  console.log(`\n📋 Available commands:`);
  console.log(`   /leaderboard     — 🏆 Contribution leaderboard (public)`);
  console.log(`   /mypoints        — 🌟 Your own profile (ephemeral)`);
  console.log(`   /profile         — 👤 Another member's profile (public)`);
  console.log(`   /stats           — 📊 System-wide stats (public)`);
  console.log(`   /vouch           — ✊ Vouch for a member (ephemeral result)`);
  console.log(`   /linkgithub      — 🔗 Link GitHub account (ephemeral)`);
  console.log(`   /history         — 📜 Full audit log (public for @user, private for self)`);
  console.log(`   /projects        — 📋 Browse community projects & tasks (public)`);
  console.log(`   /proposeproject  — 🚀 Propose a new community project`);
  console.log(`   /addtask         — ➕ [Admin] Add a task to a project`);
  console.log(`\n✨ Ready!\n`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // ── Slash commands ─────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    try {
      await handleCommand(interaction);
    } catch (err) {
      console.error("Error handling command:", err);
      const msg = "An error occurred while processing this command.";
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: msg, ephemeral: true });
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
      }
    }
    return;
  }

  // ── Vote button interactions ───────────────────────────────────────────
  if (interaction.isButton()) {
    const { customId, user } = interaction;

    const isVoteYes = customId.startsWith("vote_yes_");
    const isVoteNo = customId.startsWith("vote_no_");
    if (!isVoteYes && !isVoteNo) return; // Not our button

    const projectId = parseInt(customId.replace(/^vote_(yes|no)_/, ""), 10);
    if (isNaN(projectId)) return;

    const project = getProject(projectId);
    if (!project) {
      await interaction.reply({ content: "This project no longer exists.", ephemeral: true });
      return;
    }

    if (project.status !== "voting") {
      await interaction.reply({ content: "Voting has already closed for this project.", ephemeral: true });
      return;
    }

    const vote = isVoteYes ? "yes" : "no";
    const result = castVote(projectId, user.id, vote);

    if (result.alreadyVoted) {
      await interaction.reply({ content: "You already voted on this!", ephemeral: true });
      return;
    }

    // Update the poll embed to reflect new counts
    try {
      const votes = getVotes(projectId);
      const updated = getProject(projectId)!;
      const pollData = buildPollEmbedData({
        title: updated.title,
        description: updated.description,
        repoUrl: updated.repo_url,
        proposedBy: updated.proposed_by,
        pollEndsAt: updated.poll_ends_at!,
        votesYes: votes.yes,
        votesNo: votes.no,
        totalEligible: updated.total_eligible_voters,
        finalized: false,
      });

      const pollEmbed = new EmbedBuilder()
        .setTitle(pollData.title)
        .setColor(pollData.color)
        .setFooter({ text: pollData.footer })
        .setTimestamp();

      for (const f of pollData.fields) {
        pollEmbed.addFields({ name: f.name, value: f.value, inline: f.inline ?? false });
      }

      const voteRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`vote_yes_${projectId}`)
          .setLabel("✅ Vote Yes")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`vote_no_${projectId}`)
          .setLabel("❌ Vote No")
          .setStyle(ButtonStyle.Danger),
      );

      await interaction.update({ embeds: [pollEmbed], components: [voteRow] });
    } catch (err) {
      console.error("[vote-button] failed to update embed:", err);
      await interaction.reply({
        content: `Your **${vote === "yes" ? "Yes ✅" : "No ❌"}** vote was recorded! (Yes: ${getVotes(projectId).yes} | No: ${getVotes(projectId).no})`,
        ephemeral: true,
      });
    }
  }
});

console.log("🚀 Starting Contribution Bot...");
// ── Voice Recording + Talk-Back ───────────────────────────────────────────────
// Dynamically import JS modules (they live in ../src/)
const CONTRIB_ROOT = path.resolve(__dirname, '../../');
let voiceRecorder: any = null;
let talkBack: any = null;

async function initVoice() {
  try {
    const { pathToFileURL } = await import('url');
    const { VoiceRecorder } = await import(pathToFileURL(path.join(CONTRIB_ROOT, 'src/voice-recorder.js')).href);
    const { VoiceScorer } = await import(pathToFileURL(path.join(CONTRIB_ROOT, 'src/voice-scorer.js')).href);
    const { VoiceTalkBack } = await import(pathToFileURL(path.join(CONTRIB_ROOT, 'src/voice-talkback.js')).href);
    const { ContributionDB } = await import(pathToFileURL(path.join(CONTRIB_ROOT, 'src/db.js')).href);

    const config = JSON.parse(fs.readFileSync(path.join(CONTRIB_ROOT, 'config/config.json'), 'utf-8'));
    const db = new ContributionDB(path.join(CONTRIB_ROOT, config.contribution_db || 'data/contributions.db')).init();
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;

    const voiceScorer = new VoiceScorer({ db, config, anthropicAuthToken: authToken });

    talkBack = new VoiceTalkBack({
      anthropicAuthToken: authToken,
      ttsVoice: config.voice_transcription?.tts_voice || 'Alex',
      useElevenLabs: !!config.voice_transcription?.elevenlabs_voice_id,
      elevenLabsVoiceId: config.voice_transcription?.elevenlabs_voice_id,
    });

    voiceRecorder = new VoiceRecorder({
      onSegmentTranscribed: async (channelId: string, userId: string, text: string, sessionCtx: any) => {
        return talkBack?.handleSegment(channelId, userId, text, sessionCtx);
      },
      onTranscriptReady: async (sessionData: any) => {
        talkBack?.clearContext(sessionData.channelId);
        voiceScorer.storeTranscript(sessionData, config.guild_id);

        const guild = client.guilds.cache.get(config.guild_id);
        const memberMap: Record<string, any> = {};
        for (const userId of sessionData.participants) {
          try {
            const member = guild?.members.cache.get(userId) || await guild?.members.fetch(userId);
            if (member) {
              memberMap[userId] = {
                username: member.user.username,
                displayName: (member as any).displayName || member.user.username,
                isBot: member.user.bot,
              };
            }
          } catch { /* skip */ }
        }
        await voiceScorer.scoreSession(sessionData, memberMap);
      },
    });

    console.log('[voice] Voice recording + talk-back initialized');
  } catch (err: any) {
    console.error('[voice] Init failed (non-fatal):', err.message);
  }
}

// Voice state listener
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (!voiceRecorder) return;
  try {
    const { joinVoiceChannel } = await import('@discordjs/voice');
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    const channelId = newState.channelId || oldState.channelId;
    if (!channelId) return;

    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== 2) return;

    const humanCount = (channel as any).members?.filter((m: any) => !m.user.bot).size ?? 0;

    if (humanCount >= 2 && !voiceRecorder.isRecording(channelId)) {
      const connection = joinVoiceChannel({
        channelId,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator as any,
        selfDeaf: false,
        selfMute: true,
      });
      await voiceRecorder.startRecording(channel, connection);
      console.log(`[voice] Joined #${(channel as any).name}`);
    }

    if (humanCount < 2 && voiceRecorder.isRecording(channelId)) {
      await voiceRecorder.stopRecording(channelId);
      console.log(`[voice] Left — session ended`);
    }
  } catch (err: any) {
    console.error('[voice] voiceStateUpdate error:', err.message);
  }
});

client.login(BOT_TOKEN);
