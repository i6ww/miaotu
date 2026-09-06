/* eslint-disable no-console */
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import {
  resolveDefaultImageBucket,
  uploadBufferToS3CompatibleBucket,
  uploadBufferToImageBucket,
  uploadToPicUI,
} from './picui';
import { fetchWithRetry } from './http-retry';

// ========================================
// Media file storage
// Stores base64 media as files to keep database rows small.
// ========================================

const DATA_DIR = process.env.DATA_DIR || './data';
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const MAX_REMOTE_MEDIA_BYTES = Math.max(
  1,
  Number(process.env.MEDIA_REMOTE_CACHE_MAX_BYTES) || 512 * 1024 * 1024
);
const USE_FILE_STORAGE = process.env.MEDIA_FILE_STORAGE !== 'false';

type SaveMediaOptions = {
  publicBaseUrl?: string;
  filename?: string;
};

export type MediaStorageMetrics = {
  inputKind: 'remote-url' | 'data-url' | 'identifier';
  outputKind: 'remote-url' | 'remote-bucket' | 'local-file' | 'identifier';
  bucketResolveDurationMs: number;
  mediaDownloadDurationMs: number;
  mediaUploadDurationMs: number;
  totalDurationMs: number;
  error?: string;
};

export type SaveMediaWithMetricsResult = {
  url: string;
  metrics: MediaStorageMetrics;
};

export type LocalMediaCleanupResult = {
  mediaDir: string;
  referencedFiles: number;
  totalFiles: number;
  orphanFiles: number;
  totalBytes: number;
  orphanBytes: number;
  deletedFiles: number;
  deletedBytes: number;
  failed: Array<{ fileName: string; error: string }>;
};

// Ensure the media directory exists.
async function ensureMediaDir(): Promise<void> {
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
}

// Extract mime type and payload from a base64 data URL.
function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const trimmed = dataUrl.trim();
  if (!trimmed.startsWith('data:')) return null;

  const commaIndex = trimmed.indexOf(',');
  if (commaIndex <= 5) return null;

  const meta = trimmed.slice(5, commaIndex).trim();
  const data = trimmed.slice(commaIndex + 1).trim();
  if (!meta || !data) return null;

  const parts = meta.split(';').map((part) => part.trim()).filter(Boolean);
  if (!parts.some((part) => part.toLowerCase() === 'base64')) return null;

  const mimeType = parts.find((part) => part !== 'base64' && !part.includes('=')) || '';
  if (!mimeType) return null;

  return {
    mimeType,
    data,
  };
}

// Resolve a file extension from a mime type.
function getExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'video/mkv': 'mkv',
    'application/x-mpegurl': 'm3u8',
    'application/vnd.apple.mpegurl': 'm3u8',
  };
  return map[mimeType] || 'bin';
}

function isRemoteUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

function getInputKind(value: string): MediaStorageMetrics['inputKind'] {
  if (isRemoteUrl(value)) return 'remote-url';
  if (value.startsWith('data:')) return 'data-url';
  return 'identifier';
}

export function getLocalMediaFilename(identifier: string): string | null {
  const trimmed = identifier.trim();
  if (!trimmed.startsWith('file:')) return null;

  const rawFilename = trimmed.slice(5).trim();
  if (!rawFilename) return null;

  const normalized = rawFilename.replace(/\\/g, '/').split('/').pop() || '';
  return normalized || null;
}

function filenameFromUrl(id: string, mediaUrl: string, mimeType: string): string {
  try {
    const parsed = new URL(mediaUrl);
    const basename = path.basename(parsed.pathname);
    if (basename && basename !== '/' && /\.[a-z0-9]{2,5}$/i.test(basename)) {
      return `${id}-${basename}`;
    }
  } catch {
    // ignore
  }
  return `${id}.${getExtension(mimeType)}`;
}

