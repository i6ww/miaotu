/* eslint-disable no-console */
import { fetch as undiciFetch } from 'undici';
import { getSystemConfig, getVideoModelWithChannel } from './db';
import type { SoraGenerateRequest, GenerateResult, VideoChannel, VideoModel } from '@/types';
import { generateVideo, type VideoGenerationRequest } from './sora-api';
import { fetchWithRetry } from './http-retry';
import { resolveFlowVeoModel } from './video-model-normalizer';
import { uploadToImageBucket } from './picui';

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

const SORA_LOG_LEVEL: LogLevel = (() => {
  const raw = (process.env.SORA_LOG_LEVEL || '').toLowerCase();
  if (raw in LOG_LEVELS) return raw as LogLevel;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
})();

const shouldLog = (level: LogLevel) => LOG_LEVELS[level] >= LOG_LEVELS[SORA_LOG_LEVEL];

const logDebug = (...args: unknown[]) => {
  if (shouldLog('debug')) console.log(...args);
};
const logInfo = (...args: unknown[]) => {
  if (shouldLog('info')) console.log(...args);
};
const logWarn = (...args: unknown[]) => {
  if (shouldLog('warn')) console.warn(...args);
};
const logError = (...args: unknown[]) => {
  if (shouldLog('error')) console.error(...args);
};

type ExternalVideoPayload = {
  prompt: string;
  model: string;
  files: { mimeType: string; data: string }[];
};

type ExternalChatChoice = {
  message?: {
    content?: unknown;
  };
  delta?: {
    content?: unknown;
    reasoning_content?: unknown;
  };
};

type ExternalChatResponse = {
  choices?: ExternalChatChoice[];
  error?: {
    message?: string;
    detail?: string;
  } | string;
  detail?: string;
};

const VIDEO_URL_PATTERN = /\.(mp4|mov|webm|mkv|m3u8)(\?|#|$)/i;
const IMAGE_URL_PATTERN = /\.(jpg|jpeg|png|webp|gif|bmp|svg)(\?|#|$)/i;
const GROK_MAX_VIDEO_LENGTH_SECONDS = 30;
const GROK_SUPPORTED_VIDEO_LENGTHS = [6, 10, 12, 16, 20] as const;
const MINIMAX_H3_DEFAULT_BASE_URL = 'https://snumom.com';
const MINIMAX_H3_POLL_INTERVAL_MS = 5_000;
const MINIMAX_H3_MAX_WAIT_MS = 20 * 60_000;
const MINIMAX_H3_REFERENCE_IMAGE_LIMIT = 9;
const MINIMAX_H3_REFERENCE_VIDEO_LIMIT = 3;
const MINIMAX_H3_REFERENCE_AUDIO_LIMIT = 3;
const MINIMAX_H3_TOTAL_REFERENCE_LIMIT = 12;
export const MINIMAX_H3_FREE_REFERENCE_IMAGE_COUNT = 5;
export const MINIMAX_H3_EXTRA_REFERENCE_IMAGE_COST = 10;

const MINIMAX_H3_SIZES = {
  '768p': {
    '16:9': '1376x768',
    '9:16': '768x1376',
    '1:1': '1024x1024',
    '4:3': '1152x864',
    '3:4': '864x1152',
    '3:2': '1248x832',
    '2:3': '832x1248',
    '21:9': '1792x768',
  },
  '1080p': {
    '16:9': '1920x1080',
    '9:16': '1080x1920',
    '1:1': '1440x1440',
    '4:3': '1664x1248',
    '3:4': '1248x1664',
    '3:2': '1728x1152',
    '2:3': '1152x1728',
  },
} as const;

function normalizeExtractedUrl(raw: string, baseUrl?: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const cleaned = trimmed.replace(/^['"(<\[]+|[>'")\],.]+$/g, '');
  if (!cleaned) return null;
  if (/^https?:\/\//i.test(cleaned)) return cleaned;

  if (baseUrl) {
    const canResolveRelative =
      cleaned.startsWith('/') ||
      cleaned.startsWith('./') ||
      cleaned.startsWith('../') ||
      cleaned.startsWith('cache/') ||
      cleaned.startsWith('tmp/');
    if (canResolveRelative) {
      try {
        return new URL(cleaned, baseUrl).toString();
      } catch {
        return null;
      }
    }
  }

  return null;
}

function collectCapturedUrls(input: string, pattern: RegExp, baseUrl?: string): string[] {
  const results: string[] = [];
  pattern.lastIndex = 0;

  let matched: RegExpExecArray | null;
  while ((matched = pattern.exec(input)) !== null) {
    const captured = typeof matched[1] === 'string' ? matched[1] : matched[0];
    const normalized = normalizeExtractedUrl(captured, baseUrl);
    if (normalized) {
      results.push(normalized);
    }
  }

  return results;
}

function scoreVideoCandidate(url: string, baseScore: number): number {
  const lower = url.toLowerCase();
  let score = baseScore;

  if (VIDEO_URL_PATTERN.test(lower)) score += 90;
  if (lower.includes('/v1/files/video/')) score += 80;
  if (lower.includes('/videos/')) score += 70;
  if (lower.includes('/video/')) score += 60;
  if (lower.includes('generated_video')) score += 70;
  if (lower.includes('video')) score += 20;

  if (IMAGE_URL_PATTERN.test(lower)) score -= 120;
  if (lower.includes('preview_image')) score -= 80;
  if (lower.includes('/preview/')) score -= 40;
  if (lower.includes('poster')) score -= 40;

  return score;
}

function selectBestVideoCandidate(candidates: Array<{ url: string; score: number }>): string | null {
  if (candidates.length === 0) return null;

  const deduped = new Map<string, number>();
  for (const candidate of candidates) {
    const previousScore = deduped.get(candidate.url);
    if (previousScore === undefined || candidate.score > previousScore) {
      deduped.set(candidate.url, candidate.score);
    }
  }

  const ranked = Array.from(deduped.entries())
    .map(([url, score]) => ({ url, score }))
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return null;
  if (ranked[0]!.score > 0) return ranked[0]!.url;

  return null;
}

function buildMediaJson(type: 'video' | 'image', url: string): string {
  return JSON.stringify({ type, url });
}

function parseMediaJsonFromContent(content: string): { type: 'video' | 'image'; url: string } | null {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    if ((parsed.type === 'video' || parsed.type === 'image') && typeof parsed.url === 'string' && parsed.url.trim()) {
      return { type: parsed.type, url: parsed.url.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

function extractVideoUrlFromText(content: string, baseUrl?: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const mediaJson = parseMediaJsonFromContent(trimmed);
  if (mediaJson?.type === 'video' && mediaJson.url) {
    const normalized = normalizeExtractedUrl(mediaJson.url, baseUrl);
    if (normalized) return normalized;
  }

  const candidates: Array<{ url: string; score: number }> = [];

  const videoTagSrcMatches = collectCapturedUrls(
    trimmed,
    /<video\b[^>]*\bsrc=['"]([^'"]+)['"]/gi,
    baseUrl,
  );
  for (const url of videoTagSrcMatches) {
    candidates.push({ url, score: scoreVideoCandidate(url, 140) });
  }

  const sourceTagMatches = collectCapturedUrls(
    trimmed,
    /<source\b[^>]*\bsrc=['"]([^'"]+)['"]/gi,
    baseUrl,
  );
  for (const url of sourceTagMatches) {
    candidates.push({ url, score: scoreVideoCandidate(url, 120) });
  }

  const markdownLinkMatches = collectCapturedUrls(
    trimmed,
    /!?\[[^\]]*]\(([^)]+)\)/gi,
    baseUrl,
  );
  for (const url of markdownLinkMatches) {
    candidates.push({ url, score: scoreVideoCandidate(url, 70) });
  }

  const rawUrlMatches = collectCapturedUrls(
    trimmed,
    /(https?:\/\/[^\s"'<>`]+)/gi,
    baseUrl,
  );
  for (const url of rawUrlMatches) {
    candidates.push({ url, score: scoreVideoCandidate(url, 50) });
  }

  const best = selectBestVideoCandidate(candidates);
  if (best) return best;

  const fallback = rawUrlMatches.find((url) => !IMAGE_URL_PATTERN.test(url.toLowerCase())) || null;
  return fallback;
}

function normalizeContentToText(content: unknown, depth = 0): string {
  if (depth > 6 || content === null || content === undefined) return '';
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((item) => normalizeContentToText(item, depth + 1))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
    if (typeof record.url === 'string') return record.url;

    return Object.values(record)
      .map((item) => normalizeContentToText(item, depth + 1))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
}

function compactSnippet(content: string, max = 200): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractUpstreamErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;

  const detail = typeof record.detail === 'string' ? record.detail.trim() : '';
  if (detail) return detail;

  const error = record.error;
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === 'object') {
    const errorRecord = error as Record<string, unknown>;
    if (typeof errorRecord.message === 'string' && errorRecord.message.trim()) {
      return errorRecord.message.trim();
    }
    if (typeof errorRecord.detail === 'string' && errorRecord.detail.trim()) {
      return errorRecord.detail.trim();
    }
  }

  return null;
}

function extractContentFromExternalChatPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const segments: string[] = [];

  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const item = choice as Record<string, unknown>;
    const message = item.message as Record<string, unknown> | undefined;
    const delta = item.delta as Record<string, unknown> | undefined;

    const candidates = [
      message?.content,
      delta?.content,
      delta?.reasoning_content,
    ];

    for (const candidate of candidates) {
      const text = normalizeContentToText(candidate);
      if (text) segments.push(text);
    }
  }

  return segments.join('\n').trim();
}

function extractVideoUrlFromUnknownPayload(payload: unknown, baseUrl?: string): string | null {
  const queue: unknown[] = [payload];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || current === undefined) continue;

    if (typeof current === 'string') {
      const fromText = extractVideoUrlFromText(current, baseUrl);
      if (fromText) return fromText;

      const normalized = normalizeExtractedUrl(current, baseUrl);
      if (normalized && scoreVideoCandidate(normalized, 0) > 0) {
        return normalized;
      }
      continue;
    }

    if (typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }

    for (const value of Object.values(current as Record<string, unknown>)) {
      queue.push(value);
    }
  }

  return null;
}

function parseSseDataEvents(rawText: string): string[] {
  const events: string[] = [];
  const normalized = rawText.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }

    if (line.trim() === '') {
      if (dataLines.length > 0) {
        events.push(dataLines.join('\n'));
        dataLines = [];
      }
      continue;
    }
  }

  if (dataLines.length > 0) {
    events.push(dataLines.join('\n'));
  }

  return events;
}

