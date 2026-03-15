/**
 * Contribution System Discord Bot
 * 
 * Slash commands for leaderboard, points, vouching, and project management.
 */

import { Client, GatewayIntentBits, Partials, SlashCommandBuilder, REST, Routes, EmbedBuilder } from 'discord.js';
import { ContributionDB } from './db.js';
import { EventTracker } from './events.js';
import { syncMemberRole, syncAllRoles } from './roles.js';
import { AuditLog } from './audit.js';
import { attachGithubSuggester } from './github-suggest.js';
import { ReactionPoints, LevelUpAnnouncer, FirstContributionCeremony, VouchWall, HelpWantedPinger } from './features.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──── Config ────

const configPath = resolve(__dirname, '../config/config.json');
let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf-8'));
} catch {
  console.error('Missing config/config.json — copy from config.example.json and fill in');
  process.exit(1);
}

const TOKEN = process.env[config.discord_token_env || 'DISCORD_BOT_TOKEN'];
if (!TOKEN) {
  console.error(`Set ${config.discord_token_env || 'DISCORD_BOT_TOKEN'} env var`);
  process.exit(1);
}

const db = new ContributionDB(resolve(__dirname, '..', config.contribution_db || './data/contributions.db')).init();
const GUILD_ID = config.guild_id;
const audit = new AuditLog(config);

// ──── Feature Modules ────

const reactionPoints = new ReactionPoints(db, config, audit);
const levelUpAnnouncer = new LevelUpAnnouncer(db, config);
const firstContribution = new FirstContributionCeremony(db, config);
const vouchWall = new VouchWall(config);
// HelpWantedPinger needs client, initialized after client.once('ready')
let helpWantedPinger = null;

/**
 * Post-points hook: check for first contribution, level-up announcements, and role sync.
 * Call after any points are awarded.
 */
async function postPointsHook(guild, memberId, { isFirstContribution = false } = {}) {
  try {
    // First contribution ceremony
    if (isFirstContribution) {
      firstContribution.maybeSendWelcome(client, memberId).catch(err =>
        console.error('[post-points] first contribution DM error:', err.message)
      );
    }

    // Level-up announcements
    if (guild) {
      levelUpAnnouncer.announce(guild, memberId).catch(err =>
        console.error('[post-points] level-up announce error:', err.message)
      );

      // Role sync
      syncMemberRole(guild, memberId, db, config).catch(() => {});
    }
  } catch (err) {
    console.error('[post-points] hook error:', err.message);
  }
}

// ──── Slash Command Definitions ────

