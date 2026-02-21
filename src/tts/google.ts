/**
 * Google Translate text-to-speech service (no API key required)
 */

import type { GoogleTextToSpeechConfig } from '../config/types.js';

const DEFAULT_LANGUAGE = 'en-US';
const DEFAULT_TLD = 'com';
const MAX_CHARS_PER_REQUEST = 180;

function splitForGoogleTts(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (normalized.length <= MAX_CHARS_PER_REQUEST) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > MAX_CHARS_PER_REQUEST) {
    const candidate = remaining.slice(0, MAX_CHARS_PER_REQUEST);
    const splitAt = Math.max(
      candidate.lastIndexOf('. '),
      candidate.lastIndexOf('! '),
      candidate.lastIndexOf('? '),
      candidate.lastIndexOf(', '),
      candidate.lastIndexOf(' '),
    );
    const idx = splitAt > 0 ? splitAt + 1 : MAX_CHARS_PER_REQUEST;
    chunks.push(remaining.slice(0, idx).trim());
    remaining = remaining.slice(idx).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

export async function synthesizeGoogleSpeech(
  text: string,
  config: GoogleTextToSpeechConfig,
): Promise<Buffer[]> {
  const language = config.language || process.env.GOOGLE_TTS_LANGUAGE || DEFAULT_LANGUAGE;
  const tld = config.tld || process.env.GOOGLE_TTS_TLD || DEFAULT_TLD;
  const segments = splitForGoogleTts(text);
  const buffers: Buffer[] = [];

  for (const segment of segments) {
    const url = new URL(`https://translate.google.${tld}/translate_tts`);
    url.searchParams.set('ie', 'UTF-8');
    url.searchParams.set('client', 'tw-ob');
    url.searchParams.set('tl', language);
    url.searchParams.set('q', segment);

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'audio/mpeg',
      },
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Google TTS failed (${response.status}): ${detail || response.statusText}`);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length) {
      throw new Error('Google TTS returned empty audio.');
    }
    buffers.push(audio);
  }

  return buffers;
}
