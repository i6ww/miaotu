#!/usr/bin/env node
/* eslint-disable no-console */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import mysql from 'mysql2/promise';
import { File, FormData, fetch as undiciFetch } from 'undici';

const DEFAULT_LIMIT = 20;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_MIN_BYTES = 1024 * 1024;
const DEFAULT_SLEEP_MS = 500;
const DEFAULT_MAX_FAILURES = 10;
const DATA_URL_PATTERN = /^data:([^;]+);base64,(.+)$/s;
const DATA_DIR = process.env.DATA_DIR || './data';
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const S3_OBJECT_CACHE_CONTROL = 'public, max-age=604800';

const EXTENSION_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

const s3Clients = new Map();

function parseArgs(argv) {
  const options = {
    dryRun: true,
    limit: DEFAULT_LIMIT,
    batchSize: DEFAULT_BATCH_SIZE,
    minBytes: DEFAULT_MIN_BYTES,
    sleepMs: DEFAULT_SLEEP_MS,
    maxFailures: DEFAULT_MAX_FAILURES,
    localOnly: false,
    publicBaseUrl: process.env.SANHUB_PUBLIC_BASE_URL || process.env.NEXTAUTH_URL || '',
    preferDirectS3Url: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--execute') {
      options.dryRun = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--local-only') {
      options.localOnly = true;
    } else if (arg === '--prefer-direct-s3-url') {
      options.preferDirectS3Url = true;
    } else if (arg === '--limit' && next) {
      options.limit = parsePositiveInteger(next, '--limit');
      index += 1;
    } else if (arg === '--batch-size' && next) {
      options.batchSize = parsePositiveInteger(next, '--batch-size');
      index += 1;
    } else if (arg === '--min-bytes' && next) {
      options.minBytes = parsePositiveInteger(next, '--min-bytes');
      index += 1;
    } else if (arg === '--sleep-ms' && next) {
      options.sleepMs = parseNonNegativeInteger(next, '--sleep-ms');
      index += 1;
    } else if (arg === '--max-failures' && next) {
      options.maxFailures = parsePositiveInteger(next, '--max-failures');
      index += 1;
    } else if (arg === '--public-base-url' && next) {
      options.publicBaseUrl = next;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/migrate-generation-result-media.mjs [options]

Options:
  --dry-run                 Preview rows without writing. This is the default.
  --execute                 Upload/save media and update generations.result_url.
  --limit <n>               Maximum rows to inspect in this run. Default: ${DEFAULT_LIMIT}.
  --batch-size <n>          Rows processed before a pause. Default: ${DEFAULT_BATCH_SIZE}.
  --min-bytes <n>           Minimum result_url bytes to migrate. Default: ${DEFAULT_MIN_BYTES}.
  --sleep-ms <n>            Pause between batches. Default: ${DEFAULT_SLEEP_MS}.
  --max-failures <n>        Stop after this many row failures. Default: ${DEFAULT_MAX_FAILURES}.
  --local-only              Skip remote bucket upload and save files under DATA_DIR/media.
  --public-base-url <url>   Public base URL for S3 cache URLs. Default: SANHUB_PUBLIC_BASE_URL or NEXTAUTH_URL.
  --prefer-direct-s3-url    Store direct S3 public URLs instead of /cache/s3 URLs.
`);
}

function parseBooleanEnv(value) {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'required', 'require'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(normalized)) return false;
  return undefined;
}

function parseIntegerEnv(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildMySqlSslConfig() {
  const sslToggle = parseBooleanEnv(process.env.MYSQL_SSL || process.env.DB_SSL);
  if (sslToggle === false) return undefined;
  if (sslToggle !== true) return undefined;
  return {
    rejectUnauthorized:
      parseBooleanEnv(process.env.MYSQL_SSL_REJECT_UNAUTHORIZED || process.env.DB_SSL_REJECT_UNAUTHORIZED) !== false,
  };
}

async function createPool() {
  const database = process.env.MYSQL_DATABASE || process.env.DB_NAME || process.env.MYSQL_DB || 'sanhub';
  const host = process.env.MYSQL_HOST || process.env.DB_HOST || 'localhost';
  const port = parseIntegerEnv(process.env.MYSQL_PORT || process.env.DB_PORT, 3306);
  const user = process.env.MYSQL_USER || process.env.DB_USER || 'root';
  const password = process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD || '';
  const ssl = buildMySqlSslConfig();

  return mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 2,
    queueLimit: 0,
    charset: process.env.MYSQL_CHARSET || 'utf8mb4',
    timezone: process.env.MYSQL_TIMEZONE || 'Z',
    connectTimeout: parseIntegerEnv(process.env.MYSQL_CONNECT_TIMEOUT, 10000),
    ...(ssl ? { ssl } : {}),
  });
}

function normalizeSegment(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function normalizeBucketProvider(value) {
  return ['picui', 'lsky-v2', 's3-compatible'].includes(value) ? value : 'picui';
}

function sanitizeBucket(value, index) {
  if (!value || typeof value !== 'object') return null;

  return {
    id: String(value.id || `bucket-${index + 1}`).trim(),
    name: String(value.name || `Bucket ${index + 1}`).trim(),
    provider: normalizeBucketProvider(value.provider),
    baseUrl: String(value.baseUrl || '').trim(),
    apiKey: String(value.apiKey || '').trim(),
    secretKey: typeof value.secretKey === 'string' ? value.secretKey.trim() : '',
    bucketName: typeof value.bucketName === 'string' ? value.bucketName.trim() : '',
    storageId: typeof value.storageId === 'string' ? value.storageId.trim() : '',
    region: typeof value.region === 'string' ? value.region.trim() : '',
    publicBaseUrl: typeof value.publicBaseUrl === 'string' ? value.publicBaseUrl.trim() : '',
    pathPrefix: typeof value.pathPrefix === 'string' ? value.pathPrefix.trim() : '',
    forcePathStyle: value.forcePathStyle !== false,
    enabled: value.enabled !== false,
  };
}

function parseImageStorageBuckets(raw) {
  if (!raw) return [];

  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];
  return parsed.map((value, index) => sanitizeBucket(value, index)).filter(Boolean);
}

function buildLegacyPicuiBucket(baseUrl, apiKey) {
  if (!baseUrl && !apiKey) return null;

  return {
    id: 'legacy-picui',
    name: 'Legacy PicUI',
    provider: 'picui',
    baseUrl: String(baseUrl || '').trim(),
    apiKey: String(apiKey || '').trim(),
    enabled: true,
    forcePathStyle: true,
  };
}

async function resolveDefaultImageBucket(pool) {
  const [rows] = await pool.execute(
    `SELECT image_storage_buckets, image_storage_default_bucket_id, picui_base_url, picui_api_key
     FROM system_config
     WHERE id = 1`
  );
  const row = rows[0] || {};
  const buckets = parseImageStorageBuckets(row.image_storage_buckets);
  const enabledBuckets = buckets.filter((bucket) => bucket.enabled);

  if (enabledBuckets.length > 0) {
    const defaultBucketId = String(row.image_storage_default_bucket_id || '').trim();
    return enabledBuckets.find((bucket) => bucket.id === defaultBucketId) || enabledBuckets[0];
  }

  return buildLegacyPicuiBucket(row.picui_base_url, row.picui_api_key);
}

function getExtensionForMime(mimeType) {
  return EXTENSION_BY_MIME[String(mimeType || '').toLowerCase().split(';')[0]?.trim()] || 'bin';
}

function ensureFilenameExtension(filename, extension) {
  const trimmed = normalizeSegment(filename).split('/').pop() || `media_${Date.now()}.${extension}`;
  if (/\.[a-z0-9]{2,5}$/i.test(trimmed)) return trimmed;
  return `${trimmed}.${extension}`;
}

function buildObjectKey(bucket, filename) {
  const normalizedFilename = normalizeSegment(filename).split('/').pop() || filename;
  const prefix = normalizeSegment(bucket.pathPrefix || '');
  return prefix ? `${prefix}/${normalizedFilename}` : normalizedFilename;
}

function parseUploadPayload(dataUrl, filename, bucket) {
  const match = dataUrl.match(DATA_URL_PATTERN);
  if (!match) {
    throw new Error('Invalid data URL format');
  }

  const mimeType = match[1];
  const extension = getExtensionForMime(mimeType);
  const safeFilename = ensureFilenameExtension(filename || `media_${Date.now()}`, extension);
  const objectKey = buildObjectKey(bucket || { pathPrefix: '' }, safeFilename);

  return {
    buffer: Buffer.from(match[2], 'base64'),
    extension,
    filename: safeFilename,
    mimeType,
    objectKey,
  };
}

function extractUrl(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  const markdownLink = trimmed.match(/^\[[^\]]+\]\((https?:\/\/[^)]+)\)$/i);
  if (markdownLink) return markdownLink[1];
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

async function uploadToPicuiBucket(bucket, payload) {
  if (!bucket.baseUrl || !bucket.apiKey) return null;

  const formData = new FormData();
  formData.append('file', new File([payload.buffer], payload.filename, { type: payload.mimeType }));
  formData.append('permission', '1');

  const response = await undiciFetch(`${bucket.baseUrl.replace(/\/$/, '')}/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bucket.apiKey}`,
      Accept: 'application/json',
    },
    body: formData,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.status) {
    throw new Error(`PicUI upload failed: ${data.message || response.status}`);
  }

  return extractUrl(data.data?.links?.url);
}

async function uploadToLskyV2Bucket(bucket, payload) {
  if (!bucket.baseUrl || !bucket.apiKey || !bucket.storageId) return null;

  const formData = new FormData();
  formData.append('file', new File([payload.buffer], payload.filename, { type: payload.mimeType }));
  formData.append('storage_id', bucket.storageId);

  const response = await undiciFetch(`${bucket.baseUrl.replace(/\/$/, '')}/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bucket.apiKey}`,
      Accept: 'application/json',
    },
    body: formData,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.status !== 'success') {
    throw new Error(`Lsky v2 upload failed: ${data.message || response.status}`);
  }

  return extractUrl(data.data?.public_url);
}

function getS3Client(bucket) {
  const cacheKey = [
    bucket.id,
    bucket.baseUrl,
    bucket.region,
    bucket.apiKey,
    bucket.secretKey,
    bucket.forcePathStyle,
  ].join('|');

  const cached = s3Clients.get(cacheKey);
  if (cached) return cached;

  const client = new S3Client({
    region: bucket.region || 'us-east-1',
    endpoint: bucket.baseUrl,
    forcePathStyle: bucket.forcePathStyle !== false,
    credentials: {
      accessKeyId: bucket.apiKey,
      secretAccessKey: bucket.secretKey || '',
    },
  });
  s3Clients.set(cacheKey, client);
  return client;
}

function normalizePublicBaseUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function buildS3CacheUrl(bucket, objectKey, publicBaseUrl) {
  const params = new URLSearchParams();
  params.set('key', objectKey);
  params.set('bucket', bucket.id);
  const baseUrl = normalizePublicBaseUrl(publicBaseUrl);
  return `${baseUrl}/cache/s3?${params.toString()}`;
}

function encodeObjectKey(key) {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildDirectS3PublicUrl(bucket, objectKey) {
  const encodedKey = encodeObjectKey(objectKey);
  if (bucket.publicBaseUrl) {
    return `${bucket.publicBaseUrl.replace(/\/$/, '')}/${encodedKey}`;
  }
  return `${bucket.baseUrl.replace(/\/$/, '')}/${bucket.bucketName}/${encodedKey}`;
}

async function uploadToS3Bucket(bucket, payload, options) {
  if (!bucket.baseUrl || !bucket.apiKey || !bucket.secretKey || !bucket.bucketName) return null;

  const client = getS3Client(bucket);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket.bucketName,
      Key: payload.objectKey,
      Body: payload.buffer,
      ContentType: payload.mimeType,
      CacheControl: S3_OBJECT_CACHE_CONTROL,
    })
  );

  if (options.preferDirectS3Url) {
    return buildDirectS3PublicUrl(bucket, payload.objectKey);
  }
  return buildS3CacheUrl(bucket, payload.objectKey, options.publicBaseUrl);
}

async function uploadToImageBucket(bucket, payload, options) {
  if (!bucket) return null;
  if (bucket.provider === 's3-compatible') return await uploadToS3Bucket(bucket, payload, options);
  if (!payload.mimeType.startsWith('image/')) return null;
  if (bucket.provider === 'lsky-v2') return await uploadToLskyV2Bucket(bucket, payload);
  return await uploadToPicuiBucket(bucket, payload);
}

async function saveMediaToFile(id, dataUrl) {
  if (process.env.MEDIA_FILE_STORAGE === 'false') {
    throw new Error('Local media storage is disabled');
  }

  const payload = parseUploadPayload(dataUrl, `${id}`);
  await fs.mkdir(MEDIA_DIR, { recursive: true });

  const filename = `${id}.${payload.extension}`;
  const filepath = path.join(MEDIA_DIR, filename);
  await fs.writeFile(filepath, payload.buffer);
  return `file:${filename}`;
}

async function saveMedia(pool, row, dataUrl, options) {
  const payload = parseUploadPayload(dataUrl, `${row.id}`);

  if (!options.localOnly) {
    const bucket = await resolveDefaultImageBucket(pool);
    const uploadedUrl = await uploadToImageBucket(bucket, payload, options);
    if (uploadedUrl) return uploadedUrl;
  }

  return await saveMediaToFile(row.id, dataUrl);
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function getBaseline(pool, minBytes) {
  const [rows] = await pool.execute(
    `SELECT
       COUNT(*) AS rows_count,
       COALESCE(SUM(OCTET_LENGTH(result_url)), 0) AS total_bytes
     FROM generations
     WHERE result_url LIKE 'data:%;base64,%'
       AND OCTET_LENGTH(result_url) >= ?`,
    [minBytes]
  );
  return {
    count: Number(rows[0]?.rows_count || 0),
    bytes: Number(rows[0]?.total_bytes || 0),
  };
}

async function fetchCandidateRows(pool, options) {
  const [rows] = await pool.execute(
    `SELECT
       id,
       user_id,
       type,
       status,
       OCTET_LENGTH(result_url) AS result_bytes,
       created_at,
       updated_at
     FROM generations
     WHERE result_url LIKE 'data:%;base64,%'
       AND OCTET_LENGTH(result_url) >= ?
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
    [options.minBytes, options.limit]
  );
  return rows;
}

