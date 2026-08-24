/* eslint-disable no-console */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ImageBucketConfig } from '@/types';
import { getSystemConfig } from './db';
import { fetch as undiciFetch, File, FormData } from 'undici';
import { fetchWithRetry } from './http-retry';

type UploadPayload = {
  buffer: Buffer;
  extension: string;
  filename: string;
  mimeType: string;
  objectKey: string;
};

type UploadOptions = {
  publicBaseUrl?: string;
  preferDirectS3Url?: boolean;
  requirePublicBaseUrl?: boolean;
};

export type S3CachedObject = {
  buffer: Buffer;
  contentType: string;
  contentLength: number;
  etag?: string;
  lastModified?: Date;
};

const EXTENSION_BY_MIME: Record<string, string> = {
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
  'video/x-matroska': 'mkv',
  'video/mkv': 'mkv',
  'application/x-mpegurl': 'm3u8',
  'application/vnd.apple.mpegurl': 'm3u8',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
};

const s3Clients = new Map<string, S3Client>();
const S3_OBJECT_CACHE_CONTROL = 'public, max-age=604800';

export interface PicUIUploadResponse {
  status: boolean;
  message: string;
  data?: {
    key?: string;
    name?: string;
    origin_name?: string;
    links?: {
      url?: string;
    };
  };
}

export interface LskyV2UploadResponse {
  status: 'success' | 'error' | string;
  message: string;
  data?: {
    public_url?: string;
    thumbnail_url?: string;
  } | null;
}

interface PicUIListResponse {
  status: boolean;
  message: string;
  data?: {
    data?: Array<{
      name?: string;
      origin_name?: string;
      filename?: string;
      links?: {
        url?: string;
      };
    }>;
  };
}

function normalizeSegment(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function normalizeS3ObjectKey(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
}

function buildObjectKey(bucket: ImageBucketConfig, filename: string): string {
  const normalizedFilename = normalizeSegment(filename).split('/').pop() || filename;
  const prefix = normalizeSegment(bucket.pathPrefix || '');
  return prefix ? `${prefix}/${normalizedFilename}` : normalizedFilename;
}

function isS3CacheKeyAllowed(bucket: ImageBucketConfig, objectKey: string): boolean {
  const normalizedKey = normalizeS3ObjectKey(objectKey);
  if (!normalizedKey) return false;

  const prefix = normalizeSegment(bucket.pathPrefix || '');
  if (!prefix) return true;
  return normalizedKey !== prefix && normalizedKey.startsWith(`${prefix}/`);
}

function getExtensionForMime(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType.toLowerCase().split(';')[0]?.trim() || ''] || 'bin';
}

function ensureFilenameExtension(filename: string, extension: string): string {
  const trimmed = normalizeSegment(filename).split('/').pop() || `media_${Date.now()}.${extension}`;
  if (/\.[a-z0-9]{2,5}$/i.test(trimmed)) return trimmed;
  return `${trimmed}.${extension}`;
}

function extractUrl(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const markdownLink = trimmed.match(/^\[[^\]]+\]\((https?:\/\/[^)]+)\)$/i);
  if (markdownLink) return markdownLink[1];
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function parseUploadPayload(base64Data: string, filename?: string, bucket?: ImageBucketConfig): UploadPayload {
  let mimeType = 'image/jpeg';
  let pureBase64 = base64Data;

  if (base64Data.startsWith('data:')) {
    const matches = base64Data.match(/^data:([^;]+);base64,(.+)$/);
    if (matches) {
      mimeType = matches[1];
      pureBase64 = matches[2];
    }
  }

  const extension = getExtensionForMime(mimeType);
  const safeFilename = ensureFilenameExtension(filename?.trim() || `image_${Date.now()}`, extension);
  const objectKey = buildObjectKey(bucket || { pathPrefix: '' } as ImageBucketConfig, safeFilename);

  return {
    buffer: Buffer.from(pureBase64, 'base64'),
    extension,
    filename: safeFilename,
    mimeType,
    objectKey,
  };
}

function buildUploadPayloadFromBuffer(
  buffer: Buffer,
  mimeType: string,
  filename?: string,
  bucket?: ImageBucketConfig
): UploadPayload {
  const normalizedMimeType = mimeType.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
  const extension = getExtensionForMime(normalizedMimeType);
  const safeFilename = ensureFilenameExtension(filename?.trim() || `media_${Date.now()}`, extension);
  const objectKey = buildObjectKey(bucket || { pathPrefix: '' } as ImageBucketConfig, safeFilename);

  return {
    buffer,
    extension,
    filename: safeFilename,
    mimeType: normalizedMimeType,
    objectKey,
  };
}

export function resolveDefaultImageBucket(): Promise<ImageBucketConfig | null> {
  return getSystemConfig().then((config) => {
    const buckets = config.imageStorage?.buckets || [];
    const enabledBuckets = buckets.filter((bucket) => bucket.enabled);
    if (enabledBuckets.length === 0) {
      return null;
    }

    if (config.imageStorage?.defaultBucketId) {
      const matched = enabledBuckets.find(
        (bucket) => bucket.id === config.imageStorage.defaultBucketId
      );
      if (matched) return matched;
    }

    return enabledBuckets[0] || null;
  });
}