function extractVideoUrlFromSseResponseText(
  rawText: string,
  baseUrl?: string
): { url: string | null; errorMessage: string | null; text: string } {
  const events = parseSseDataEvents(rawText);
  const textSegments: string[] = [];
  let errorMessage: string | null = null;

  for (const eventData of events) {
    const data = eventData.trim();
    if (!data || data === '[DONE]') continue;

    let payload: unknown = null;
    try {
      payload = JSON.parse(data);
    } catch {
      const directUrl = extractVideoUrlFromText(data, baseUrl);
      if (directUrl) {
        return { url: directUrl, errorMessage, text: textSegments.join('\n').trim() };
      }
      textSegments.push(data);
      continue;
    }

    const upstreamError = extractUpstreamErrorMessage(payload);
    if (upstreamError && !errorMessage) {
      errorMessage = upstreamError;
    }

    const urlFromPayload = extractVideoUrlFromUnknownPayload(payload, baseUrl);
    if (urlFromPayload) {
      return { url: urlFromPayload, errorMessage, text: textSegments.join('\n').trim() };
    }

    const contentText = extractContentFromExternalChatPayload(payload);
    if (contentText) {
      textSegments.push(contentText);
      const urlFromContent = extractVideoUrlFromText(contentText, baseUrl);
      if (urlFromContent) {
        return { url: urlFromContent, errorMessage, text: textSegments.join('\n').trim() };
      }
    }
  }

  const mergedText = textSegments.join('\n').trim();
  const fallbackUrl = mergedText ? extractVideoUrlFromText(mergedText, baseUrl) : null;
  return { url: fallbackUrl, errorMessage, text: mergedText };
}

function parseSseEventBlock(block: string): string | null {
  const dataLines = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) return null;
  return dataLines.join('\n').trim();
}

function progressFromExternalMessage(message: string, currentProgress: number): number {
  const text = message.trim();
  if (!text) return currentProgress;

  if (text.includes('上传参考图片')) return Math.max(currentProgress, 30);
  if (text.includes('参考图已就绪')) return Math.max(currentProgress, 42);
  if (text.includes('开始提交视频任务')) return Math.max(currentProgress, 56);
  if (text.includes('视频任务状态:')) return Math.max(currentProgress, 72);
  if (text.includes('4K') && text.includes('放大')) return Math.max(currentProgress, 86);
  if (text.toUpperCase().includes('1080') && text.includes('放大')) return Math.max(currentProgress, 86);
  if (text.includes('缓存')) return Math.max(currentProgress, 94);
  return Math.max(currentProgress, 18);
}