const commands = [
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the contribution leaderboard')
    .addStringOption(opt =>
      opt.setName('type').setDescription('Leaderboard type')
        .addChoices(
          { name: 'All Time', value: 'alltime' },
          { name: 'This Season', value: 'season' },
        )
    ),

  new SlashCommandBuilder()
    .setName('mypoints')
    .setDescription('View your contribution points and breakdown'),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('View a member\'s contribution profile')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Member to view').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('vouch')
    .setDescription('Vouch for a member\'s contribution')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Member to vouch for').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('reason').setDescription('Why are you vouching?').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('View contribution system stats'),

  new SlashCommandBuilder()
    .setName('project')
    .setDescription('Community project management')
    .addSubcommand(sub =>
      sub.setName('propose')
        .setDescription('Propose a community project')
        .addStringOption(opt => opt.setName('name').setDescription('Project name').setRequired(true))
        .addStringOption(opt => opt.setName('repo').setDescription('GitHub repo URL'))
        .addStringOption(opt => opt.setName('description').setDescription('Project description'))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List community projects')
    ),

  new SlashCommandBuilder()
    .setName('linkgithub')
    .setDescription('Link your GitHub username (with verification)')
    .addStringOption(opt =>
      opt.setName('username').setDescription('Your GitHub username').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('verify').setDescription('Verification method')
        .addChoices(
          { name: 'GitHub bio (add your Discord tag to your bio)', value: 'bio' },
          { name: 'Trust me (admin approval required)', value: 'trust' },
        )
    ),

  new SlashCommandBuilder()
    .setName('whoisgithub')
    .setDescription('Look up who a GitHub username is linked to')
    .addStringOption(opt =>
      opt.setName('username').setDescription('GitHub username to look up').setRequired(true)
    ),

  // Admin commands
  new SlashCommandBuilder()
    .setName('grant')
    .setDescription('[Admin] Grant points to a member')
    .addUserOption(opt => opt.setName('user').setDescription('Member').setRequired(true))
    .addIntegerOption(opt => opt.setName('points').setDescription('Points to grant').setRequired(true))
    .addStringOption(opt => opt.setName('reason').setDescription('Reason').setRequired(true)),

  new SlashCommandBuilder()
    .setName('newseason')
    .setDescription('[Admin] Start a new season')
    .addStringOption(opt => opt.setName('name').setDescription('Season name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('challenge')
    .setDescription('Challenges and bounties')
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('[Admin] Create a new challenge/bounty')
        .addStringOption(opt => opt.setName('title').setDescription('Challenge title').setRequired(true))
        .addIntegerOption(opt => opt.setName('points').setDescription('Points awarded on completion').setRequired(true))
        .addStringOption(opt => opt.setName('description').setDescription('What needs to be done'))
        .addStringOption(opt => opt.setName('proof').setDescription('What proof is required'))
        .addStringOption(opt => opt.setName('deadline').setDescription('Deadline (YYYY-MM-DD)'))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List challenges')
        .addStringOption(opt =>
          opt.setName('status').setDescription('Filter by status')
            .addChoices(
              { name: 'Open', value: 'open' },
              { name: 'Claimed', value: 'claimed' },
              { name: 'Completed', value: 'completed' },
              { name: 'All', value: 'all' },
            )
        )
    )
    .addSubcommand(sub =>
      sub.setName('claim')
        .setDescription('Claim a challenge')
        .addIntegerOption(opt => opt.setName('id').setDescription('Challenge ID').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('complete')
        .setDescription('[Admin] Mark a challenge as completed and award points')
        .addIntegerOption(opt => opt.setName('id').setDescription('Challenge ID').setRequired(true))
    ),
];

// ──── Level Emojis ────

const LEVEL_EMOJI = {
  1: '(._. )',
  2: '( ._.)',
  3: '(o_o )',
  4: '( ^_^)',
  5: '(*_* )',
  6: '(!!!)',
  7: '(GOD)',
};

// ──── Bot Setup ────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
  partials: [
    Partials.Message,
    Partials.Reaction,
    Partials.User,
  ],
});

// ──── Event Tracker ────
const eventTracker = new EventTracker(db, config, config.points);

client.once('ready', async () => {
  console.log(`[bot] logged in as ${client.user.tag}`);

  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
      body: commands.map(c => c.toJSON()),
    });
    console.log('[bot] slash commands registered');
  } catch (err) {
    console.error('[bot] failed to register commands:', err);
  }

  // Ensure all guild members are in contribution DB
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.fetch();
    for (const [id, member] of members) {
      if (!member.user.bot) {
        db.upsertMember(id, member.user.username, member.displayName);
      }
    }
    console.log(`[bot] synced ${members.filter(m => !m.user.bot).size} members`);

    // Sync Discord roles on startup (non-blocking)
    syncAllRoles(guild, db, config).catch(err =>
      console.error('[bot] role sync error:', err.message)
    );
  } catch (err) {
    console.error('[bot] member sync error:', err.message);
  }

  // Attach GitHub username auto-suggester
  attachGithubSuggester(client, db, config);

  // Start Help Wanted Auto-Ping scanner
  helpWantedPinger = new HelpWantedPinger(db, config, client);
  helpWantedPinger.start();
});