async function resolveS3CacheBucket(bucketId?: string): Promise<ImageBucketConfig | null> {
  const config = await getSystemConfig();
  const buckets = (config.imageStorage?.buckets || []).filter(
    (bucket) => bucket.enabled && bucket.provider === 's3-compatible'
  );

  if (bucketId) {
    return buckets.find((bucket) => bucket.id === bucketId) || null;
  }

  if (config.imageStorage?.defaultBucketId) {
    const defaultBucket = buckets.find((bucket) => bucket.id === config.imageStorage.defaultBucketId);
    if (defaultBucket) return defaultBucket;
  }

  return buckets[0] || null;
}

async function resolveS3CompatibleBucket(): Promise<ImageBucketConfig | null> {
  const config = await getSystemConfig();
  const buckets = (config.imageStorage?.buckets || []).filter(
    (bucket) => bucket.enabled && bucket.provider === 's3-compatible'
  );

  if (config.imageStorage?.defaultBucketId) {
    const defaultBucket = buckets.find((bucket) => bucket.id === config.imageStorage.defaultBucketId);
    if (defaultBucket) return defaultBucket;
  }

  return buckets[0] || null;
}

async function uploadToPicuiBucket(
  bucket: ImageBucketConfig,
  payload: UploadPayload
): Promise<string | null> {
  if (!bucket.baseUrl || !bucket.apiKey) return null;

  const buildFormData = () => {
    const formData = new FormData();
    formData.append('file', new File([payload.buffer], payload.filename, { type: payload.mimeType }));
    formData.append('permission', '1');
    return formData;
  };

  const apiUrl = `${bucket.baseUrl.replace(/\/$/, '')}/upload`;
  const response = await fetchWithRetry(undiciFetch, apiUrl, () => ({
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bucket.apiKey}`,
      Accept: 'application/json',
    },
    body: buildFormData(),
  }));

  const data = (await response.json()) as PicUIUploadResponse;
  if (!response.ok || !data.status) {
    console.error('[ImageBucket] PicUI upload failed:', data.message);
    return await findPicuiUploadedUrl(bucket, payload.filename);
  }

  return extractUrl(data.data?.links?.url);
}

async function findPicuiUploadedUrl(
  bucket: ImageBucketConfig,
  filename: string
): Promise<string | null> {
  try {
    const baseUrl = bucket.baseUrl.replace(/\/$/, '');
    const params = new URLSearchParams({ page: '1', per_page: '10', q: filename });
    const response = await undiciFetch(`${baseUrl}/images?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${bucket.apiKey}`,
        Accept: 'application/json',
      },
    });

    const data = (await response.json()) as PicUIListResponse;
    if (!response.ok || !data.status || !data.data?.data) {
      return null;
    }

    const matched = data.data.data.find((image) =>
      [image.origin_name, image.name, image.filename].includes(filename)
    );
    return extractUrl(matched?.links?.url);
  } catch (error) {
    console.warn('[ImageBucket] PicUI fallback lookup failed:', error);
    return null;
  }
}

async function uploadToLskyV2Bucket(
  bucket: ImageBucketConfig,
  payload: UploadPayload
): Promise<string | null> {
  if (!bucket.baseUrl || !bucket.apiKey || !bucket.storageId) return null;

  const buildFormData = () => {
    const formData = new FormData();
    formData.append('file', new File([payload.buffer], payload.filename, { type: payload.mimeType }));
    formData.append('storage_id', bucket.storageId || '');
    return formData;
  };

  const apiUrl = `${bucket.baseUrl.replace(/\/$/, '')}/upload`;
  const response = await fetchWithRetry(undiciFetch, apiUrl, () => ({
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bucket.apiKey}`,
      Accept: 'application/json',
    },
    body: buildFormData(),
  }));

  const data = (await response.json()) as LskyV2UploadResponse;
  if (!response.ok || data.status !== 'success') {
    console.error('[ImageBucket] Lsky v2 upload failed:', data.message);
    return null;
  }

  return extractUrl(data.data?.public_url);
}

