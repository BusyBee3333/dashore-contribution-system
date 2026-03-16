/**
 * Voice Talk-Back
 * 
 * Extends VoiceRecorder to respond to wake word ("buba") in voice channels.
 * When detected, sends the query to Claude and plays TTS response back.
 * 
 * Architecture:
 *   Whisper transcribes audio segment
 *   → check if "buba" in transcript
 *   → extract question/command
 *   → Claude generates response
 *   → TTS converts to audio (sag/ElevenLabs or macOS say)
 *   → AudioPlayer plays back in voice channel
 * 
 * Latency (current): ~3-5s end-to-end (Whisper bottleneck)
 * Latency (future): ~0.5s with NVIDIA Parakeet EOU 120M streaming
 * 
 * NVIDIA upgrade path:
 *   Replace _transcribe() with Parakeet EOU streaming
 *   Model: nvidia/parakeet_realtime_eou_120m-v1 (80-160ms, free license)
 *   Requires: pip install nemo_toolkit (Python), PyTorch with MPS
 */

import { execSync, spawn } from 'child_process';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Anthropic from '@anthropic-ai/sdk';

const WAKE_WORDS = ['buba', 'buba,', 'hey buba', 'ok buba', 'yo buba'];
const TTS_TEMP = join(tmpdir(), 'buba-voice-response.aiff');
const WAV_TEMP = join(tmpdir(), 'buba-voice-response.wav');

// How long the bot "thinks" before responding (prevents cut-off)
const RESPONSE_COOLDOWN_MS = 500;

// Max seconds of audio to buffer for a query (prevents runaway recording)
const MAX_QUERY_SECONDS = 30;

export class VoiceTalkBack {
  constructor(config = {}) {
    this.config = config;
    this.authToken = config.anthropicAuthToken;
    this.apiKey = config.anthropicApiKey;
    this.ttsVoice = config.ttsVoice || 'Alex'; // macOS say voice
    this.useElevenLabs = config.useElevenLabs || false;
    this.elevenLabsVoiceId = config.elevenLabsVoiceId || null;

    // Session context per channel — keeps track of conversation
    this._contexts = new Map(); // channelId → [{ role, content }]

    // Cooldown — prevent double-responses
    this._lastResponseAt = new Map(); // channelId → timestamp

    this._client = null;
  }

  _getClient() {
    if (!this._client) {
      const opts = {};
      if (this.authToken) opts.authToken = this.authToken;
      else opts.apiKey = this.apiKey || process.env.ANTHROPIC_API_KEY;
      this._client = new Anthropic(opts);
    }
    return this._client;
  }

  /**
   * Called after each transcription segment.
   * Returns true if the bot handled a query (suppresses contribution scoring for that segment).
   */
  async handleSegment(channelId, userId, text, sessionContext) {
    const lower = text.toLowerCase().trim();

    // Check for wake word
    const hasWakeWord = WAKE_WORDS.some(w => lower.includes(w));
    if (!hasWakeWord) return false;

    // Cooldown check
    const lastResponse = this._lastResponseAt.get(channelId) || 0;
    if (Date.now() - lastResponse < RESPONSE_COOLDOWN_MS) return false;

    // Extract query (text after wake word)
    let query = text;
    for (const w of WAKE_WORDS) {
      const idx = lower.indexOf(w);
      if (idx !== -1) {
        query = text.slice(idx + w.length).trim();
        break;
      }
    }

    if (!query || query.length < 2) {
      // Just the wake word — generic acknowledgement
      query = 'say hello briefly';
    }

    console.log(`[voice-talkback] Wake word in #${channelId} from ${userId}: "${query}"`);
    this._lastResponseAt.set(channelId, Date.now());

    // Build context
    const history = this._contexts.get(channelId) || [];
    const participants = sessionContext?.participants || [];
    const transcript = sessionContext?.recentSegments || [];

    const systemPrompt = `You are Buba, an AI assistant participating in a Discord voice chat session.
You are listening and can hear everything being said.
Current voice channel has ${participants.length} participants.
Keep responses SHORT — 1-3 sentences max. You're speaking out loud.
Do not use markdown, bullet points, or formatting — pure speech only.
Recent voice transcript context:
${transcript.slice(-5).map(s => `${s.userId}: ${s.text}`).join('\n') || '(session just started)'}`;

    try {
      const client = this._getClient();
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20250315', // Fast model for voice latency
        max_tokens: 200,
        system: systemPrompt,
        messages: [
          ...history.slice(-4), // Last 2 exchanges for context
          { role: 'user', content: query },
        ],
      });