async function readStreamingExternalChatResponse(
  response: Response,
  baseUrl: string | undefined,
  onProgress?: (progress: number) => void
): Promise<{ url: string | null; errorMessage: string | null; text: string; rawBody: string }> {
  if (!response.body?.getReader) {
    const rawBody = await response.text();
    const parsed = extractVideoUrlFromSseResponseText(rawBody, baseUrl);
    return { ...parsed, rawBody };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const textSegments: string[] = [];
  const rawSegments: string[] = [];
  let buffer = '';
  let rawUrl: string | null = null;
  let errorMessage: string | null = null;
  let progress = 5;

  const processEventData = (eventData: string) => {
    const data = eventData.trim();
    if (!data || data === '[DONE]') return;

    let payload: unknown = null;
    try {
      payload = JSON.parse(data);
    } catch {
      const directUrl = extractVideoUrlFromText(data, baseUrl);
      if (directUrl && !rawUrl) {
        rawUrl = directUrl;
      }
      textSegments.push(data);
      return;
    }

    const upstreamError = extractUpstreamErrorMessage(payload);
    if (upstreamError && !errorMessage) {
      errorMessage = upstreamError;
    }

    const urlFromPayload = extractVideoUrlFromUnknownPayload(payload, baseUrl);
    if (urlFromPayload && !rawUrl) {
      rawUrl = urlFromPayload;
    }

    const contentText = extractContentFromExternalChatPayload(payload);
    if (contentText) {
      textSegments.push(contentText);
      const nextProgress = progressFromExternalMessage(contentText, progress);
      if (nextProgress > progress) {
        progress = nextProgress;
        onProgress?.(progress);
      }

      const urlFromContent = extractVideoUrlFromText(contentText, baseUrl);
      if (urlFromContent && !rawUrl) {
        rawUrl = urlFromContent;
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    rawSegments.push(chunk);
    buffer = (buffer + chunk).replace(/\r\n/g, '\n');

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const eventData = parseSseEventBlock(block);
      if (eventData) {
        processEventData(eventData);
      }

      boundary = buffer.indexOf('\n\n');
    }
  }

  const tail = decoder.decode();
  if (tail) {
    rawSegments.push(tail);
    buffer += tail;
  }

  const tailData = parseSseEventBlock(buffer.replace(/\r\n/g, '\n'));
  if (tailData) {
    processEventData(tailData);
  }

  const text = textSegments.join('\n').trim();
  if (!rawUrl && text) {
    rawUrl = extractVideoUrlFromText(text, baseUrl);
  }

  return {
    url: rawUrl,
    errorMessage,
    text,
    rawBody: rawSegments.join(''),
  };
}

function normalizeAspectRatioLabel(aspectRatio: string): string {
  switch ((aspectRatio || '').toLowerCase()) {
    case 'landscape':
      return '16:9';
    case 'portrait':
      return '9:16';
    case 'square':
      return '1:1';
    default:
      return aspectRatio || '16:9';
  }
}

function normalizeDurationSeconds(duration?: string): number {
  if (!duration) return 10;
  const matched = duration.match(/(\d+)/);
  if (!matched) return 10;
  const parsed = Number.parseInt(matched[1], 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 10;
  return parsed;
}

function normalizeGrokVideoLengthSeconds(duration?: string, fallback = 10): number {
  const parsed = normalizeDurationSeconds(duration);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(5, Math.min(GROK_MAX_VIDEO_LENGTH_SECONDS, Math.floor(base)));
}

function normalizeGrokSupportedVideoLength(seconds: number): number {
  const requested = Number.isFinite(seconds) ? Math.floor(seconds) : 10;
  return GROK_SUPPORTED_VIDEO_LENGTHS.reduce((best, current) => {
    const currentDistance = Math.abs(current - requested);
    const bestDistance = Math.abs(best - requested);
    return currentDistance < bestDistance ? current : best;
  }, GROK_SUPPORTED_VIDEO_LENGTHS[0]);
}

function mapFlowModel(modelName: string, aspectRatio: string, duration: string, imageCount: number): string {
  const normalizedModel = (modelName || '').trim();
  const lowerModel = normalizedModel.toLowerCase();

  if (lowerModel.startsWith('veo_')) {
    return resolveFlowVeoModel(normalizedModel, aspectRatio, imageCount) || normalizedModel;
  }

  const ratio = (aspectRatio || '').toLowerCase();
  const seconds = normalizeDurationSeconds(duration);

  const isI2V = imageCount > 0 || lowerModel.includes('i2v') || lowerModel.includes('image');
  const isR2V = imageCount >= 3 || lowerModel.includes('r2v') || lowerModel.includes('reference');

  if (isR2V) {
    return ratio === 'portrait' ? 'veo_3_0_r2v_fast_portrait' : 'veo_3_0_r2v_fast_landscape';
  }

  if (isI2V) {
    if (seconds >= 15) {
      return ratio === 'portrait'
        ? 'veo_2_1_fast_d_15_i2v_portrait'
        : 'veo_2_1_fast_d_15_i2v_landscape';
    }
    return ratio === 'portrait'
      ? 'veo_3_1_i2v_s_fast_portrait_fl'
      : 'veo_3_1_i2v_s_fast_fl';
  }

  if (seconds >= 15) {
    return ratio === 'portrait'
      ? 'veo_2_1_fast_d_15_t2v_portrait'
      : 'veo_2_1_fast_d_15_t2v_landscape';
  }

  return ratio === 'portrait' ? 'veo_3_1_t2v_fast_portrait' : 'veo_3_1_t2v_fast_landscape';
}

function mapGrokModel(modelName: string): string {
  return modelName?.trim() || 'grok-imagine-1.0-video';
}

function mapChannelModel(channelType: VideoChannel['type'], model: VideoModel, request: SoraGenerateRequest): string {
  const ratio = request.aspectRatio || model.defaultAspectRatio || 'landscape';
  const duration = request.duration || model.defaultDuration || '8s';
  const imageCount = (request.files || []).filter((file) => file.mimeType.startsWith('image/')).length;

  if (channelType === 'flow2api') {
    return mapFlowModel(model.apiModel, ratio, duration, imageCount);
  }
  if (channelType === 'grok2api') {
    return mapGrokModel(model.apiModel);
  }
  return model.apiModel || request.model;
}

function resolveVideoConfigObject(
  request: SoraGenerateRequest,
  model: VideoModel
): { aspect_ratio: string; video_length: number; resolution: 'SD' | 'HD'; preset: 'fun' | 'normal' | 'spicy' } {
  const requestConfig = request.videoConfigObject || request.video_config;
  const modelConfig = model.videoConfigObject;
  const hasRequestAspectRatio = typeof request.aspectRatio === 'string' && request.aspectRatio.trim().length > 0;
  const hasRequestDuration = typeof request.duration === 'string' && request.duration.trim().length > 0;

  const aspectRatioRaw =
    requestConfig?.aspect_ratio ||
    (hasRequestAspectRatio
      ? request.aspectRatio
      : modelConfig?.aspect_ratio || model.defaultAspectRatio || 'landscape');

  const videoLengthRaw =
    typeof requestConfig?.video_length === 'number'
      ? requestConfig.video_length
      : hasRequestDuration
        ? normalizeGrokVideoLengthSeconds(request.duration || '8s')
        : typeof modelConfig?.video_length === 'number'
          ? modelConfig.video_length
          : normalizeGrokVideoLengthSeconds(model.defaultDuration || '8s');

  const resolutionRaw = (requestConfig?.resolution || modelConfig?.resolution || 'HD').toString().toUpperCase();
  const presetRaw = (requestConfig?.preset || modelConfig?.preset || 'normal').toString().toLowerCase();

  return {
    aspect_ratio: normalizeAspectRatioLabel(aspectRatioRaw || '16:9'),
    video_length: Math.max(5, Math.min(GROK_MAX_VIDEO_LENGTH_SECONDS, Math.floor(videoLengthRaw))),
    resolution: resolutionRaw === 'SD' ? 'SD' : 'HD',
    preset: presetRaw === 'fun' || presetRaw === 'spicy' ? (presetRaw as 'fun' | 'spicy') : 'normal',
  };
}

function grokSizeForAspectRatio(aspectRatio: string): string {
  switch (normalizeAspectRatioLabel(aspectRatio)) {
    case '9:16':
      return '1024x1792';
    case '1:1':
      return '1024x1024';
    case '2:3':
      return '1024x1792';
    case '3:2':
      return '1792x1024';
    case '16:9':
    default:
      return '1792x1024';
  }
}

function resolveGrokVideoConfigObject(
  request: SoraGenerateRequest,
  model: VideoModel
): { seconds: number; size: string; resolution_name: '480p' | '720p'; preset: 'fun' | 'normal' | 'spicy' } {
  const legacyConfig = resolveVideoConfigObject(request, model);
  return {
    seconds: normalizeGrokSupportedVideoLength(legacyConfig.video_length),
    size: grokSizeForAspectRatio(legacyConfig.aspect_ratio),
    resolution_name: legacyConfig.resolution === 'SD' ? '480p' : '720p',
    preset: legacyConfig.preset,
  };
}

function normalizeMinimaxH3AspectRatio(aspectRatio?: string): keyof typeof MINIMAX_H3_SIZES['768p'] {
  const normalized = (aspectRatio || '').trim().toLowerCase();
  switch (normalized) {
    case 'portrait':
      return '9:16';
    case 'square':
      return '1:1';
    case 'landscape':
      return '16:9';
    case '9:16':
    case '1:1':
    case '4:3':
    case '3:4':
    case '3:2':
    case '2:3':
    case '21:9':
      return normalized;
    case '16:9':
    default:
      return '16:9';
  }
}

function resolveMinimaxH3Size(modelName: string, aspectRatio?: string): string {
  const resolution = modelName.toLowerCase().includes('1080p') ? '1080p' : '768p';
  const ratio = normalizeMinimaxH3AspectRatio(aspectRatio);
  const sizes = MINIMAX_H3_SIZES[resolution];
  const size = (sizes as Partial<Record<typeof ratio, string>>)[ratio];

  if (!size) {
    throw new Error(`Minimax H3 ${resolution} does not support aspect ratio ${ratio}`);
  }

  return size;
}

function normalizeMinimaxH3Seconds(duration?: string): number {
  const seconds = normalizeDurationSeconds(duration || '5s');
  return Math.max(4, Math.min(15, seconds));
}

function pickEffectiveApiKey(channel: VideoChannel, model: VideoModel): string {
  return (model.apiKey || channel.apiKey || '')
    .split(',')
    .map((key) => key.trim())
    .find(Boolean) || '';
}

function normalizeMinimaxH3BaseUrl(channel: VideoChannel, model: VideoModel): string {
  return (model.baseUrl || channel.baseUrl || MINIMAX_H3_DEFAULT_BASE_URL).replace(/\/$/, '');
}

function isPublicMinimaxReferenceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isPublicProtocol = url.protocol === 'http:' || url.protocol === 'https:';
    const hasAllowedPort = !url.port || url.port === '80' || url.port === '443';
    const isLocalhost = hostname === 'localhost' || hostname.endsWith('.localhost');
    return isPublicProtocol && hasAllowedPort && !isLocalhost;
  } catch {
    return false;
  }
}

function normalizeMinimaxH3ReferenceUrls(
  value: string[] | undefined,
  limit: number,
  label: string
): string[] {
  const urls: string[] = [];

  for (const item of value || []) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || urls.includes(trimmed)) continue;

    if (!isPublicMinimaxReferenceUrl(trimmed)) {
      throw new Error(`Minimax H3 ${label} reference URL must be a public HTTP(S) URL on port 80 or 443: ${trimmed}`);
    }

    if (urls.length >= limit) {
      throw new Error(`Minimax H3 supports up to ${limit} ${label} reference URLs`);
    }

    urls.push(trimmed);
  }

  return urls;
}

