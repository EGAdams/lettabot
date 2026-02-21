/**
 * ElevenLabs text-to-speech service
 */

import type { ElevenLabsTextToSpeechConfig } from '../config/types.js';

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'; // "Rachel"
const DEFAULT_MODEL = 'eleven_multilingual_v2';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

function buildVoiceSettings(config: ElevenLabsTextToSpeechConfig): Record<string, unknown> | undefined {
  const settings = config.voiceSettings;
  if (!settings) return undefined;

  const out: Record<string, unknown> = {};
  if (typeof settings.stability === 'number') out.stability = settings.stability;
  if (typeof settings.similarityBoost === 'number') out.similarity_boost = settings.similarityBoost;
  if (typeof settings.style === 'number') out.style = settings.style;
  if (typeof settings.useSpeakerBoost === 'boolean') out.use_speaker_boost = settings.useSpeakerBoost;
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function synthesizeElevenLabsSpeech(
  text: string,
  config: ElevenLabsTextToSpeechConfig,
): Promise<Buffer> {
  const apiKey = config.apiKey || process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY is required for voice replies.');
  }

  const voiceId = config.voiceId || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const modelId = config.model || process.env.ELEVENLABS_MODEL || DEFAULT_MODEL;
  const outputFormat = config.outputFormat || process.env.ELEVENLABS_OUTPUT_FORMAT || DEFAULT_OUTPUT_FORMAT;

  const url = new URL(`${ELEVENLABS_BASE_URL}/${encodeURIComponent(voiceId)}`);
  url.searchParams.set('output_format', outputFormat);

  const body: Record<string, unknown> = {
    text,
    model_id: modelId,
  };
  const voiceSettings = buildVoiceSettings(config);
  if (voiceSettings) {
    body.voice_settings = voiceSettings;
  }

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Accept: 'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      detail = '';
    }
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${detail || response.statusText}`);
  }

  const audio = await response.arrayBuffer();
  return Buffer.from(audio);
}