      const reply = response.content[0]?.text?.trim() || 'Got it.';
      console.log(`[voice-talkback] Response: "${reply}"`);

      // Update context
      history.push({ role: 'user', content: query });
      history.push({ role: 'assistant', content: reply });
      this._contexts.set(channelId, history.slice(-8)); // Keep last 4 exchanges

      // Generate and play TTS
      await this._speakInChannel(reply, sessionContext?.connection);

      return true;
    } catch (err) {
      console.error(`[voice-talkback] Error: ${err.message}`);
      return false;
    }
  }

  /**
   * Generate TTS audio and play it in the voice channel
   */
  async _speakInChannel(text, connection) {
    if (!connection) {
      console.log('[voice-talkback] No connection — cannot play audio');
      return;
    }

    try {
      // Generate TTS audio
      if (this.useElevenLabs && this.elevenLabsVoiceId) {
        await this._elevenLabsTTS(text);
      } else {
        await this._macOSTTS(text);
      }

      // Play via @discordjs/voice AudioPlayer
      const { createAudioPlayer, createAudioResource, AudioPlayerStatus } = await import('@discordjs/voice');

      const player = createAudioPlayer();
      const resource = createAudioResource(WAV_TEMP);

      connection.subscribe(player);
      player.play(resource);

      // Wait for playback to finish
      await new Promise((resolve) => {
        player.on(AudioPlayerStatus.Idle, resolve);
        player.on('error', resolve);
        setTimeout(resolve, 30000); // Safety timeout
      });

      player.stop();
      console.log('[voice-talkback] Playback complete');
    } catch (err) {
      console.error(`[voice-talkback] Playback error: ${err.message}`);
    } finally {
      // Clean up temp files
      try { if (existsSync(TTS_TEMP)) unlinkSync(TTS_TEMP); } catch { /* ok */ }
      try { if (existsSync(WAV_TEMP)) unlinkSync(WAV_TEMP); } catch { /* ok */ }
    }
  }

  /**
   * macOS TTS → WAV (free, no API key)
   */
  async _macOSTTS(text) {
    // say outputs AIFF; convert to WAV for Discord
    execSync(`say -v "${this.ttsVoice}" -o "${TTS_TEMP}" "${text.replace(/"/g, "'")}"`, { timeout: 15000 });
    execSync(`ffmpeg -y -i "${TTS_TEMP}" -ar 48000 -ac 2 -f wav "${WAV_TEMP}" 2>/dev/null`, { timeout: 10000 });
  }

  /**
   * ElevenLabs TTS via sag CLI → WAV
   * Better voice quality but requires API key
   */
  async _elevenLabsTTS(text) {
    const output = await new Promise((resolve, reject) => {
      const proc = spawn('sag', [
        '--voice', this.elevenLabsVoiceId,
        '--output', TTS_TEMP.replace('.aiff', '.mp3'),
        text,
      ]);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`sag exited ${code}`)));
      proc.on('error', reject);
    });

    // Convert mp3 → wav
    const mp3 = TTS_TEMP.replace('.aiff', '.mp3');
    execSync(`ffmpeg -y -i "${mp3}" -ar 48000 -ac 2 -f wav "${WAV_TEMP}" 2>/dev/null`, { timeout: 10000 });
    try { unlinkSync(mp3); } catch { /* ok */ }
  }

  /**
   * Clear conversation context for a channel (when session ends)
   */
  clearContext(channelId) {
    this._contexts.delete(channelId);
    this._lastResponseAt.delete(channelId);
  }
}