async function fetchGenerationResultUrl(pool, id) {
  const [rows] = await pool.execute(
    `SELECT result_url
     FROM generations
     WHERE id = ?`,
    [id]
  );
  const value = rows[0]?.result_url;
  return typeof value === 'string' ? value : '';
}

async function updateGenerationResultUrl(pool, id, nextUrl) {
  const [result] = await pool.execute(
    `UPDATE generations
     SET result_url = ?, updated_at = ?
     WHERE id = ?
       AND result_url LIKE 'data:%;base64,%'`,
    [nextUrl, Date.now(), id]
  );
  return Number(result.affectedRows || 0);
}

async function processRow(pool, row, options) {
  const resultUrl = await fetchGenerationResultUrl(pool, row.id);
  if (!DATA_URL_PATTERN.test(resultUrl)) {
    return { status: 'skipped', oldBytes: 0, newBytes: 0, reason: 'row is no longer a data URL' };
  }

  const oldBytes = Buffer.byteLength(resultUrl, 'utf8');

  if (options.dryRun) {
    return { status: 'previewed', oldBytes, newBytes: oldBytes, nextUrl: '[dry-run]' };
  }

  const nextUrl = await saveMedia(pool, row, resultUrl, options);
  if (!nextUrl || nextUrl.startsWith('data:')) {
    throw new Error('media save returned an invalid persistent URL');
  }

  const affectedRows = await updateGenerationResultUrl(pool, row.id, nextUrl);
  if (affectedRows !== 1) {
    throw new Error('generation row was not updated');
  }

  return {
    status: 'migrated',
    oldBytes,
    newBytes: Buffer.byteLength(nextUrl, 'utf8'),
    nextUrl,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pool = await createPool();
  const summary = {
    previewed: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    oldBytes: 0,
    newBytes: 0,
  };

  try {
    const baseline = await getBaseline(pool, options.minBytes);
    const rows = await fetchCandidateRows(pool, options);

    console.log(`[Migration] Mode: ${options.dryRun ? 'dry-run' : 'execute'}`);
    console.log(`[Migration] Candidates above threshold: ${baseline.count} rows, ${formatBytes(baseline.bytes)}`);
    console.log(`[Migration] Rows selected this run: ${rows.length}`);

    if (rows.length === 0) return;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];

      try {
        const result = await processRow(pool, row, options);
        summary[result.status] += 1;
        summary.oldBytes += result.oldBytes;
        summary.newBytes += result.newBytes;

        const detail = result.nextUrl ? ` -> ${String(result.nextUrl).slice(0, 96)}` : '';
        console.log(
          `[Migration] ${result.status}: ${row.id} ${formatBytes(result.oldBytes)}${detail}`
        );
      } catch (error) {
        summary.failed += 1;
        console.error(`[Migration] failed: ${row.id}`, error);
        if (summary.failed >= options.maxFailures) {
          throw new Error(`Stopped after ${summary.failed} failures`);
        }
      }

      const shouldPause = (index + 1) % options.batchSize === 0 && index + 1 < rows.length;
      if (shouldPause) {
        await sleep(options.sleepMs);
      }
    }
  } finally {
    await pool.end();
  }

  console.log('[Migration] Summary:', {
    ...summary,
    oldBytes: formatBytes(summary.oldBytes),
    newBytes: formatBytes(summary.newBytes),
    estimatedReclaimed: formatBytes(Math.max(0, summary.oldBytes - summary.newBytes)),
  });
}

main().catch((error) => {
  console.error('[Migration] Fatal error:', error);
  process.exit(1);
});