// ──── Command Handlers ────

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'leaderboard': return await handleLeaderboard(interaction);
      case 'mypoints': return await handleMyPoints(interaction);
      case 'profile': return await handleProfile(interaction);
      case 'vouch': return await handleVouch(interaction);
      case 'stats': return await handleStats(interaction);
      case 'project': return await handleProject(interaction);
      case 'linkgithub': return await handleLinkGithub(interaction);
      case 'whoisgithub': return await handleWhoIsGithub(interaction);
      case 'grant': return await handleGrant(interaction);
      case 'newseason': return await handleNewSeason(interaction);
      case 'challenge': return await handleChallenge(interaction);
      default: return await interaction.reply({ content: 'Unknown command', ephemeral: true });
    }
  } catch (err) {
    console.error(`[bot] command error (${interaction.commandName}):`, err);
    const content = 'something broke (wow okay rude). try again?';
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  }
});

// ──── /leaderboard ────

async function handleLeaderboard(interaction) {
  const type = interaction.options.getString('type') || 'alltime';
  const isSeason = type === 'season';
  const season = isSeason ? db.getActiveSeason() : null;

  const leaders = db.getLeaderboard({ limit: 15, season: isSeason });

  if (!leaders.length) {
    return interaction.reply({ content: 'No contributions yet! Be the first (._. )', ephemeral: false });
  }

  const medals = ['(1)', '(2)', '(3)'];
  const lines = leaders.map((m, i) => {
    const rank = medals[i] || `${i + 1}.`;
    const pts = isSeason ? m.season_points : m.total_points;
    const name = m.display_name || m.username;
    const lvl = LEVEL_EMOJI[m.level] || '';
    return `${rank} **${name}** — ${pts} pts ${lvl} Lv.${m.level} ${m.level_name}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(isSeason ? `Leaderboard — ${season?.name || 'Current Season'}` : 'Leaderboard — All Time')
    .setDescription(lines.join('\n'))
    .setColor(0x5865F2)
    .setFooter({ text: `${leaders.length} contributors | /mypoints to see yours` })
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

// ──── /mypoints ────

async function handleMyPoints(interaction) {
  const userId = interaction.user.id;
  db.upsertMember(userId, interaction.user.username, interaction.member?.displayName);
  
  const member = db.getMember(userId);
  const breakdown = db.getPointBreakdown(userId);
  const recent = db.getContributions(userId, { limit: 5 });

  const breakdownLines = breakdown.length
    ? breakdown.map(b => `**${b.type.replace(/_/g, ' ')}**: ${b.total_points} pts (${b.count}x)`).join('\n')
    : '_no contributions yet_';

  const recentLines = recent.length
    ? recent.map(c => {
        const date = c.created_at.slice(0, 10);
        return `\`${date}\` +${c.points} — ${c.type.replace(/_/g, ' ')}`;
      }).join('\n')
    : '_nothing recent_';

  const embed = new EmbedBuilder()
    .setTitle(`${member.display_name || member.username}'s Points`)
    .addFields(
      { name: 'Total', value: `**${member.total_points}** pts`, inline: true },
      { name: 'Season', value: `**${member.season_points}** pts`, inline: true },
      { name: 'Level', value: `${LEVEL_EMOJI[member.level] || ''} **${member.level_name}** (Lv.${member.level})`, inline: true },
      { name: 'Breakdown', value: breakdownLines },
      { name: 'Recent', value: recentLines },
    )
    .setColor(0x57F287)
    .setTimestamp();

  if (member.github_username) {
    embed.addFields({ name: 'GitHub', value: `[${member.github_username}](https://github.com/${member.github_username})`, inline: true });
  }

  return interaction.reply({ embeds: [embed] });
}

// ──── /profile @user ────

