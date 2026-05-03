/**
 * Transcription service
 */

import { loadConfig } from '../config/index.js';
import { transcribeAudio as transcribeOpenAI } from './openai.js';
import { transcribeAudio as transcribeWhisperCpp } from './whispercpp.js';
export type { TranscriptionResult } from './openai.js';

export async function transcribeAudio(
  audioBuffer: Buffer,
  filename = 'audio.ogg',
  options?: { audioPath?: string },
) {
  const provider = loadConfig().transcription?.provider || 'openai';
  if (provider === 'whispercpp') {
    return transcribeWhisperCpp(audioBuffer, filename, options);
  }
  return transcribeOpenAI(audioBuffer, filename, options);
}
