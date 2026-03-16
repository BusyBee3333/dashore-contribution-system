#!/usr/bin/env node
/**
 * Voice Recording Daemon
 * 
 * Standalone Discord bot process that handles voice channel recording + transcription.
 * Runs alongside Buba Jr (which handles slash commands).
 * Both bots write to the same SQLite DB.
 * 
 * Usage:
 *   node scripts/voice-daemon.mjs
 * 
 * Env vars:
 *   DISCORD_BOT_TOKEN  — bot token (same or separate bot)
 *   ANTHROPIC_API_KEY  — for AI scoring
 *   WHISPER_MODEL      — whisper model to use (default: base)
 */

import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel } from '@discordjs/voice';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Config ────────────────────────────────────────────────────────────────────
let config;
try {
  config = JSON.parse(readFileSync(resolve(ROOT, 'config/config.json'), 'utf-8'));
} catch {
  console.error('[voice-daemon] Missing config/config.json');
  process.exit(1);
}

const TOKEN = process.env[config.discord_token_env || 'DISCORD_BOT_TOKEN'];
if (!TOKEN) {
  console.error('[voice-daemon] No DISCORD_BOT_TOKEN set');
  process.exit(1);
}

const GUILD_ID = config.guild_id;
const AUTH_TOKEN = process.env[config.scoring?.auth_token_env || 'ANTHROPIC_AUTH_TOKEN']
                 || process.env.ANTHROPIC_API_KEY;

// ── Imports ───────────────────────────────────────────────────────────────────
const { ContributionDB } = await import(pathToFileURL(resolve(ROOT, 'src/db.js')).href);
const { VoiceRecorder } = await import(pathToFileURL(resolve(ROOT, 'src/voice-recorder.js')).href);
const { VoiceScorer } = await import(pathToFileURL(resolve(ROOT, 'src/voice-scorer.js')).href);

const db = new ContributionDB(resolve(ROOT, config.contribution_db || './data/contributions.db')).init();

// ── Discord Client ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── Voice Scorer ───────────────────────────────────────────────────────────────
const voiceScorer = new VoiceScorer({ db, config, anthropicAuthToken: AUTH_TOKEN });

// ── Voice Recorder ─────────────────────────────────────────────────────────────
const voiceRecorder = new VoiceRecorder({
  onTranscriptReady: async (sessionData) => {
    if (!sessionData.segments.length) return;

    console.log(`[voice-daemon] Transcript ready: #${sessionData.channelName}, ${sessionData.segments.length} segments`);

    // Store for audit
    voiceScorer.storeTranscript(sessionData, GUILD_ID);

    // Build member map
    const guild = client.guilds.cache.get(GUILD_ID);
    const memberMap = {};
    for (const userId of sessionData.participants) {
      try {
        const member = guild?.members.cache.get(userId) || await guild?.members.fetch(userId).catch(() => null);
        if (member) {
          memberMap[userId] = {
            username: member.user.username,
            displayName: member.displayName || member.user.username,
            isBot: member.user.bot,
          };
        }
      } catch { /* skip unresolvable */ }
    }

    // Score
    const contributions = await voiceScorer.scoreSession(sessionData, memberMap);
    console.log(`[voice-daemon] Scored: ${contributions.length} contributions, ${contributions.reduce((s, c) => s + c.points, 0)} pts`);
  },
});

// ── Voice State Handler ────────────────────────────────────────────────────────
client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;

  const activeChannelId = newState.channelId || oldState.channelId;
  if (!activeChannelId) return;

  const channel = guild.channels.cache.get(activeChannelId);
  if (!channel || channel.type !== 2) return; // 2 = GUILD_VOICE

  // Count humans (exclude bots)
  const humanCount = channel.members?.filter(m => !m.user.bot).size ?? 0;
  const isRecording = voiceRecorder.isRecording(activeChannelId);

  // Join if ≥2 humans and not already recording
  if (humanCount >= 2 && !isRecording) {
    try {
      const connection = joinVoiceChannel({
        channelId: activeChannelId,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,  // must receive audio
        selfMute: true,   // bot stays muted
      });
      await voiceRecorder.startRecording(channel, connection);
      console.log(`[voice-daemon] Joined #${channel.name} (${humanCount} humans)`);
    } catch (err) {
      console.error(`[voice-daemon] Failed to join #${channel.name}: ${err.message}`);
    }
  }

  // Leave if <2 humans
  if (humanCount < 2 && isRecording) {
    await voiceRecorder.stopRecording(activeChannelId);
    console.log(`[voice-daemon] Left #${channel.name} — session ended`);
  }
});

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`[voice-daemon] Ready as ${client.user.tag}`);
  console.log(`[voice-daemon] Guild: ${GUILD_ID}`);
  console.log(`[voice-daemon] Whisper model: ${process.env.WHISPER_MODEL || 'base'}`);
  console.log(`[voice-daemon] Voice transcription active — listening for voice channels`);
});

client.on('error', err => console.error('[voice-daemon] client error:', err.message));
process.on('SIGTERM', () => { client.destroy(); process.exit(0); });
process.on('SIGINT', () => { client.destroy(); process.exit(0); });

client.login(TOKEN);