function dataUrlForFile(file: { mimeType: string; data: string }): string {
  if (file.data.startsWith('data:')) return file.data;
  return `data:${file.mimeType || 'image/jpeg'};base64,${file.data}`;
}

async function buildMinimaxH3ReferenceImages(
  request: SoraGenerateRequest
): Promise<Array<{ url: string }>> {
  const urls: string[] = [];
  const addUrl = (url: string | undefined, source: string) => {
    if (!url) {
      logDebug('[Video Adapter] Minimax H3 reference image skipped: empty URL', { source });
      return;
    }
    const trimmed = url.trim();
    if (!trimmed) {
      logDebug('[Video Adapter] Minimax H3 reference image skipped: blank URL', { source });
      return;
    }
    if (urls.includes(trimmed)) {
      logDebug('[Video Adapter] Minimax H3 reference image skipped: duplicate URL', { source, url: trimmed });
      return;
    }
    if (isPublicMinimaxReferenceUrl(trimmed)) {
      if (urls.length >= MINIMAX_H3_REFERENCE_IMAGE_LIMIT) {
        throw new Error(`Minimax H3 supports up to ${MINIMAX_H3_REFERENCE_IMAGE_LIMIT} image references`);
      }
      urls.push(trimmed);
      logInfo('[Video Adapter] Minimax H3 reference image accepted:', {
        source,
        index: urls.length - 1,
        url: trimmed,
      });
      return;
    }

    logWarn('[Video Adapter] Minimax H3 reference image skipped: URL is not public HTTP(S)', {
      source,
      url: trimmed,
    });
  };

  addUrl(request.referenceImageUrl, 'referenceImageUrl');

  const files = request.files || [];
  logInfo('[Video Adapter] Minimax H3 reference image build started:', {
    directReferenceImageUrl: request.referenceImageUrl || null,
    fileCount: files.length,
    imageFileCount: files.filter((file) => file?.mimeType.startsWith('image/')).length,
  });

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file) continue;
    if (!file.mimeType.startsWith('image/')) {
      logDebug('[Video Adapter] Minimax H3 reference file skipped: not an image', {
        index,
        mimeType: file.mimeType,
      });
      continue;
    }
    if (urls.length >= MINIMAX_H3_REFERENCE_IMAGE_LIMIT) {
      throw new Error(`Minimax H3 supports up to ${MINIMAX_H3_REFERENCE_IMAGE_LIMIT} image references`);
    }

    const filename = `minimax-h3-reference-${Date.now()}-${index}`;
    logInfo('[Video Adapter] Minimax H3 reference image upload started:', {
      index,
      mimeType: file.mimeType,
      dataLength: file.data.length,
      filename,
    });

    const uploadedUrl = await uploadToImageBucket(
      dataUrlForFile(file),
      filename,
      { publicBaseUrl: request.publicBaseUrl, preferDirectS3Url: true }
    );

    logInfo('[Video Adapter] Minimax H3 reference image upload finished:', {
      index,
      mimeType: file.mimeType,
      filename,
      uploadedUrl,
    });

    if (!uploadedUrl || !isPublicMinimaxReferenceUrl(uploadedUrl)) {
      throw new Error('Minimax H3 image-to-video requires a public image bucket URL');
    }

    addUrl(uploadedUrl, `files[${index}]`);
  }

  logInfo('[Video Adapter] Minimax H3 reference image build completed:', {
    referenceImages: urls.map((url, index) => ({ index, url })),
  });

  return urls.map((url) => ({ url }));
}

