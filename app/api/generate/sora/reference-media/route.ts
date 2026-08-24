import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { validateMinimaxH3ReferenceMediaDuration } from '@/lib/audio-duration';
import { uploadBufferToS3CompatibleBucket } from '@/lib/picui';

export const maxDuration = 600;
export const dynamic = 'force-dynamic';

const MAX_REFERENCE_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_REFERENCE_AUDIO_BYTES = 50 * 1024 * 1024;

const ALLOWED_REFERENCE_MIME_TYPES = {
  video: new Set([
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-matroska',
    'video/mkv',
    'application/x-mpegurl',
    'application/vnd.apple.mpegurl',
  ]),
  audio: new Set([
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/aac',
    'audio/ogg',
    'audio/webm',
    'audio/mp4',
  ]),
} as const;

function normalizeKind(value: FormDataEntryValue | null): 'video' | 'audio' | null {
  return value === 'video' || value === 'audio' ? value : null;
}

function sanitizeFilename(value: string): string {
  const basename = value.replace(/\\/g, '/').split('/').pop() || `reference-${Date.now()}`;
  return basename.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || `reference-${Date.now()}`;
}

function isPublicReferenceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isPublicProtocol = url.protocol === 'http:' || url.protocol === 'https:';
    const hasAllowedPort = !url.port || url.port === '80' || url.port === '443';
    return isPublicProtocol && hasAllowedPort && hostname !== 'localhost' && !hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 });
    }

    const formData = await request.formData();
    const kind = normalizeKind(formData.get('kind'));
    const file = formData.get('file');

    if (!kind) {
      return NextResponse.json({ error: '参考素材类型无效' }, { status: 400 });
    }

    if (!(file instanceof File)) {
      return NextResponse.json({ error: '请上传参考素材文件' }, { status: 400 });
    }

    const mimeType = file.type.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
    if (!ALLOWED_REFERENCE_MIME_TYPES[kind].has(mimeType)) {
      return NextResponse.json({ error: `不支持的参考素材格式：${mimeType}` }, { status: 400 });
    }

    const maxBytes = kind === 'video' ? MAX_REFERENCE_VIDEO_BYTES : MAX_REFERENCE_AUDIO_BYTES;
    if (file.size <= 0 || file.size > maxBytes) {
      return NextResponse.json(
        { error: `${kind === 'video' ? '参考视频' : '参考音频'}大小不能超过 ${Math.floor(maxBytes / 1024 / 1024)}MB` },
        { status: 400 }
      );
    }

    const prefix = kind === 'video' ? 'minimax-h3-reference-video' : 'minimax-h3-reference-audio';
    const filename = `${prefix}-${Date.now()}-${sanitizeFilename(file.name)}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    const mediaDuration = validateMinimaxH3ReferenceMediaDuration(kind, buffer, mimeType, file.name);

    if (!mediaDuration.ok) {
      return NextResponse.json(
        {
          error: mediaDuration.error || `参考${kind === 'video' ? '视频' : '音频'}时长不符合要求`,
          durationSeconds: mediaDuration.durationSeconds,
        },
        { status: 400 }
      );
    }

    const url = await uploadBufferToS3CompatibleBucket(buffer, mimeType, filename, {
      requirePublicBaseUrl: true,
    });

    if (!url) {
      return NextResponse.json(
        { error: 'S3 兼容存储未配置或上传失败，请先配置带 Public Base URL 的 R2 存储桶' },
        { status: 400 }
      );
    }

    if (!isPublicReferenceUrl(url)) {
      return NextResponse.json(
        { error: '上传成功但返回的 URL 不是 Minimax H3 可访问的公网 HTTP(S) 地址' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        url,
        name: file.name,
        mimeType,
        size: file.size,
        kind,
        durationSeconds: mediaDuration.durationSeconds,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '参考素材上传失败' },
      { status: 500 }
    );
  }
}