async function downloadRemoteMedia(mediaUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const response = await fetchWithRetry(fetch, mediaUrl, () => ({
    method: 'GET',
    headers: {
      Accept: 'image/*,video/*,*/*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  }), {
    attempts: 4,
    baseDelayMs: 500,
    maxDelayMs: 6000,
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`remote media download failed (${response.status})${details ? `: ${details.slice(0, 200)}` : ''}`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_REMOTE_MEDIA_BYTES) {
    throw new Error(`remote media exceeds cache limit: ${contentLength} bytes`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > MAX_REMOTE_MEDIA_BYTES) {
    throw new Error(`remote media exceeds cache limit: ${buffer.length} bytes`);
  }

  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  return { buffer, mimeType };
}

/**
 * Save a base64 data URL as a local media file.
 * @param id Unique identifier, usually a generation ID.
 * @param dataUrl Base64 data URL.
 * @returns File identifier suitable for database storage.
 */
export async function saveMediaToFile(id: string, dataUrl: string): Promise<string> {
  // Non-data URLs are already compact external identifiers.
  if (!dataUrl.startsWith('data:')) {
    return dataUrl;
  }

  // Local file storage is enabled by default.
  if (!USE_FILE_STORAGE) {
    throw new Error('Local media storage is disabled');
  }

  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    throw new Error('Invalid data URL format');
  }

  try {
    await ensureMediaDir();

    const ext = getExtension(parsed.mimeType);
    const filename = `${id}.${ext}`;
    const filepath = path.join(MEDIA_DIR, filename);

    // Decode the payload before writing it to the persistent media volume.
    const buffer = Buffer.from(parsed.data, 'base64');
    await fsp.writeFile(filepath, buffer);

    console.log(`[MediaStorage] Saved: ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`);

    // The file: prefix is resolved by the media API.
    return `file:${filename}`;
  } catch (error) {
    console.error('[MediaStorage] Failed to save file:', error);
    // Keep failures explicit so callers do not persist the original data URL.
    throw error;
  }
}

/**
 * Save generated media, preferring the configured image bucket.
 * @param id Unique identifier, usually a generation ID.
 * @param dataUrl Remote URL, base64 data URL, or another media identifier.
 * @returns Remote URL, local file identifier, or compact external identifier.
 */
export async function saveMediaAsync(
  id: string,
  dataUrl: string,
  options: SaveMediaOptions = {}
): Promise<string> {
  const result = await saveMediaWithMetrics(id, dataUrl, options);
  return result.url;
}

export async function saveVideoMediaPreferS3(
  id: string,
  mediaUrl: string,
  options: SaveMediaOptions = {}
): Promise<string> {
  let buffer: Buffer;
  let mimeType: string;

  try {
    if (isRemoteUrl(mediaUrl)) {
      const remote = await downloadRemoteMedia(mediaUrl);
      buffer = remote.buffer;
      mimeType = remote.mimeType;
    } else if (mediaUrl.startsWith('data:')) {
      const parsed = parseDataUrl(mediaUrl);
      if (!parsed) {
        throw new Error('Invalid video data URL format');
      }
      buffer = Buffer.from(parsed.data, 'base64');
      mimeType = parsed.mimeType;
    } else {
      return mediaUrl;
    }

    const filename = options.filename || filenameFromUrl(id, mediaUrl, mimeType);
    const uploadedUrl = await uploadBufferToS3CompatibleBucket(buffer, mimeType, filename, {
      requirePublicBaseUrl: true,
    });
    if (uploadedUrl) return uploadedUrl;

    console.warn('[MediaStorage] Generated video R2 upload unavailable, keeping original URL');
    return mediaUrl;
  } catch (error) {
    console.warn('[MediaStorage] Generated video R2 upload failed, keeping original URL:', error);
    return mediaUrl;
  }
}

export async function saveMediaWithMetrics(
  id: string,
  dataUrl: string,
  options: SaveMediaOptions = {}
): Promise<SaveMediaWithMetricsResult> {
  const startedAt = Date.now();
  const metrics: MediaStorageMetrics = {
    inputKind: getInputKind(dataUrl),
    outputKind: 'identifier',
    bucketResolveDurationMs: 0,
    mediaDownloadDurationMs: 0,
    mediaUploadDurationMs: 0,
    totalDurationMs: 0,
  };

  const bucketResolveStartedAt = Date.now();
  const configuredBucket = await resolveDefaultImageBucket();
  metrics.bucketResolveDurationMs = elapsedMs(bucketResolveStartedAt);

  if (isRemoteUrl(dataUrl)) {
    if (!configuredBucket) {
      metrics.outputKind = 'remote-url';
      metrics.totalDurationMs = elapsedMs(startedAt);
      return { url: dataUrl, metrics };
    }

    try {
      const downloadStartedAt = Date.now();
      const remote = await downloadRemoteMedia(dataUrl);
      metrics.mediaDownloadDurationMs += elapsedMs(downloadStartedAt);
      const filename = options.filename || filenameFromUrl(id, dataUrl, remote.mimeType);
      const uploadStartedAt = Date.now();
      const uploadedUrl = await uploadBufferToImageBucket(
        remote.buffer,
        remote.mimeType,
        filename,
        { publicBaseUrl: options.publicBaseUrl }
      );
      metrics.mediaUploadDurationMs += elapsedMs(uploadStartedAt);
      if (uploadedUrl) {
        console.log(`[MediaStorage] Cached remote media to bucket: ${uploadedUrl}`);
        metrics.outputKind = 'remote-bucket';
        metrics.totalDurationMs = elapsedMs(startedAt);
        return { url: uploadedUrl, metrics };
      }
    } catch (error) {
      metrics.error = error instanceof Error ? error.message : 'Remote media cache failed';
      console.warn('[MediaStorage] Remote media cache failed, keeping original URL:', error);
    }

    metrics.outputKind = 'remote-url';
    metrics.totalDurationMs = elapsedMs(startedAt);
    return { url: dataUrl, metrics };
  }

  // Compact non-data identifiers can be stored directly.
  if (!dataUrl.startsWith('data:')) {
    metrics.outputKind = 'identifier';
    metrics.totalDurationMs = elapsedMs(startedAt);
    return { url: dataUrl, metrics };
  }

  // Prefer the configured remote image bucket for base64 payloads.
  if (configuredBucket) {
    try {
      const parsed = parseDataUrl(dataUrl);
      const filename = options.filename || `${id}.${getExtension(parsed?.mimeType || 'image/jpeg')}`;
      const uploadStartedAt = Date.now();
      const picuiUrl = await uploadToPicUI(dataUrl, filename, { publicBaseUrl: options.publicBaseUrl });
      metrics.mediaUploadDurationMs += elapsedMs(uploadStartedAt);
      if (picuiUrl) {
        console.log(`[MediaStorage] Uploaded to remote bucket: ${picuiUrl}`);
        metrics.outputKind = 'remote-bucket';
        metrics.totalDurationMs = elapsedMs(startedAt);
        return { url: picuiUrl, metrics };
      }
    } catch (error) {
      metrics.error = error instanceof Error ? error.message : 'Remote upload failed';
      console.warn('[MediaStorage] Remote upload failed, falling back to local file storage:', error);
    }

    // Do not persist large base64 payloads when remote upload is unavailable.
    const uploadStartedAt = Date.now();
    const url = await saveMediaToFile(id, dataUrl);
    metrics.mediaUploadDurationMs += elapsedMs(uploadStartedAt);
    metrics.outputKind = 'local-file';
    metrics.totalDurationMs = elapsedMs(startedAt);
    return { url, metrics };
  }

  const uploadStartedAt = Date.now();
  const url = await saveMediaToFile(id, dataUrl);
  metrics.mediaUploadDurationMs += elapsedMs(uploadStartedAt);
  metrics.outputKind = 'local-file';
  metrics.totalDurationMs = elapsedMs(startedAt);
  return { url, metrics };
}

export async function cleanupLocalMediaFiles(
  referencedFiles: Set<string>,
  options: { deleteOrphans?: boolean } = {}
): Promise<LocalMediaCleanupResult> {
  await ensureMediaDir();

  const entries = await fsp.readdir(MEDIA_DIR, { withFileTypes: true });
  const result: LocalMediaCleanupResult = {
    mediaDir: MEDIA_DIR,
    referencedFiles: referencedFiles.size,
    totalFiles: 0,
    orphanFiles: 0,
    totalBytes: 0,
    orphanBytes: 0,
    deletedFiles: 0,
    deletedBytes: 0,
    failed: [],
  };

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const fileName = entry.name;
    const filePath = path.join(MEDIA_DIR, fileName);
    let size = 0;

    try {
      const stat = await fsp.stat(filePath);
      size = stat.size;
    } catch (error) {
      result.failed.push({
        fileName,
        error: error instanceof Error ? error.message : 'Failed to stat file',
      });
      continue;
    }

    result.totalFiles += 1;
    result.totalBytes += size;

    if (referencedFiles.has(fileName)) {
      continue;
    }

    result.orphanFiles += 1;
    result.orphanBytes += size;

    if (!options.deleteOrphans) {
      continue;
    }

    try {
      await fsp.unlink(filePath);
      result.deletedFiles += 1;
      result.deletedBytes += size;
    } catch (error) {
      result.failed.push({
        fileName,
        error: error instanceof Error ? error.message : 'Failed to delete file',
      });
    }
  }

  return result;
}

/**
 * Read a local media file.
 * @param identifier File identifier, such as file:xxx.png, or a full path.
 * @returns Media bytes and mime type, or null when unavailable.
 */
export async function readMediaFile(
  identifier: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    let filename: string;

    if (identifier.startsWith('file:')) {
      filename = identifier.slice(5);
    } else {
      // Accept legacy full paths or other file-like identifiers.
      filename = path.basename(identifier);
    }

    const filepath = path.join(MEDIA_DIR, filename);

    const buffer = await fsp.readFile(filepath);
    const ext = path.extname(filename).slice(1).toLowerCase();

    const mimeTypes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      mp4: 'video/mp4',
      webm: 'video/webm',
    };

    const mimeType = mimeTypes[ext] || 'application/octet-stream';

    return { buffer, mimeType };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    console.error('[MediaStorage] Failed to read file:', error);
    return null;
  }
}

/**
 * Delete a local media file.
 * @param identifier File identifier.
 */
export function deleteMediaFile(identifier: string): boolean {
  try {
    if (!identifier.startsWith('file:')) {
      return false;
    }

    const filename = identifier.slice(5);
    const filepath = path.join(MEDIA_DIR, filename);

    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      console.log(`[MediaStorage] Deleted: ${filename}`);
      return true;
    }

    return false;
  } catch (error) {
    console.error('[MediaStorage] Failed to delete file:', error);
    return false;
  }
}

/**
 * Check whether an identifier points to a local file.
 */
export function isLocalFile(identifier: string): boolean {
  return identifier.startsWith('file:');
}