function getObjectValue(source: unknown, path: string[]): unknown {
  let current = source;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function extractMinimaxH3TaskId(payload: unknown): string | null {
  const candidates = [
    getObjectValue(payload, ['id']),
    getObjectValue(payload, ['data', 'id']),
    getObjectValue(payload, ['task_id']),
    getObjectValue(payload, ['data', 'task_id']),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function extractMinimaxH3Status(payload: unknown): string {
  const candidates = [
    getObjectValue(payload, ['status']),
    getObjectValue(payload, ['data', 'status']),
    getObjectValue(payload, ['state']),
    getObjectValue(payload, ['data', 'state']),
    getObjectValue(payload, ['task_status']),
    getObjectValue(payload, ['data', 'task_status']),
    getObjectValue(payload, ['metadata', 'status']),
    getObjectValue(payload, ['data', 'metadata', 'status']),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().toLowerCase();
    }
  }

  const nestedStatus = collectMinimaxH3StringDiagnostics(payload).find(({ path, value }) => {
    const key = path[path.length - 1]?.toLowerCase() || '';
    return ['status', 'state', 'task_status'].includes(key) && value.trim();
  });

  if (nestedStatus) {
    return nestedStatus.value.trim().toLowerCase();
  }

  return 'unknown';
}

function isMinimaxH3FailureMessage(message: string | null): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    text.includes('upstream returned unrecognized message') ||
    text.includes('unrecognized message') ||
    text.includes('generation failed') ||
    text.includes('task failed') ||
    text.includes('failed') ||
    text.includes('failure') ||
    text.includes('error') ||
    text.includes('invalid') ||
    text.includes('rejected') ||
    text.includes('unsupported') ||
    text.includes('canceled') ||
    text.includes('cancelled') ||
    text.includes('unauthorized') ||
    text.includes('forbidden') ||
    text.includes('permission denied') ||
    text.includes('insufficient') ||
    text.includes('quota') ||
    text.includes('rate limit') ||
    text.includes('exceeded')
  );
}

type MinimaxH3StringDiagnostic = {
  path: string[];
  value: string;
};

function isMinimaxH3ErrorPath(path: string[]): boolean {
  const joined = path.join('.').toLowerCase();
  return (
    joined.includes('error') ||
    joined.includes('detail') ||
    joined.includes('reason') ||
    joined.includes('message') ||
    joined.includes('failure') ||
    joined.includes('exception') ||
    joined.includes('cause')
  );
}

function isMinimaxH3StatusPath(path: string[]): boolean {
  const key = path[path.length - 1]?.toLowerCase() || '';
  return ['status', 'state', 'task_status'].includes(key);
}

function collectMinimaxH3StringDiagnostics(
  payload: unknown,
  path: string[] = [],
  depth = 0,
  visited = new Set<unknown>()
): MinimaxH3StringDiagnostic[] {
  if (depth > 8 || payload === null || payload === undefined) return [];

  if (typeof payload === 'string') {
    const value = payload.trim();
    if (!value) return [];

    const nestedStart = value[0];
    if ((nestedStart === '{' || nestedStart === '[') && value.length < 100_000) {
      try {
        return collectMinimaxH3StringDiagnostics(JSON.parse(value), path, depth + 1, visited);
      } catch {
        // Keep the original string when it is not parseable JSON.
      }
    }

    if (
      isMinimaxH3FailureMessage(value) ||
      isMinimaxH3ErrorPath(path) ||
      isMinimaxH3StatusPath(path) ||
      path.length === 0
    ) {
      return [{ path, value }];
    }

    return [];
  }

  if (typeof payload !== 'object') return [];
  if (visited.has(payload)) return [];
  visited.add(payload);

  const diagnostics: MinimaxH3StringDiagnostic[] = [];
  if (Array.isArray(payload)) {
    payload.forEach((item, index) => {
      diagnostics.push(...collectMinimaxH3StringDiagnostics(item, [...path, String(index)], depth + 1, visited));
    });
    return diagnostics;
  }

  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    diagnostics.push(...collectMinimaxH3StringDiagnostics(value, [...path, key], depth + 1, visited));
  }

  return diagnostics;
}