async function handleProfile(interaction) {
  const target = interaction.options.getUser('user');
  if (target.bot) return interaction.reply({ content: 'bots don\'t have profiles, stinky', ephemeral: true });

  db.upsertMember(target.id, target.username, target.displayName);
  const member = db.getMember(target.id);
  const breakdown = db.getPointBreakdown(target.id);

  const breakdownLines = breakdown.length
    ? breakdown.map(b => `**${b.type.replace(/_/g, ' ')}**: ${b.total_points} pts (${b.count}x)`).join('\n')
    : '_no contributions yet_';

  const embed = new EmbedBuilder()
    .setTitle(`${member.display_name || member.username}'s Profile`)
    .addFields(
      { name: 'Total Points', value: `**${member.total_points}**`, inline: true },
      { name: 'Level', value: `${LEVEL_EMOJI[member.level] || ''} **${member.level_name}**`, inline: true },
      { name: 'Breakdown', value: breakdownLines },
    )
    .setColor(0xFEE75C)
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

// ──── /vouch @user reason ────

async function handleVouch(interaction) {
  const target = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason');
  const voterId = interaction.user.id;

  if (target.bot) return interaction.reply({ content: 'can\'t vouch for a bot ಠ_ಠ', ephemeral: true });

  db.upsertMember(voterId, interaction.user.username, interaction.member?.displayName);
  db.upsertMember(target.id, target.username, target.displayName);

  const check = db.canVouch(voterId, target.id);
  if (!check.allowed) {
    return interaction.reply({ content: check.reason, ephemeral: true });
  }

  // Check if this is recipient's first contribution
  const isFirstContribution = db.getContributionCount(target.id) === 0 && !db.isFirstPointsNotified(target.id);

  db.addVouch(voterId, target.id, reason, config.points.peer_vouch.base);

  // Audit log
  audit.log({ points: config.points.peer_vouch.base, username: target.username, type: 'peer_vouch', extra: reason });

  // Post-points hook (level-up, first contribution, role sync)
  if (interaction.guild) {
    postPointsHook(interaction.guild, target.id, { isFirstContribution }).catch(() => {});
  }

  // Vouch Wall — post in #kudos
  if (interaction.guild) {
    vouchWall.postVouch(
      interaction.guild,
      voterId,
      interaction.user.username,
      target.id,
      target.username,
      reason,
      config.points.peer_vouch.base
    ).catch(err => console.error('[vouch-wall] error:', err.message));
  }

  const embed = new EmbedBuilder()
    .setTitle('Vouch Recorded!')
    .setDescription(`**${interaction.user.username}** vouched for **${target.username}**`)
    .addFields(
      { name: 'Reason', value: reason },
      { name: 'Points', value: `+${config.points.peer_vouch.base}`, inline: true },
    )
    .setColor(0x57F287)
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ──── /stats ────

async function handleStats(interaction) {
  const stats = db.getStats();

  const embed = new EmbedBuilder()
    .setTitle('Contribution System Stats')
    .addFields(
      { name: 'Active Contributors', value: `${stats.members}`, inline: true },
      { name: 'Total Contributions', value: `${stats.contributions}`, inline: true },
      { name: 'Total Points Awarded', value: `${stats.totalPoints}`, inline: true },
      { name: 'Peer Vouches', value: `${stats.vouches}`, inline: true },
      { name: 'AI Analysis Runs', value: `${stats.analysisRuns}`, inline: true },
      { name: 'Active Season', value: stats.activeSeason?.name || 'None', inline: true },
    )
    .setColor(0x5865F2)
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

// ──── /project ────

async function handleProject(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'propose') {
    const name = interaction.options.getString('name');
    const repo = interaction.options.getString('repo') || null;
    const desc = interaction.options.getString('description') || null;

    db.upsertMember(interaction.user.id, interaction.user.username, interaction.member?.displayName);
    db.proposeProject(name, desc, repo, interaction.user.id);

    return interaction.reply({
      content: `Project **"${name}"** proposed! A mod will review it. ${repo ? `\nRepo: ${repo}` : ''}`,
    });
  }

  if (sub === 'list') {
    const projects = db.getProjects();
    if (!projects.length) return interaction.reply({ content: 'No community projects yet. `/project propose` to start one!', ephemeral: true });

    const lines = projects.map(p => {
      const status = p.status === 'active' ? '[ACTIVE]' : p.status === 'proposed' ? '[PENDING]' : `[${p.status.toUpperCase()}]`;
      return `${status} **${p.name}**${p.repo_url ? ` — [repo](${p.repo_url})` : ''}`;
    });

    const embed = new EmbedBuilder()
      .setTitle('Community Projects')
      .setDescription(lines.join('\n'))
      .setColor(0xEB459E)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
}

// ──── /linkgithub ────

async function handleLinkGithub(interaction) {
  const username = interaction.options.getString('username').replace(/^@/, '');
  const method = interaction.options.getString('verify') || 'bio';
  const userId = interaction.user.id;

  db.upsertMember(userId, interaction.user.username, interaction.member?.displayName);

  // Check if this GitHub username is already claimed
  const existing = db.getMemberByGithub(username);
  if (existing && existing.discord_id !== userId) {
    return interaction.reply({
      content: `GitHub **${username}** is already linked to another member. If this is wrong, ask an admin to fix it.`,
      ephemeral: true,
    });
  }

  if (method === 'bio') {
    // Verify: check if their GitHub bio or name contains their Discord username/ID
    await interaction.deferReply({ ephemeral: true });

    try {
      const { spawnSync } = await import('child_process');
      const result = spawnSync('gh', ['api', `users/${username}`, '--jq', '.bio + " " + .name + " " + .twitter_username'], {
        encoding: 'utf-8', timeout: 10000,
      });

      const bioText = (result.stdout || '').toLowerCase();
      const discordTag = interaction.user.username.toLowerCase();
      const discordId = userId;

      const verified = bioText.includes(discordTag) || bioText.includes(discordId) || bioText.includes('dashore');

      if (!verified) {
        return interaction.editReply({
          content: `Could not verify **${username}** is yours.\n\n` +
            `**To verify**, add one of these to your [GitHub bio](https://github.com/settings/profile):\n` +
            `- Your Discord username: \`${interaction.user.username}\`\n` +
            `- Your Discord ID: \`${userId}\`\n` +
            `- The word: \`dashore\`\n\n` +
            `Then run \`/linkgithub ${username}\` again. Or use \`verify: Trust me\` for admin approval.`,
        });
      }

      // Verified!
      db.linkGitHub(userId, username);
      return interaction.editReply({
        content: `Verified and linked GitHub: **${username}** (☞ﾟヮﾟ)☞\nYour PRs, reviews, and issues now count toward your score!`,
      });

    } catch (err) {
      console.error('[linkgithub] verification error:', err.message);
      return interaction.editReply({
        content: `Couldn't reach GitHub to verify. Try again or use \`verify: Trust me\` for admin approval.`,
      });
    }
  }

  if (method === 'trust') {
    // Store as pending — admin needs to approve
    db.linkGitHub(userId, username);
    db.addPendingClaim(userId, username);

    return interaction.reply({
      content: `Claim submitted for GitHub: **${username}**\n` +
        `An admin will verify it. In the meantime, your contributions are being tracked!\n\n` +
        `_Want instant verification? Add your Discord username to your [GitHub bio](https://github.com/settings/profile) and use \`verify: GitHub bio\`._`,
      ephemeral: true,
    });
  }

  // Default fallback — just link it (backward compat)
  db.linkGitHub(userId, username);
  return interaction.reply({
    content: `Linked GitHub: **${username}** — your PRs and issues will now count toward your score (☞ﾟヮﾟ)☞`,
    ephemeral: true,
  });
}

// ──── /whoisgithub ────

async function handleWhoIsGithub(interaction) {
  const username = interaction.options.getString('username').replace(/^@/, '');
  const member = db.getMemberByGithub(username);

  if (!member) {
    return interaction.reply({
      content: `No one has claimed GitHub **${username}** yet. Use \`/linkgithub ${username}\` to claim it!`,
      ephemeral: true,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(`GitHub: ${username}`)
    .setURL(`https://github.com/${username}`)
    .addFields(
      { name: 'Discord', value: `<@${member.discord_id}>`, inline: true },
      { name: 'Points', value: `${member.total_points}`, inline: true },
      { name: 'Level', value: `${LEVEL_EMOJI[member.level] || ''} ${member.level_name}`, inline: true },
    )
    .setColor(0x57F287)
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ──── /grant (admin) ────

async function handleGrant(interaction) {
  // Simple admin check — only Jake or admins
  const ADMIN_IDS = new Set(['938238002528911400']);
  if (!ADMIN_IDS.has(interaction.user.id)) {
    return interaction.reply({ content: 'admin only, stinky', ephemeral: true });
  }

  const target = interaction.options.getUser('user');
  const points = interaction.options.getInteger('points');
  const reason = interaction.options.getString('reason');

  db.upsertMember(target.id, target.username, target.displayName);

  // Check if first contribution
  const isFirstContribution = db.getContributionCount(target.id) === 0 && !db.isFirstPointsNotified(target.id);

  db.addContribution({
    memberId: target.id,
    type: 'manual_grant',
    points,
    evidence: { reason, granted_by: interaction.user.id },
    source: 'manual',
  });

  // Audit log
  audit.log({ points, username: target.username, type: 'manual_grant', extra: reason });

  // Post-points hook (level-up, first contribution, role sync)
  if (interaction.guild) {
    postPointsHook(interaction.guild, target.id, { isFirstContribution }).catch(() => {});
  }

  return interaction.reply({
    content: `Granted **+${points} pts** to **${target.username}** — ${reason}`,
  });
}

// ──── /newseason (admin) ────

async function handleNewSeason(interaction) {
  const ADMIN_IDS = new Set(['938238002528911400']);
  if (!ADMIN_IDS.has(interaction.user.id)) {
    return interaction.reply({ content: 'admin only', ephemeral: true });
  }

  const name = interaction.options.getString('name');
  const season = db.startSeason(name);

  return interaction.reply({
    content: `New season started: **${season.name}** — all season points reset! Let's gooo ᕕ( ᐛ )ᕗ`,
  });
}

// ──── /challenge ────

const CHALLENGE_ADMIN_IDS = new Set(['938238002528911400']);

async function handleChallenge(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    if (!CHALLENGE_ADMIN_IDS.has(interaction.user.id)) {
      return interaction.reply({ content: 'admin only, stinky', ephemeral: true });
    }

    const title = interaction.options.getString('title');
    const points = interaction.options.getInteger('points');
    const description = interaction.options.getString('description') || null;
    const proof = interaction.options.getString('proof') || null;
    const deadline = interaction.options.getString('deadline') || null;

    db.createChallenge({
      title,
      description,
      points,
      createdBy: interaction.user.id,
      proofRequired: proof,
      deadline,
    });

    const embed = new EmbedBuilder()
      .setTitle('Challenge Created!')
      .addFields(
        { name: 'Title', value: title },
        { name: 'Points', value: `${points}`, inline: true },
        { name: 'Status', value: 'open', inline: true },
      )
      .setColor(0xF1C40F)
      .setTimestamp();

    if (description) embed.setDescription(description);
    if (proof) embed.addFields({ name: 'Proof Required', value: proof });
    if (deadline) embed.addFields({ name: 'Deadline', value: deadline, inline: true });

    return interaction.reply({ embeds: [embed] });
  }

  if (sub === 'list') {
    const statusFilter = interaction.options.getString('status') || 'open';
    const challenges = db.listChallenges(statusFilter === 'all' ? null : statusFilter);

    if (!challenges.length) {
      return interaction.reply({
        content: statusFilter === 'all' ? 'No challenges yet!' : `No **${statusFilter}** challenges right now.`,
        ephemeral: true,
      });
    }

    const statusEmoji = { open: '🟢', claimed: '🟡', completed: '✅', cancelled: '❌' };
    const lines = challenges.map(c => {
      const emoji = statusEmoji[c.status] || '❓';
      const deadline = c.deadline ? ` (due ${c.deadline})` : '';
      return `${emoji} **#${c.id} ${c.title}** — ${c.points} pts${deadline}${c.assigned_to ? ` — claimed by <@${c.assigned_to}>` : ''}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`Challenges${statusFilter !== 'all' ? ` — ${statusFilter}` : ''}`)
      .setDescription(lines.join('\n'))
      .setColor(0xF39C12)
      .setFooter({ text: 'Use /challenge claim <id> to claim one' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  if (sub === 'claim') {
    const id = interaction.options.getInteger('id');
    const userId = interaction.user.id;
    db.upsertMember(userId, interaction.user.username, interaction.member?.displayName);

    const result = db.claimChallenge(id, userId);
    if (!result.ok) {
      return interaction.reply({ content: `Could not claim: ${result.reason}`, ephemeral: true });
    }

    const challenge = db.getChallenge(id);
    return interaction.reply({
      content: `You've claimed **#${id} ${challenge.title}**! ` +
        `Complete it and an admin will award you **${challenge.points} pts**.` +
        (challenge.proof_required ? `\n\n**Proof required:** ${challenge.proof_required}` : ''),
    });
  }

  if (sub === 'complete') {
    if (!CHALLENGE_ADMIN_IDS.has(interaction.user.id)) {
      return interaction.reply({ content: 'admin only, stinky', ephemeral: true });
    }

    const id = interaction.options.getInteger('id');
    const result = db.completeChallenge(id, interaction.user.id);

    if (!result.ok) {
      return interaction.reply({ content: `Could not complete: ${result.reason}`, ephemeral: true });
    }

    const challenge = db.getChallenge(id);
    const winner = db.getMember(result.awardedTo);
    const username = winner?.display_name || winner?.username || result.awardedTo;

    // Audit log
    audit.log({ points: result.points, username, type: 'challenge_completed', extra: challenge.title });

    // Sync role
    interaction.guild && syncMemberRole(interaction.guild, result.awardedTo, db, config).catch(() => {});

    const embed = new EmbedBuilder()
      .setTitle('Challenge Completed!')
      .setDescription(`**#${id} ${challenge.title}**`)
      .addFields(
        { name: 'Winner', value: `<@${result.awardedTo}>`, inline: true },
        { name: 'Points Awarded', value: `**+${result.points}**`, inline: true },
      )
      .setColor(0x2ECC71)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
}

// ──── Scheduled Event Listeners ────

client.on('guildScheduledEventCreate', async (event) => {
  try {
    await eventTracker.onScheduledEventCreate(event);
  } catch (err) {
    console.error('[bot] guildScheduledEventCreate error:', err.message);
  }
});

client.on('guildScheduledEventUserAdd', async (event, user) => {
  try {
    await eventTracker.onScheduledEventUserAdd(event, user);
  } catch (err) {
    console.error('[bot] guildScheduledEventUserAdd error:', err.message);
  }
});

// ──── Voice State Listener ────

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    await eventTracker.onVoiceStateUpdate(oldState, newState);
  } catch (err) {
    console.error('[bot] voiceStateUpdate error:', err.message);
  }
});

// ──── Reaction Listener (announcement heuristic + instant reaction points) ────

client.on('messageReactionAdd', async (reaction, user) => {
  // Fetch partial reaction/user if needed
  if (reaction.partial) {
    try { reaction = await reaction.fetch(); } catch { return; }
  }
  if (user.partial) {
    try { user = await user.fetch(); } catch { return; }
  }

  // 1. Existing announcement heuristic
  try {
    await eventTracker.onReactionAdd(reaction, user);
  } catch (err) {
    console.error('[bot] messageReactionAdd (events) error:', err.message);
  }

  // 2. New: Reaction-based instant points
  try {
    const result = await reactionPoints.onReactionAdd(reaction, user);
    if (result && result.authorId) {
      const guild = reaction.message.guild;
      await postPointsHook(guild, result.authorId, {
        isFirstContribution: result.isFirstContribution,
      });
    }
  } catch (err) {
    console.error('[bot] messageReactionAdd (reaction-points) error:', err.message);
  }
});

// ──── Start ────

client.login(TOKEN);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[bot] shutting down...');
  eventTracker.cleanup();
  if (helpWantedPinger) helpWantedPinger.stop();
  await audit.flush();
  audit.destroy();
  db.close();
  client.destroy();
  process.exit(0);
});
