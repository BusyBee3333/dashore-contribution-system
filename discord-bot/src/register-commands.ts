import "dotenv/config";
import {
  REST,
  Routes,
  SlashCommandBuilder,
  ApplicationCommandOptionType,
} from "discord.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!BOT_TOKEN || !CLIENT_ID) {
  if (!BOT_TOKEN) console.error("❌ BOT_TOKEN is required in .env file");
  if (!CLIENT_ID) console.error("❌ CLIENT_ID is required in .env file");
  process.exit(1);
}

const clientId: string = CLIENT_ID;
const botToken: string = BOT_TOKEN;

const commands = [
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("🏆 View the contribution leaderboard")
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("All time or current season")
        .setRequired(false)
        .addChoices(
          { name: "All Time", value: "alltime" },
          { name: "This Season", value: "season" }
        )
    ),

  new SlashCommandBuilder()
    .setName("mypoints")
    .setDescription("🌟 View your contribution profile and points"),

  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("👤 View another member's contribution profile")
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("The member to view")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("📊 View system-wide contribution statistics"),

  new SlashCommandBuilder()
    .setName("history")
    .setDescription("📜 View the full timestamped contribution audit log")
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("View another member's history (omit for your own, private)")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("vouch")
    .setDescription("✊ Vouch for a fellow member's contribution")
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("The member you're vouching for")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("reason")
        .setDescription("Why are you vouching for them?")
        .setRequired(true)
        .setMaxLength(300)
    ),

  new SlashCommandBuilder()
    .setName("linkgithub")
    .setDescription("🔗 Link your GitHub account to your Discord profile")
    .addStringOption((opt) =>
      opt
        .setName("username")
        .setDescription("Your GitHub username")
        .setRequired(true)
        .setMaxLength(39)
    ),

  new SlashCommandBuilder()
    .setName("projects")
    .setDescription("📋 Browse community projects and claim open tasks"),

  new SlashCommandBuilder()
    .setName("proposeproject")
    .setDescription("🚀 Propose a new community project for a community vote")
    .addStringOption((opt) =>
      opt
        .setName("title")
        .setDescription("Project title")
        .setRequired(true)
        .setMaxLength(80)
    )
    .addStringOption((opt) =>
      opt
        .setName("description")
        .setDescription("What is this project?")
        .setRequired(true)
        .setMaxLength(500)
    )
    .addStringOption((opt) =>
      opt
        .setName("repo")
        .setDescription("GitHub repository URL (optional)")
        .setRequired(false)
        .setMaxLength(200)
    ),

  new SlashCommandBuilder()
    .setName("addtask")
    .setDescription("[Admin] Add a task to an active community project")
    .addIntegerOption((opt) =>
      opt
        .setName("project_id")
        .setDescription("Community project ID")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("title")
        .setDescription("Task title")
        .setRequired(true)
        .setMaxLength(80)
    )
    .addStringOption((opt) =>
      opt
        .setName("description")
        .setDescription("Task description")
        .setRequired(false)
        .setMaxLength(300)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("points")
        .setDescription("Points awarded for this task")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(500)
    ),
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(botToken);

async function registerCommands() {
  try {
    console.log("🔄 Registering slash commands...\n");

    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(clientId, GUILD_ID), {
        body: commands,
      });
      console.log(
        `✅ Registered ${commands.length} guild commands (instant) to guild ${GUILD_ID}\n`
      );
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log(
        `✅ Registered ${commands.length} global commands (up to 1hr to propagate)\n`
      );
    }

    console.log("📋 Commands registered:");
    commands.forEach((cmd: any) => {
      console.log(`   /${cmd.name} — ${cmd.description}`);
    });
  } catch (err) {
    console.error("❌ Error registering commands:", err);
    process.exit(1);
  }
}

registerCommands();