function extractMinimaxH3Error(payload: unknown): string | null {
  const upstream = extractUpstreamErrorMessage(payload);
  if (upstream) return upstream;

  const candidates = [
    getObjectValue(payload, ['message']),
    getObjectValue(payload, ['data', 'message']),
    getObjectValue(payload, ['error_message']),
    getObjectValue(payload, ['data', 'error_message']),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  const diagnostics = collectMinimaxH3StringDiagnostics(payload);
  const terminal = diagnostics.find(({ value }) => isMinimaxH3FailureMessage(value));
  if (terminal) return terminal.value;

  const errorField = diagnostics.find(({ path, value }) => isMinimaxH3ErrorPath(path) && value.trim());
  if (errorField) return errorField.value;

  return null;
}

function isMinimaxH3CompletedStatus(status: string): boolean {
  return ['completed', 'complete', 'succeeded', 'success', 'done'].includes(status);
}

function isMinimaxH3TerminalStatus(status: string): boolean {
  return ['failed', 'failure', 'error', 'rejected', 'canceled', 'cancelled'].includes(status);
}

function isMinimaxH3ActiveStatus(status: string): boolean {
  return ['unknown', 'pending', 'queued', 'running', 'processing', 'in_progress', 'submitted', 'created', 'waiting'].includes(status);
}

function stringifyMinimaxH3PayloadSnippet(payload: unknown, max = 600): string {
  try {
    return compactSnippet(JSON.stringify(payload), max);
  } catch {
    return compactSnippet(String(payload || ''), max);
  }
}

function extractMinimaxH3VideoUrl(payload: unknown, baseUrl: string): string | null {
  const candidates = [
    getObjectValue(payload, ['metadata', 'url']),
    getObjectValue(payload, ['data', 'metadata', 'url']),
    getObjectValue(payload, ['url']),
    getObjectValue(payload, ['data', 'url']),
    getObjectValue(payload, ['video_url']),
    getObjectValue(payload, ['data', 'video_url']),
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = normalizeExtractedUrl(candidate, baseUrl);
    if (normalized) return normalized;
  }

  return extractVideoUrlFromUnknownPayload(payload, baseUrl);
}

async function readJsonResponse(response: Awaited<ReturnType<typeof undiciFetch>>): Promise<unknown> {
  const rawBody = await response.text();
  if (!rawBody.trim()) return null;

  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

async function downloadMinimaxH3Content(
  baseUrl: string,
  apiKey: string,
  taskId: string
): Promise<string> {
  const response = await fetchWithRetry(undiciFetch, `${baseUrl}/v1/videos/${encodeURIComponent(taskId)}/content`, () => ({
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'video/*,*/*',
    },
  }), {
    attempts: 4,
    baseDelayMs: 1_000,
    maxDelayMs: 8_000,
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`Minimax H3 content download failed (${response.status})${details ? `: ${compactSnippet(details, 300)}` : ''}`);
  }

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'video/mp4';
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

async function waitForMinimaxH3Task(
  baseUrl: string,
  apiKey: string,
  taskId: string,
  onProgress?: (progress: number) => void
): Promise<string> {
  const startedAt = Date.now();
  let lastProgress = 10;
  const loggedPollSignatures = new Set<string>();
  onProgress?.(lastProgress);

  while (Date.now() - startedAt < MINIMAX_H3_MAX_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, MINIMAX_H3_POLL_INTERVAL_MS));

    const response = await fetchWithRetry(undiciFetch, `${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`, () => ({
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    }), {
      attempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 8_000,
    });

    const payload = await readJsonResponse(response);
    if (!response.ok) {
      const detail = extractMinimaxH3Error(payload) || compactSnippet(String(payload || ''), 300);
      throw new Error(`Minimax H3 status request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    const status = extractMinimaxH3Status(payload);
    const errorMessage = extractMinimaxH3Error(payload);
    const hasTerminalError = isMinimaxH3TerminalStatus(status) || isMinimaxH3FailureMessage(errorMessage);

    if (hasTerminalError) {
      logWarn('[Video Adapter] Minimax H3 terminal error message detected:', {
        taskId,
        status,
        errorMessage,
        payload: stringifyMinimaxH3PayloadSnippet(payload),
      });
      throw new Error(errorMessage || 'Minimax H3 generation failed');
    }

    if (isMinimaxH3CompletedStatus(status)) {
      onProgress?.(95);
      const videoUrl = extractMinimaxH3VideoUrl(payload, baseUrl);
      return videoUrl || downloadMinimaxH3Content(baseUrl, apiKey, taskId);
    }

    if (!isMinimaxH3ActiveStatus(status)) {
      const signature = `${status}:${stringifyMinimaxH3PayloadSnippet(payload, 240)}`;
      if (!loggedPollSignatures.has(signature)) {
        loggedPollSignatures.add(signature);
        logWarn('[Video Adapter] Minimax H3 unexpected poll status:', {
          taskId,
          status,
          errorMessage,
          payload: stringifyMinimaxH3PayloadSnippet(payload),
        });
      }
    } else if (status === 'unknown') {
      const signature = `${status}:${stringifyMinimaxH3PayloadSnippet(payload, 240)}`;
      if (!loggedPollSignatures.has(signature)) {
        loggedPollSignatures.add(signature);
        logWarn('[Video Adapter] Minimax H3 poll response without status:', {
          taskId,
          errorMessage,
          payload: stringifyMinimaxH3PayloadSnippet(payload),
        });
      }
    }

    const elapsedRatio = Math.min(1, (Date.now() - startedAt) / MINIMAX_H3_MAX_WAIT_MS);
    const nextProgress = Math.max(lastProgress, Math.min(90, Math.floor(10 + elapsedRatio * 80)));
    if (nextProgress > lastProgress) {
      lastProgress = nextProgress;
      onProgress?.(nextProgress);
    }
  }

  throw new Error('Minimax H3 generation timed out');
}

async function generateViaMinimaxH3(
  channel: VideoChannel,
  model: VideoModel,
  request: SoraGenerateRequest,
  onProgress?: (progress: number) => void
): Promise<GenerateResult> {
  const baseUrl = normalizeMinimaxH3BaseUrl(channel, model);
  const apiKey = pickEffectiveApiKey(channel, model);

  if (!apiKey) {
    throw new Error('Minimax H3 channel is missing API Key');
  }

  const apiModel = (model.apiModel || request.model || 'minimax_h3-768p').trim();
  const seconds = normalizeMinimaxH3Seconds(request.duration || model.defaultDuration);
  const size = resolveMinimaxH3Size(apiModel, request.aspectRatio || model.defaultAspectRatio);
  const referenceImages = await buildMinimaxH3ReferenceImages(request);
  const referenceVideos = normalizeMinimaxH3ReferenceUrls(
    request.referenceVideoUrls,
    MINIMAX_H3_REFERENCE_VIDEO_LIMIT,
    'video'
  );
  const referenceAudios = normalizeMinimaxH3ReferenceUrls(
    request.referenceAudioUrls,
    MINIMAX_H3_REFERENCE_AUDIO_LIMIT,
    'audio'
  );
  const totalReferenceCount = referenceImages.length + referenceVideos.length + referenceAudios.length;

  if (totalReferenceCount > MINIMAX_H3_TOTAL_REFERENCE_LIMIT) {
    throw new Error(`Minimax H3 supports up to ${MINIMAX_H3_TOTAL_REFERENCE_LIMIT} total references`);
  }

  const payload: Record<string, unknown> = {
    model: apiModel,
    prompt: request.prompt || 'Generate a video',
    seconds: String(seconds),
    size,
  };

  if (referenceImages.length > 0) {
    payload.reference_images = referenceImages;
  }
  if (referenceVideos.length > 0) {
    payload.reference_videos = referenceVideos;
  }
  if (referenceAudios.length > 0) {
    payload.reference_audios = referenceAudios;
  }

  onProgress?.(5);

  logInfo('[Video Adapter] Minimax H3 create request:', {
    channelName: channel.name,
    apiUrl: `${baseUrl}/v1/videos`,
    model: apiModel,
    seconds,
    size,
    referenceImageCount: referenceImages.length,
    referenceImages,
    referenceVideoCount: referenceVideos.length,
    referenceVideos,
    referenceAudioCount: referenceAudios.length,
    referenceAudios,
    requestPayload: payload,
  });

  const response = await fetchWithRetry(undiciFetch, `${baseUrl}/v1/videos`, () => ({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  }), {
    attempts: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 8_000,
  });

  const responsePayload = await readJsonResponse(response);
  if (!response.ok) {
    const detail = extractMinimaxH3Error(responsePayload) || compactSnippet(String(responsePayload || ''), 400);
    throw new Error(`Minimax H3 create request failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }

  const taskId = extractMinimaxH3TaskId(responsePayload);
  if (!taskId) {
    throw new Error('Minimax H3 create response did not include a task id');
  }

  const url = await waitForMinimaxH3Task(baseUrl, apiKey, taskId, onProgress);
  onProgress?.(100);

  return {
    type: 'sora-video',
    url,
    cost: resolveVideoGenerationCost((await getSystemConfig()).pricing, request, model),
    videoId: taskId,
    videoChannelId: channel.id,
  };
}

function resolveRequestedVideoLengthSeconds(request: SoraGenerateRequest, model?: VideoModel): number {
  const requestConfig = request.videoConfigObject || request.video_config;
  if (typeof requestConfig?.video_length === 'number' && Number.isFinite(requestConfig.video_length)) {
    return Math.max(5, Math.min(GROK_MAX_VIDEO_LENGTH_SECONDS, Math.floor(requestConfig.video_length)));
  }

  if (request.duration && request.duration.trim()) {
    return normalizeGrokVideoLengthSeconds(request.duration);
  }

  if (typeof model?.videoConfigObject?.video_length === 'number' && Number.isFinite(model.videoConfigObject.video_length)) {
    return Math.max(5, Math.min(GROK_MAX_VIDEO_LENGTH_SECONDS, Math.floor(model.videoConfigObject.video_length)));
  }

  return normalizeGrokVideoLengthSeconds(model?.defaultDuration || request.model || '8s');
}

function resolveModelDurationCost(model: VideoModel, request: SoraGenerateRequest): number | null {
  if (!Array.isArray(model.durations) || model.durations.length === 0) return null;

  const requestedDurationValue = (request.duration || '').trim().toLowerCase();
  if (requestedDurationValue) {
    const exactValueMatch = model.durations.find(
      (duration) => duration.value.trim().toLowerCase() === requestedDurationValue
    );
    if (exactValueMatch && Number.isFinite(exactValueMatch.cost)) {
      return Math.max(0, exactValueMatch.cost);
    }
  }

  const requestedSeconds = resolveRequestedVideoLengthSeconds(request, model);
  const exactSecondsMatch = model.durations.find(
    (duration) => normalizeDurationSeconds(duration.value) === requestedSeconds
  );
  if (exactSecondsMatch && Number.isFinite(exactSecondsMatch.cost)) {
    return Math.max(0, exactSecondsMatch.cost);
  }

  const defaultMatch = model.durations.find(
    (duration) => duration.value === model.defaultDuration
  ) || model.durations[0];
  if (defaultMatch && Number.isFinite(defaultMatch.cost)) {
    return Math.max(0, defaultMatch.cost);
  }

  return null;
}

function isMinimaxH3PricingContext(request: SoraGenerateRequest, model?: VideoModel): boolean {
  const candidates = [
    model?.apiModel,
    model?.name,
    request.model,
  ];

  return candidates.some((candidate) => String(candidate || '').toLowerCase().includes('minimax_h3'));
}

export function countMinimaxH3ReferenceImages(request: SoraGenerateRequest): number {
  const fileImageCount = (request.files || []).filter((file) => file.mimeType.startsWith('image/')).length;
  const directReferenceCount = request.referenceImageUrl?.trim() ? 1 : 0;
  return fileImageCount + directReferenceCount;
}

export function resolveMinimaxH3ReferenceImageExtraCost(referenceImageCount: number): number {
  const extraImages = Math.max(0, referenceImageCount - MINIMAX_H3_FREE_REFERENCE_IMAGE_COUNT);
  return extraImages * MINIMAX_H3_EXTRA_REFERENCE_IMAGE_COST;
}

export function resolveVideoGenerationCost(
  pricing: { soraVideo10s: number; soraVideo15s: number; soraVideo25s: number },
  request: SoraGenerateRequest,
  model?: VideoModel
): number {
  const modelCost = model ? resolveModelDurationCost(model, request) : null;
  let baseCost: number;
  if (modelCost !== null) {
    baseCost = modelCost;
  } else {
    const durationHint = `${request.duration || ''} ${request.model || ''}`.toLowerCase();
    const requestedSeconds = resolveRequestedVideoLengthSeconds(request, model);

    if (durationHint.includes('25') || requestedSeconds >= 25) {
      baseCost = pricing.soraVideo25s;
    } else if (durationHint.includes('15') || requestedSeconds >= 15) {
      baseCost = pricing.soraVideo15s;
    } else {
      baseCost = pricing.soraVideo10s;
    }
  }

  if (!isMinimaxH3PricingContext(request, model)) {
    return baseCost;
  }

  return baseCost + resolveMinimaxH3ReferenceImageExtraCost(countMinimaxH3ReferenceImages(request));
}
function getTypeAndCost(
  model: string,
  pricing: { soraVideo10s: number; soraVideo15s: number; soraVideo25s: number }
): { type: 'sora-video'; cost: number } {
  if (model.includes('25s') || model.includes('25')) {
    return { type: 'sora-video', cost: pricing.soraVideo25s };
  }
  if (model.includes('15s') || model.includes('15')) {
    return { type: 'sora-video', cost: pricing.soraVideo15s };
  }
  return { type: 'sora-video', cost: pricing.soraVideo10s };
}

function parseLegacySoraModel(model: string): {
  apiModel: 'sora-2';
  orientation: 'landscape' | 'portrait';
  seconds: string;
  size?: string;
} {
  const normalizedModel = String(model || '').toLowerCase();
  const apiModel: 'sora-2' = 'sora-2';
  let orientation: 'landscape' | 'portrait' = 'landscape';
  let seconds = '8';

  if (normalizedModel.includes('portrait')) {
    orientation = 'portrait';
  }

  if (normalizedModel.includes('25s') || normalizedModel.includes('25')) {
    seconds = '20';
  } else if (normalizedModel.includes('15s') || normalizedModel.includes('15')) {
    seconds = '15';
  } else if (normalizedModel.includes('12s') || normalizedModel.includes('12')) {
    seconds = '12';
  } else if (normalizedModel.includes('10s') || normalizedModel.includes('10')) {
    seconds = '10';
  } else if (normalizedModel.includes('4s')) {
    seconds = '4';
  }

  const size = orientation === 'portrait' ? '720x1280' : '1280x720';
  return { apiModel, orientation, seconds, size };
}

function buildVideoMessages(request: ExternalVideoPayload): Array<{
  role: 'user';
  content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
}> {
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
    {
      type: 'text',
      text: request.prompt || 'Generate a video',
    },
  ];

  for (const file of request.files) {
    if (!file.mimeType.startsWith('image/')) continue;
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${file.mimeType};base64,${file.data}`,
      },
    });
  }

  return [{ role: 'user', content }];
}

async function generateViaExternalChat(
  channel: VideoChannel,
  model: VideoModel,
  request: SoraGenerateRequest,
  onProgress?: (progress: number) => void
): Promise<GenerateResult> {
  const effectiveBaseUrl = model.baseUrl || channel.baseUrl;
  const effectiveApiKey = model.apiKey || channel.apiKey;

  if (!effectiveBaseUrl || !effectiveApiKey) {
    throw new Error('视频渠道未配置 Base URL 或 API Key');
  }

  const resolvedModel = mapChannelModel(channel.type, model, request);
  const files = request.files || [];
  const prompt = request.prompt || '';
  const useStreamingResponse = channel.type === 'flow2api';

  const payload: Record<string, unknown> = {
    model: resolvedModel,
    messages: buildVideoMessages({ prompt, model: resolvedModel, files }),
    stream: useStreamingResponse,
  };

  if (channel.type === 'grok2api') {
    payload.video_config = resolveGrokVideoConfigObject(request, model);
  }

  const apiUrl = `${effectiveBaseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  onProgress?.(5);

  logInfo('[Video Adapter] External chat request:', {
    channelType: channel.type,
    channelName: channel.name,
    apiUrl,
    model: resolvedModel,
    stream: useStreamingResponse,
    hasImages: files.some((file) => file.mimeType.startsWith('image/')),
  });

  const response = await fetchWithRetry(undiciFetch, apiUrl, () => ({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${effectiveApiKey}`,
    },
    body: JSON.stringify(payload),
  }));

  if (!response.ok) {
    const rawBody = await response.text();
    let parsedBody: unknown = null;
    if (rawBody.trim()) {
      try {
        parsedBody = JSON.parse(rawBody) as ExternalChatResponse;
      } catch {
        parsedBody = null;
      }
    }
    const upstreamError = extractUpstreamErrorMessage(parsedBody);
    const detail = upstreamError || compactSnippet(rawBody, 400);
    logError('[Video Adapter] External chat failed:', {
      channelType: channel.type,
      channelName: channel.name,
      apiUrl,
      status: response.status,
      statusText: (response as { statusText?: string }).statusText || '',
      model: resolvedModel,
      stream: useStreamingResponse,
      imageCount: files.filter((file) => file.mimeType.startsWith('image/')).length,
      videoConfig: channel.type === 'grok2api' ? payload.video_config : undefined,
      response: detail || compactSnippet(rawBody, 400),
    });
    throw new Error(`上游返回错误 (${response.status})${detail ? `: ${detail}` : ''}`);
  }

  let rawUrl: string | null = null;
  let upstreamMessage = '';
  let rawBody = '';

  if (useStreamingResponse) {
    const parsedStream = await readStreamingExternalChatResponse(
      response as unknown as Response,
      effectiveBaseUrl,
      onProgress
    );
    rawBody = parsedStream.rawBody;
    rawUrl = parsedStream.url;
    upstreamMessage = parsedStream.errorMessage || parsedStream.text;
  } else {
    rawBody = await response.text();
    let parsedBody: unknown = null;
    if (rawBody.trim()) {
      try {
        parsedBody = JSON.parse(rawBody) as ExternalChatResponse;
      } catch {
        parsedBody = null;
      }
    }
    rawUrl = extractVideoUrlFromUnknownPayload(parsedBody, effectiveBaseUrl);
    upstreamMessage = extractContentFromExternalChatPayload(parsedBody);
  }

  if (!rawUrl) {
    const message = compactSnippet(upstreamMessage, 220);
    if (message) {
      logWarn('[Video Adapter] Upstream response without video URL:', message);
      throw new Error(`上游未返回视频链接: ${message}`);
    }
    logWarn('[Video Adapter] Unrecognized upstream payload:', compactSnippet(rawBody, 300));
    throw new Error('无法从上游响应中解析视频链接');
  }

  onProgress?.(100);

  const cost = resolveVideoGenerationCost((await getSystemConfig()).pricing, request, model);
  return {
    type: 'sora-video',
    url: rawUrl,
    cost,
    videoChannelId: channel.id,
  };
}

async function generateViaSoraApi(
  request: SoraGenerateRequest,
  onProgress?: (progress: number) => void,
  channelId?: string
): Promise<GenerateResult> {
  const config = await getSystemConfig();
  const { apiModel, orientation, seconds, size } = parseLegacySoraModel(request.model);

  const videoRequest: VideoGenerationRequest = {
    prompt: request.prompt,
    model: apiModel,
    orientation,
    seconds,
    size,
  };

  if (request.files && request.files.length > 0) {
    const imageFile = request.files.find((file) => file.mimeType.startsWith('image/'));
    if (imageFile) {
      videoRequest.input_image = imageFile.data;
    }
  }

  if (request.style_id) {
    videoRequest.style_id = request.style_id;
  }
  if (request.remix_target_id) {
    videoRequest.remix_target_id = request.remix_target_id;
  }

  const result = await generateVideo(
    videoRequest,
    onProgress ? (progress) => onProgress(progress) : undefined,
    channelId ? { channelId } : undefined
  );

  if (!result.data || result.data.length === 0 || !result.data[0].url) {
    throw new Error('视频生成失败：未返回有效的视频 URL');
  }

  const first = result.data[0];
  const { type, cost } = getTypeAndCost(request.model, config.pricing);

  return {
    type,
    url: first.url,
    cost,
    videoId: result.id,
    videoChannelId: result.channelId,
    permalink: typeof first.permalink === 'string' ? first.permalink : undefined,
    revised_prompt: typeof first.revised_prompt === 'string' ? first.revised_prompt : undefined,
  };
}

async function generateByVideoModel(
  request: SoraGenerateRequest,
  onProgress?: (progress: number) => void
): Promise<GenerateResult | null> {
  if (!request.modelId) return null;

  const modelConfig = await getVideoModelWithChannel(request.modelId);
  if (!modelConfig) {
    throw new Error('视频模型不存在或未配置');
  }

  const { model, channel } = modelConfig;

  if (!model.enabled) {
    throw new Error('视频模型已禁用');
  }
  if (!channel.enabled) {
    throw new Error('视频渠道已禁用');
  }

  const channelType = channel.type;
  if (channelType === 'minimax-h3') {
    return generateViaMinimaxH3(channel, model, request, onProgress);
  }

  if (channelType === 'flow2api' || channelType === 'grok2api' || channelType === 'openai-compatible') {
    return generateViaExternalChat(channel, model, request, onProgress);
  }

  if (channelType === 'sora' || channelType === 'apexerapi') {
    const ratio = request.aspectRatio || model.defaultAspectRatio || 'landscape';
    const duration = request.duration || model.defaultDuration || '8s';

    const fallbackRequest: SoraGenerateRequest = {
      ...request,
      model: `sora2-${ratio}-${duration}`,
    };
    return generateViaSoraApi(fallbackRequest, onProgress, channel.id);
  }

  throw new Error(`不支持的视频渠道类型: ${channelType}`);
}

export async function generateWithSora(
  request: SoraGenerateRequest,
  onProgress?: (progress: number) => void
): Promise<GenerateResult> {
  logDebug('[Sora] Request config:', {
    model: request.model,
    modelId: request.modelId,
    prompt: request.prompt?.substring(0, 50),
    hasFiles: request.files && request.files.length > 0,
    filesCount: request.files?.length || 0,
  });

  try {
    const routed = await generateByVideoModel(request, onProgress);
    if (routed) {
      logInfo('[Sora] Generation completed by dynamic channel:', {
        modelId: request.modelId,
        url: routed.url,
      });
      return routed;
    }

    const legacy = await generateViaSoraApi(request, onProgress);
    logInfo('[Sora] Generation completed by legacy sora route:', {
      url: legacy.url,
    });
    return legacy;
  } catch (error) {
    logError('[Sora] Generation failed:', error);
    throw error;
  }
}
