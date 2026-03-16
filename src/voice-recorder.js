/**
 * Voice Recorder + Transcriber
 * 
 * Extends the contribution bot to record voice channels and transcribe them.
 * Each speaker's audio is captured separately, transcribed via Whisper,
 * and stored as a pseudo-conversation in the contribution DB.
 * 
 * Architecture:
 *   1. Bot joins voice channel when ≥2 humans are present
 *   2. Creates per-user audio streams via Discord voice receiver
 *   3. Buffers Opus audio to temp WAV files (via ffmpeg)
 *   4. On silence (user stops talking) → runs Whisper on the segment
 *   5. Stores transcript segments in DB with author_id + timestamp
 *   6. At session end, flushes full transcript → contribution scorer
 *   7. Scores participants on helpfulness, teaching, ideas just like text
 * 
 * Requirements:
 *   - @discordjs/voice
 *   - @discordjs/opus (Opus codec)
 *   - ffmpeg (audio format conversion)
 *   - whisper CLI (transcription)
 */

import { execSync, spawn } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, unlinkSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

// Dynamic import — @discordjs/voice must be installed
let VoiceLib = null;
async function getVoiceLib() {
  if (!VoiceLib) {
    VoiceLib = await import('@discordjs/voice');
  }
  return VoiceLib;
}

// Whisper model to use (tiny = fastest, base = better, small = good balance)
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';

// Minimum segment length in seconds to bother transcribing
const MIN_SEGMENT_SECONDS = 2;

// Silence timeout before flushing a segment (ms)
const SILENCE_TIMEOUT_MS = 2000;

// Max segment length before forced flush (ms)
const MAX_SEGMENT_MS = 30000;

// Temp directory for audio files
const TEMP_DIR = join(tmpdir(), 'dc-voice-segments');

export class VoiceRecorder {
  constructor(config = {}) {
    this.config = config;
    this.activeSessions = new Map(); // channelId → session
    this.onTranscriptReady = config.onTranscriptReady || null; // callback(sessionData)
    this.onSegmentTranscribed = config.onSegmentTranscribed || null; // callback(channelId, userId, text, session) → bool

    // Ensure temp dir exists
    if (!existsSync(TEMP_DIR)) {
      mkdirSync(TEMP_DIR, { recursive: true });
    }
  }

  /**
   * Start recording a voice channel
   * Called when bot joins a channel
   */
  async startRecording(channel, voiceConnection) {
    const voice = await getVoiceLib();
    const channelId = channel.id;

    if (this.activeSessions.has(channelId)) {
      console.log(`[voice-recorder] Already recording ${channel.name}`);
      return;
    }

    const session = {
      channelId,
      channelName: channel.name,
      startedAt: new Date().toISOString(),
      participants: new Set(),
      segments: [],           // { userId, username, text, timestamp, durationMs }
      speakerBuffers: new Map(), // userId → { opusChunks, startTime, silenceTimer, flushTimer }
      connection: voiceConnection,
    };

    // Create audio receiver
    const receiver = voiceConnection.receiver;

    // Listen for speaking events
    receiver.speaking.on('start', (userId) => {
      this._onSpeakingStart(session, userId, receiver);
    });

    receiver.speaking.on('end', (userId) => {
      this._onSpeakingEnd(session, userId);
    });

    this.activeSessions.set(channelId, session);
    console.log(`[voice-recorder] Started recording #${channel.name} (${channelId})`);
  }

  /**
   * Stop recording and flush remaining segments
   */
  async stopRecording(channelId) {
    const session = this.activeSessions.get(channelId);
    if (!session) return null;

    // Flush any remaining buffers
    for (const [userId] of session.speakerBuffers) {
      await this._flushBuffer(session, userId);
    }

    // Clean up
    session.connection.destroy();
    this.activeSessions.delete(channelId);

    const sessionData = {
      channelId: session.channelId,
      channelName: session.channelName,
      startedAt: session.startedAt,
      endedAt: new Date().toISOString(),
      participants: [...session.participants],
      segments: session.segments,
      fullTranscript: this._buildFullTranscript(session.segments),
    };

    console.log(`[voice-recorder] Stopped recording #${session.channelName}. ${session.segments.length} segments, ${session.participants.size} speakers`);

    // Fire callback
    if (this.onTranscriptReady && sessionData.segments.length > 0) {
      await this.onTranscriptReady(sessionData);
    }

    return sessionData;
  }

  /**
   * Called when a user starts speaking
   */
  async _onSpeakingStart(session, userId, receiver) {
    const voice = await getVoiceLib();

    // Mark participant
    session.participants.add(userId);

    // Clear any pending silence timer
    const existing = session.speakerBuffers.get(userId);
    if (existing?.silenceTimer) {
      clearTimeout(existing.silenceTimer);
    }

    // Create audio stream for this user
    const audioStream = receiver.subscribe(userId, {
      end: {
        behavior: voice.EndBehaviorType.AfterSilence,
        duration: SILENCE_TIMEOUT_MS,
      },
    });

    const opusChunks = existing?.opusChunks || [];
    const startTime = existing?.startTime || Date.now();

    const buffer = {
      opusChunks,
      startTime,
      audioStream,
      silenceTimer: null,
      flushTimer: setTimeout(() => {
        this._flushBuffer(session, userId);
      }, MAX_SEGMENT_MS),
    };

    // Collect Opus packets
    audioStream.on('data', (chunk) => {
      opusChunks.push(chunk);
    });

    audioStream.on('end', () => {
      this._onSpeakingEnd(session, userId);
    });

    session.speakerBuffers.set(userId, buffer);
  }

