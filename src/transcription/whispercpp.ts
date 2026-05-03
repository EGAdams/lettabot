/**
 * Local whisper.cpp transcription service
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../config/index.js';
import type { TranscriptionResult } from './openai.js';

function isExecutableAvailable(command: string): boolean {
  try {
    execFileSync(command, ['--help'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err?.code !== 'ENOENT';
  }
}

function resolveWhisperBinary(configBinaryPath?: string): string | null {
  const candidates = [
    configBinaryPath,
    process.env.WHISPER_CPP_BIN,
    'whisper-cli',
    'main',
  ].filter((value): value is string => !!value && value.trim().length > 0);

  for (const candidate of candidates) {
    if (isExecutableAvailable(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveModelPath(configModelPath?: string): string | null {
  const candidates = [
    configModelPath,
    process.env.WHISPER_MODEL_PATH,
    join(process.env.HOME || '', 'whisper.cpp', 'models', 'ggml-base.en.bin'),
    '/usr/local/share/whisper.cpp/ggml-base.en.bin',
    '/usr/share/whisper.cpp/ggml-base.en.bin',
  ].filter((value): value is string => !!value && value.trim().length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function discoverImageioFfmpegBinary(): string | null {
  try {
    const output = execFileSync(
      'python3',
      ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'],
      { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 },
    ).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function resolveFfmpegBinary(configFfmpegPath?: string): string | null {
  const candidates = [
    configFfmpegPath,
    process.env.FFMPEG_BIN,
    'ffmpeg',
    discoverImageioFfmpegBinary(),
  ].filter((value): value is string => !!value && value.trim().length > 0);

  for (const candidate of candidates) {
    if (isExecutableAvailable(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildWhisperArgs(options: {
  binaryPath: string;
  modelPath: string;
  wavPath: string;
  outputBasePath: string;
  language: string;
  threads?: number;
}): string[] {
  const args = [
    '-m',
    options.modelPath,
    '-f',
    options.wavPath,
    '-l',
    options.language,
    '-of',
    options.outputBasePath,
    '-otxt',
    '-nt',
  ];

  if (typeof options.threads === 'number' && Number.isFinite(options.threads)) {
    args.push('-t', String(Math.max(1, Math.floor(options.threads))));
  }

  // Keep behavior compatible with older whisper.cpp `main` binary.
  if (basename(options.binaryPath) === 'main') {
    return args;
  }

  return args;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  filename = 'audio.ogg',
  options?: { audioPath?: string },
): Promise<TranscriptionResult> {
  const config = loadConfig();
  const transcriptionConfig = config.transcription;
  const whisperConfig =
    transcriptionConfig?.provider === 'whispercpp' ? transcriptionConfig : undefined;

  const binaryPath = resolveWhisperBinary(whisperConfig?.binaryPath);
  if (!binaryPath) {
    return {
      success: false,
      error:
        'whisper.cpp binary not found. Set transcription.binaryPath, WHISPER_CPP_BIN, or install whisper-cli.',
      audioPath: options?.audioPath,
    };
  }

  const modelPath = resolveModelPath(whisperConfig?.modelPath);
  if (!modelPath) {
    return {
      success: false,
      error:
        'whisper.cpp model not found. Set transcription.modelPath or WHISPER_MODEL_PATH.',
      audioPath: options?.audioPath,
    };
  }

  const ffmpegPath = resolveFfmpegBinary(whisperConfig?.ffmpegPath);
  if (!ffmpegPath) {
    return {
      success: false,
      error:
        'ffmpeg is required for whisper.cpp transcription (audio conversion). Set transcription.ffmpegPath, FFMPEG_BIN, or install imageio-ffmpeg.',
      audioPath: options?.audioPath,
    };
  }

  const ext = filename.split('.').pop()?.toLowerCase() || 'ogg';
  const tempDir = mkdtempSync(join(tmpdir(), 'lettabot-whispercpp-'));
  const inputPath = join(tempDir, `source.${ext}`);
  const wavPath = join(tempDir, 'input.wav');
  const outputBasePath = join(tempDir, 'transcript');

  try {
    writeFileSync(inputPath, audioBuffer);

    execFileSync(
      ffmpegPath,
      ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
      { stdio: 'pipe', timeout: 120000 },
    );

    const language = whisperConfig?.language || process.env.WHISPER_LANGUAGE || 'auto';
    const threadEnv = process.env.WHISPER_THREADS;
    const configuredThreads = whisperConfig?.threads;
    const threads =
      typeof configuredThreads === 'number'
        ? configuredThreads
        : threadEnv
          ? Number(threadEnv)
          : undefined;

    const args = buildWhisperArgs({
      binaryPath,
      modelPath,
      wavPath,
      outputBasePath,
      language,
      threads,
    });

    execFileSync(binaryPath, args, { stdio: 'pipe', timeout: 300000 });

    const transcriptPath = `${outputBasePath}.txt`;
    if (!existsSync(transcriptPath)) {
      return {
        success: false,
        error: 'whisper.cpp completed but did not produce a transcript file.',
        audioPath: options?.audioPath,
      };
    }

    const text = readFileSync(transcriptPath, 'utf-8').trim();
    if (!text) {
      return {
        success: false,
        error: 'whisper.cpp returned an empty transcript.',
        audioPath: options?.audioPath,
      };
    }

    return { success: true, text };
  } catch (error) {
    return {
      success: false,
      error: `whisper.cpp transcription failed: ${extractErrorMessage(error)}`,
      audioPath: options?.audioPath,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