function getS3Client(bucket: ImageBucketConfig): S3Client {
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

function normalizePublicBaseUrl(value?: string): string {
  return (value || process.env.SANHUB_PUBLIC_BASE_URL || process.env.NEXTAUTH_URL || '')
    .trim()
    .replace(/\/$/, '');
}

function buildPublicPath(path: string, options?: UploadOptions): string {
  const publicBaseUrl = normalizePublicBaseUrl(options?.publicBaseUrl);
  return publicBaseUrl ? `${publicBaseUrl}${path}` : path;
}

function buildS3CacheUrl(bucket: ImageBucketConfig, objectKey: string, options?: UploadOptions): string {
  const params = new URLSearchParams();
  params.set('key', objectKey);
  params.set('bucket', bucket.id);
  return buildPublicPath(`/cache/s3?${params.toString()}`, options);
}

function encodeObjectKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildDirectS3PublicUrl(bucket: ImageBucketConfig, objectKey: string): string {
  const encodedKey = encodeObjectKey(objectKey);
  const publicBaseUrl = bucket.publicBaseUrl?.trim();

  if (publicBaseUrl) {
    return `${publicBaseUrl.replace(/\/$/, '')}/${encodedKey}`;
  }

  const baseUrl = bucket.baseUrl.replace(/\/$/, '');
  return `${baseUrl}/${bucket.bucketName}/${encodedKey}`;
}

async function uploadToS3Bucket(
  bucket: ImageBucketConfig,
  payload: UploadPayload,
  options?: UploadOptions
): Promise<string | null> {
  if (!bucket.baseUrl || !bucket.apiKey || !bucket.secretKey || !bucket.bucketName) {
    return null;
  }
  if (options?.preferDirectS3Url && options.requirePublicBaseUrl && !bucket.publicBaseUrl?.trim()) {
    return null;
  }

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

  return options?.preferDirectS3Url
    ? buildDirectS3PublicUrl(bucket, payload.objectKey)
    : buildS3CacheUrl(bucket, payload.objectKey, options);
}

async function uploadPayloadToBucket(
  bucket: ImageBucketConfig,
  payload: UploadPayload,
  options?: UploadOptions
): Promise<string | null> {
  if (bucket.provider === 's3-compatible') {
    return await uploadToS3Bucket(bucket, payload, options);
  }

  if (!payload.mimeType.startsWith('image/')) {
    return null;
  }

  if (bucket.provider === 'lsky-v2') {
    return await uploadToLskyV2Bucket(bucket, payload);
  }

  return await uploadToPicuiBucket(bucket, payload);
}

export async function uploadToImageBucket(
  base64Data: string,
  filename?: string,
  options?: UploadOptions
): Promise<string | null> {
  const bucket = await resolveDefaultImageBucket();
  if (!bucket) {
    console.log('[ImageBucket] No enabled bucket configured, skip upload');
    return null;
  }

  const payload = parseUploadPayload(base64Data, filename, bucket);

  try {
    return await uploadPayloadToBucket(bucket, payload, options);
  } catch (error) {
    console.error('[ImageBucket] Upload failed:', error);
    return null;
  }
}

export async function uploadBufferToImageBucket(
  buffer: Buffer,
  mimeType: string,
  filename?: string,
  options?: UploadOptions
): Promise<string | null> {
  const bucket = await resolveDefaultImageBucket();
  if (!bucket) {
    console.log('[ImageBucket] No enabled bucket configured, skip upload');
    return null;
  }

  const payload = buildUploadPayloadFromBuffer(buffer, mimeType, filename, bucket);

  try {
    return await uploadPayloadToBucket(bucket, payload, options);
  } catch (error) {
    console.error('[ImageBucket] Upload failed:', error);
    return null;
  }
}

export async function uploadBufferToS3CompatibleBucket(
  buffer: Buffer,
  mimeType: string,
  filename?: string,
  options: { requirePublicBaseUrl?: boolean } = {}
): Promise<string | null> {
  const bucket = await resolveS3CompatibleBucket();
  if (!bucket) {
    console.log('[ImageBucket] No enabled S3 compatible bucket configured, skip upload');
    return null;
  }

  const payload = buildUploadPayloadFromBuffer(buffer, mimeType, filename, bucket);

  try {
    return await uploadToS3Bucket(bucket, payload, {
      preferDirectS3Url: true,
      requirePublicBaseUrl: options.requirePublicBaseUrl,
    });
  } catch (error) {
    console.error('[ImageBucket] S3 compatible upload failed:', error);
    return null;
  }
}

export async function uploadToPicUI(
  base64Data: string,
  filename?: string,
  options?: UploadOptions
): Promise<string | null> {
  return uploadToImageBucket(base64Data, filename, options);
}

export async function uploadImageOrKeepBase64(
  base64Data: string,
  filename?: string,
  options?: UploadOptions
): Promise<string> {
  const url = await uploadToImageBucket(base64Data, filename, options);
  return url || base64Data;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);

  const byteArrayStream = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof byteArrayStream.transformToByteArray === 'function') {
    return Buffer.from(await byteArrayStream.transformToByteArray());
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function getS3CachedObject(
  objectKey: string,
  bucketId?: string
): Promise<S3CachedObject> {
  const normalizedKey = normalizeS3ObjectKey(objectKey);
  if (!normalizedKey) {
    throw new Error('S3 key is required');
  }

  const bucket = await resolveS3CacheBucket(bucketId);
  if (!bucket) {
    throw new Error('S3 bucket is not configured');
  }
  if (!isS3CacheKeyAllowed(bucket, normalizedKey)) {
    throw new Error('S3 key is outside the configured cache prefix');
  }

  const client = getS3Client(bucket);
  const result = await client.send(
    new GetObjectCommand({
      Bucket: bucket.bucketName,
      Key: normalizedKey,
    })
  );
  const buffer = await streamToBuffer(result.Body);

  return {
    buffer,
    contentType: result.ContentType || 'application/octet-stream',
    contentLength: Number(result.ContentLength || buffer.length),
    etag: result.ETag,
    lastModified: result.LastModified,
  };
}