  /**
   * Called when a user stops speaking (silence detected)
   */
  _onSpeakingEnd(session, userId) {
    const buffer = session.speakerBuffers.get(userId);
    if (!buffer) return;

    // Clear force-flush timer
    if (buffer.flushTimer) clearTimeout(buffer.flushTimer);

    // Set silence timer — flush after SILENCE_TIMEOUT_MS
    buffer.silenceTimer = setTimeout(() => {
      this._flushBuffer(session, userId);
    }, SILENCE_TIMEOUT_MS);

    session.speakerBuffers.set(userId, buffer);
  }

  /**
   * Flush a user's audio buffer to disk and transcribe
   */
  async _flushBuffer(session, userId) {
    const buffer = session.speakerBuffers.get(userId);
    if (!buffer || buffer.opusChunks.length === 0) {
      session.speakerBuffers.delete(userId);
      return;
    }

    // Clear timers
    if (buffer.silenceTimer) clearTimeout(buffer.silenceTimer);
    if (buffer.flushTimer) clearTimeout(buffer.flushTimer);
    session.speakerBuffers.delete(userId);

    const durationMs = Date.now() - buffer.startTime;

    // Skip very short segments (likely noise)
    if (durationMs < MIN_SEGMENT_SECONDS * 1000) return;

    const timestamp = new Date(buffer.startTime).toISOString();
    const segmentId = `${userId}-${buffer.startTime}`;
    const opusFile = join(TEMP_DIR, `${segmentId}.opus`);
    const wavFile = join(TEMP_DIR, `${segmentId}.wav`);

    try {
      // Write Opus chunks to file
      const opusData = Buffer.concat(buffer.opusChunks);
      const writeStream = createWriteStream(opusFile);
      writeStream.write(opusData);
      writeStream.end();

      // Convert Opus to WAV via ffmpeg
      await this._convertToWav(opusFile, wavFile);

      // Transcribe with Whisper
      const text = await this._transcribe(wavFile);

      if (text && text.trim().length > 2) {
        const trimmed = text.trim();
        session.segments.push({
          userId,
          text: trimmed,
          timestamp,
          durationMs,
        });

        console.log(`[voice-recorder] Transcribed ${userId}: "${trimmed.slice(0, 80)}"`);

        // Fire talkback hook — if it handles the segment (wake word), skip contribution scoring
        if (this.onSegmentTranscribed) {
          try {
            const sessionContext = {
              participants: [...session.participants],
              recentSegments: session.segments.slice(-10),
              connection: session.connection,
            };
            await this.onSegmentTranscribed(session.channelId, userId, trimmed, sessionContext);
          } catch (err) {
            console.error(`[voice-recorder] talkback hook error: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.error(`[voice-recorder] Flush error for ${userId}: ${err.message}`);
    } finally {
      // Clean up temp files
      try { if (existsSync(opusFile)) unlinkSync(opusFile); } catch { /* ok */ }
      try { if (existsSync(wavFile)) unlinkSync(wavFile); } catch { /* ok */ }
    }
  }

  /**
   * Convert Opus audio to WAV using ffmpeg
   */
  _convertToWav(opusFile, wavFile) {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-y',
        '-i', opusFile,
        '-ar', '16000',     // 16kHz — Whisper's preferred sample rate
        '-ac', '1',          // mono
        '-f', 'wav',
        wavFile,
      ]);

      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}`));
      });

      ffmpeg.on('error', reject);
    });
  }

  /**
   * Transcribe WAV file using local Whisper
   */
  _transcribe(wavFile) {
    return new Promise((resolve, reject) => {
      try {
        const output = execSync(
          `whisper "${wavFile}" --model ${WHISPER_MODEL} --language en --output_format txt --output_dir "${TEMP_DIR}" --verbose False 2>/dev/null`,
          { encoding: 'utf8', timeout: 60000 }
        );

        // Whisper writes a .txt file alongside the input
        const txtFile = wavFile.replace('.wav', '.txt');
        if (existsSync(txtFile)) {
          const text = readFileSync(txtFile, 'utf8').trim();
          try { unlinkSync(txtFile); } catch { /* ok */ }
          resolve(text);
        } else {
          // Try to parse from stdout
          const match = output.match(/\[[\d:.]+\s*-->\s*[\d:.]+\]\s*(.+)/);
          resolve(match?.[1] || output.trim());
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Build a full chronological transcript from segments
   */
  _buildFullTranscript(segments) {
    return segments
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .map(s => `[${s.userId}] ${s.text}`)
      .join('\n');
  }

  /**
   * Check if a channel is currently being recorded
   */
  isRecording(channelId) {
    return this.activeSessions.has(channelId);
  }

  /**
   * Get active session info
   */
  getSession(channelId) {
    return this.activeSessions.get(channelId) || null;
  }
}
