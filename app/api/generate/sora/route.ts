/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import {
  countMinimaxH3ReferenceImages,
  generateWithSora,
  resolveMinimaxH3ReferenceImageExtraCost,
  resolveVideoGenerationCost,
} from '@/lib/sora';
import { saveGeneration, updateUserBalance, getUserById, updateGeneration, getSystemConfig, refundGenerationBalance, getVideoModelWithChannel } from '@/lib/db';
import type { Generation, SoraGenerateRequest } from '@/types';
import { checkRateLimit } from '@/lib/rate-limit';
import { fetchReferenceImage } from '@/lib/reference-image';
import { processVideoPrompt } from '@/lib/prompt-processor';
import { assertPromptsAllowed, isPromptBlockedError } from '@/lib/prompt-blocklist';
import { saveVideoMediaPreferS3 } from '@/lib/media-storage';
import { validateMinimaxH3ReferenceMediaDuration } from '@/lib/audio-duration';
import { fetchWithRetry } from '@/lib/http-retry';

function normalizeIncomingVideoConfigObject(input: SoraGenerateRequest): SoraGenerateRequest['videoConfigObject'] {
  const raw = (input.videoConfigObject || input.video_config) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return undefined;

  const output: NonNullable<SoraGenerateRequest['videoConfigObject']> = {};

  if (typeof raw.aspect_ratio === 'string' && ['16:9', '9:16', '1:1', '2:3', '3:2', '3:4', '4:3', '21:9'].includes(raw.aspect_ratio.trim())) {
    output.aspect_ratio = raw.aspect_ratio.trim() as NonNullable<SoraGenerateRequest['videoConfigObject']>['aspect_ratio'];
  }

  if (typeof raw.video_length === 'number' && Number.isFinite(raw.video_length)) {
    output.video_length = Math.max(4, Math.min(30, Math.floor(raw.video_length)));
  }

  if (typeof raw.resolution === 'string') {
    const resolution = raw.resolution.trim().toUpperCase();
    if (resolution === 'SD' || resolution === 'HD') {
      output.resolution = resolution;
    }
  }

  if (typeof raw.preset === 'string') {
    const preset = raw.preset.trim().toLowerCase();
    if (preset === 'fun' || preset === 'normal' || preset === 'spicy') {
      output.preset = preset;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

// 配置路由段选项
export const maxDuration = 600;
export const dynamic = 'force-dynamic';

const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 1500;
const RATE_LIMIT_MAX_DELAY_MS = 10000;
const MAX_MINIMAX_REFERENCE_IMAGES = 9;
const MAX_REFERENCE_VIDEO_URLS = 3;
const MAX_REFERENCE_AUDIO_URLS = 3;
const MAX_TOTAL_MINIMAX_REFERENCES = 12;
const MAX_REFERENCE_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_REFERENCE_AUDIO_BYTES = 50 * 1024 * 1024;

type ReferenceMediaKind = 'video' | 'audio';

function normalizeReferenceUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const urls: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || urls.includes(trimmed)) continue;
    urls.push(trimmed);
  }

  return urls;
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

function getReferenceFilenameFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const basename = url.pathname.replace(/\\/g, '/').split('/').pop();
    return basename || undefined;
  } catch {
    return undefined;
  }
}

async function fetchRemoteReferenceMedia(
  url: string,
  kind: ReferenceMediaKind
): Promise<{ buffer: Buffer; mimeType: string; filename?: string }> {
  const maxBytes = kind === 'video' ? MAX_REFERENCE_VIDEO_BYTES : MAX_REFERENCE_AUDIO_BYTES;
  const response = await fetchWithRetry(fetch, url, () => ({
    method: 'GET',
    headers: {
      Accept: kind === 'video' ? 'video/*,application/x-mpegurl,*/*' : 'audio/*,*/*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  }), {
    attempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 4000,
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    const kindName = kind === 'video' ? '视频' : '音频';
    throw new Error(`参考${kindName}下载失败（${response.status}）${details ? `：${details.slice(0, 200)}` : ''}`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    const kindName = kind === 'video' ? '视频' : '音频';
    throw new Error(`参考${kindName}大小不能超过 ${Math.floor(maxBytes / 1024 / 1024)}MB`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length <= 0) {
    const kindName = kind === 'video' ? '视频' : '音频';
    throw new Error(`参考${kindName}文件为空`);
  }
  if (buffer.length > maxBytes) {
    const kindName = kind === 'video' ? '视频' : '音频';
    throw new Error(`参考${kindName}大小不能超过 ${Math.floor(maxBytes / 1024 / 1024)}MB`);
  }

  return {
    buffer,
    mimeType: response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream',
    filename: getReferenceFilenameFromUrl(url),
  };
}

async function validateRemoteReferenceMediaDurations(
  urls: string[],
  kind: ReferenceMediaKind
): Promise<string | null> {
  for (const url of urls) {
    try {
      const media = await fetchRemoteReferenceMedia(url, kind);
      const validation = validateMinimaxH3ReferenceMediaDuration(
        kind,
        media.buffer,
        media.mimeType,
        media.filename
      );
      if (!validation.ok) {
        const kindName = kind === 'video' ? '视频' : '音频';
        return `${validation.error || `参考${kindName}时长不符合要求`}：${url}`;
      }
    } catch (error) {
      const kindName = kind === 'video' ? '视频' : '音频';
      return error instanceof Error
        ? `${error.message}：${url}`
        : `参考${kindName}校验失败：${url}`;
    }
  }

  return null;
}

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('rate limited') ||
    message.includes('too many requests')
  );
}

function getRateLimitDelayMs(attempt: number): number {
  const delay = Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1), RATE_LIMIT_MAX_DELAY_MS);
  const jitter = Math.floor(delay * 0.25 * Math.random());
  return delay - jitter;
}

async function generateWithRateLimitRetry(
  body: SoraGenerateRequest,
  onProgress: (progress: number) => void,
  taskId: string
) {
  let attempt = 0;
  while (true) {
    try {
      if (attempt > 0) {
        console.warn(`[Task ${taskId}] Retry attempt ${attempt} after rate limit`);
      }
      return await generateWithSora(body, onProgress);
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= RATE_LIMIT_RETRIES) {
        throw error;
      }
      attempt += 1;
      const delayMs = getRateLimitDelayMs(attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// 后台处理任务
async function processGenerationTask(
  generationId: string,
  userId: string,
  body: SoraGenerateRequest,
  prechargedCost: number,
  publicBaseUrl?: string
): Promise<void> {
  try {
    console.log(`[Task ${generationId}] 开始处理生成任务`);

    const baseParams = {
      model: body.model,
      modelId: body.modelId,
      aspectRatio: body.aspectRatio,
      duration: body.duration,
      videoConfigObject: body.videoConfigObject,
      referenceVideoUrls: body.referenceVideoUrls,
      referenceAudioUrls: body.referenceAudioUrls,
    };
    let promptParams: {
      originalPrompt?: string;
      filteredPrompt?: string;
      translatedPrompt?: string;
      processedPrompt?: string;
    } = {};
    
    // 更新状态为 processing
    await updateGeneration(generationId, {
      status: 'processing',
      params: {
        ...baseParams,
        progress: 0,
      },
    }).catch(err => {
      console.error(`[Task ${generationId}] 更新状态失败:`, err);
    });

    // 进度更新回调（节流：每5%更新一次）
    let lastProgress = 0;
    const onProgress = async (progress: number) => {
      if (progress - lastProgress >= 5 || progress >= 100) {
        lastProgress = progress;
        await updateGeneration(generationId, { 
          params: {
            ...baseParams,
            ...promptParams,
            progress,
          },
        }).catch(err => {
          console.error(`[Task ${generationId}] 更新进度失败:`, err);
        });
      }
    };

    // Process prompt (filter + translate)
    let processedBody = body;
    if (body.prompt && body.prompt.trim()) {
      try {
        const processed = await processVideoPrompt(body.prompt);
        promptParams = {
          originalPrompt: processed.originalPrompt,
          filteredPrompt: processed.filteredPrompt,
          translatedPrompt: processed.translatedPrompt,
          processedPrompt: processed.processedPrompt,
        };
        processedBody = {
          ...body,
          prompt: processed.processedPrompt,
        };
        await updateGeneration(generationId, {
          params: {
            ...baseParams,
            ...promptParams,
            progress: lastProgress,
          },
        }).catch(err => {
          console.error(`[Task ${generationId}] 更新提示词处理结果失败:`, err);
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Prompt processing failed';
        console.error(`[Task ${generationId}] 提示词处理失败:`, message);
        throw new Error(message);
      }
    }

    // 调用 Sora API 生成内容
    const result = await generateWithRateLimitRetry(processedBody, onProgress, generationId);

    const savedUrl = await saveVideoMediaPreferS3(generationId, result.url, { publicBaseUrl });

    console.log(`[Task ${generationId}] 生成成功:`, savedUrl);

    // 更新生成记录为完成状态
    await updateGeneration(generationId, {
      status: 'completed',
      resultUrl: savedUrl,
      params: {
        ...baseParams,
        ...promptParams,
        videoId: result.videoId,
        videoChannelId: result.videoChannelId,
        permalink: result.permalink,
        revised_prompt: result.revised_prompt,
        progress: 100,
      },
    }).catch(err => {
      console.error(`[Task ${generationId}] 更新完成状态失败:`, err);
    });

    console.log(`[Task ${generationId}] 任务完成`);
  } catch (error) {
    console.error(`[Task ${generationId}] 任务失败:`, error);
    
    // 确保错误消息格式正确
    let errorMessage = '生成失败';
    if (error instanceof Error) {
      errorMessage = error.message;
      // 处理 cause 属性中的额外信息
      if ('cause' in error && error.cause) {
        console.error(`[Task ${generationId}] 错误原因:`, error.cause);
      }
    }
    
    // 更新为失败状态（用 try-catch 确保不会抛出）
    try {
      await updateGeneration(generationId, {
        status: 'failed',
        errorMessage,
      });
    } catch (updateErr) {
      console.error(`[Task ${generationId}] 更新失败状态时出错:`, updateErr);
    }

    try {
      await refundGenerationBalance(generationId, userId, prechargedCost);
    } catch (refundErr) {
      console.error(`[Task ${generationId}] Refund failed:`, refundErr);
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const systemConfig = await getSystemConfig();
    const videoMaxRequests = Math.max(1, Number(systemConfig.rateLimit?.videoMaxRequests) || 30);
    const videoWindowSeconds = Math.max(1, Number(systemConfig.rateLimit?.videoWindowSeconds) || 60);
    const rateLimit = checkRateLimit(
      request,
      { maxRequests: videoMaxRequests, windowSeconds: videoWindowSeconds },
      'generate-sora-video'
    );
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: rateLimit.headers }
      );
    }

    // 验证登录
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 });
    }

    const body: SoraGenerateRequest = await request.json();
    const hasPrompt = Boolean(body.prompt && body.prompt.trim());
    const hasFiles = Boolean(body.files && body.files.length > 0);
    const hasReferenceUrl = Boolean(body.referenceImageUrl);
    const referenceVideoUrls = normalizeReferenceUrls(body.referenceVideoUrls);
    const referenceAudioUrls = normalizeReferenceUrls(body.referenceAudioUrls);

    if (!hasPrompt && !hasFiles && !hasReferenceUrl && referenceVideoUrls.length === 0 && referenceAudioUrls.length === 0) {
      return NextResponse.json(
        { error: '请输入提示词或上传参考文件' },
        { status: 400 }
      );
    }

    if (referenceVideoUrls.length > MAX_REFERENCE_VIDEO_URLS) {
      return NextResponse.json(
        { error: `参考视频最多 ${MAX_REFERENCE_VIDEO_URLS} 条` },
        { status: 400 }
      );
    }

    if (referenceAudioUrls.length > MAX_REFERENCE_AUDIO_URLS) {
      return NextResponse.json(
        { error: `参考音频最多 ${MAX_REFERENCE_AUDIO_URLS} 条` },
        { status: 400 }
      );
    }

    const invalidReferenceUrl = [...referenceVideoUrls, ...referenceAudioUrls].find(
      (url) => !isPublicReferenceUrl(url)
    );
    if (invalidReferenceUrl) {
      return NextResponse.json(
        { error: `Invalid public reference URL: ${invalidReferenceUrl}` },
        { status: 400 }
      );
    }

    const selectedModelConfig = body.modelId ? await getVideoModelWithChannel(body.modelId) : null;
    const selectedModel = selectedModelConfig?.model || null;
    const selectedChannelType = selectedModelConfig?.channel.type;
    const hasVideoOrAudioReferences = referenceVideoUrls.length > 0 || referenceAudioUrls.length > 0;
    if (hasVideoOrAudioReferences && selectedChannelType !== 'minimax-h3') {
      return NextResponse.json(
        { error: '当前模型不支持视频或音频参考' },
        { status: 400 }
      );
    }

    await assertPromptsAllowed([body.prompt, body.style_id]);

    const origin = new URL(request.url).origin;
    const normalizedVideoConfigObject = normalizeIncomingVideoConfigObject(body);
    const normalizedBody: SoraGenerateRequest = {
      ...body,
      videoConfigObject: normalizedVideoConfigObject,
      video_config: normalizedVideoConfigObject,
      files: body.files ? [...body.files] : [],
      publicBaseUrl: origin,
      referenceVideoUrls,
      referenceAudioUrls,
    };

    if (body.referenceImageUrl) {
      const referenceImage = await fetchReferenceImage(body.referenceImageUrl, {
        origin,
        userId: session.user.id,
        userRole: session.user.role,
        maxBytes: MAX_REFERENCE_IMAGE_BYTES,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      normalizedBody.files?.push({
        mimeType: referenceImage.mimeType,
        data: referenceImage.base64,
      });
      normalizedBody.referenceImageUrl = undefined;
    }

    const minimaxReferenceImageCount =
      selectedChannelType === 'minimax-h3'
        ? countMinimaxH3ReferenceImages(normalizedBody)
        : 0;
    const minimaxReferenceImageExtraCost =
      selectedChannelType === 'minimax-h3'
        ? resolveMinimaxH3ReferenceImageExtraCost(minimaxReferenceImageCount)
        : 0;

    if (selectedChannelType === 'minimax-h3') {
      const totalReferenceCount = minimaxReferenceImageCount + referenceVideoUrls.length + referenceAudioUrls.length;

      if (minimaxReferenceImageCount > MAX_MINIMAX_REFERENCE_IMAGES) {
        return NextResponse.json(
          { error: `参考图片最多 ${MAX_MINIMAX_REFERENCE_IMAGES} 张` },
          { status: 400 }
        );
      }

      if (totalReferenceCount > MAX_TOTAL_MINIMAX_REFERENCES) {
        return NextResponse.json(
          { error: `参考素材合计最多 ${MAX_TOTAL_MINIMAX_REFERENCES} 个` },
          { status: 400 }
        );
      }

      const invalidReferenceVideoDuration = await validateRemoteReferenceMediaDurations(
        referenceVideoUrls,
        'video'
      );
      if (invalidReferenceVideoDuration) {
        return NextResponse.json(
          { error: invalidReferenceVideoDuration },
          { status: 400 }
        );
      }

      const invalidReferenceAudioDuration = await validateRemoteReferenceMediaDurations(
        referenceAudioUrls,
        'audio'
      );
      if (invalidReferenceAudioDuration) {
        return NextResponse.json(
          { error: invalidReferenceAudioDuration },
          { status: 400 }
        );
      }
    }

    // 获取最新用户信息
    const user = await getUserById(session.user.id);
    if (!user) {
      return NextResponse.json({ error: '用户不存在' }, { status: 401 });
    }

    // 预估成本
    const estimatedCost = resolveVideoGenerationCost(
      systemConfig.pricing,
      normalizedBody,
      selectedModel || undefined
    );

    // 检查余额
    if (user.balance < estimatedCost) {
      return NextResponse.json(
        { error: `余额不足，需要至少 ${estimatedCost} 积分` },
        { status: 402 }
      );
    }

    try {
      await updateUserBalance(user.id, -estimatedCost, 'strict');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Insufficient balance';
      if (message.includes('Insufficient balance')) {
        return NextResponse.json(
          { error: `余额不足，需要至少 ${estimatedCost} 积分` },
          { status: 402 }
        );
      }
      throw err;
    }

    // 生成类型固定为视频
    const type = 'sora-video';

    // 立即创建生成记录（状态为 pending）
    let generation: Generation;
    try {
      generation = await saveGeneration({
        userId: user.id,
        type,
        prompt: body.prompt || '',
        params: {
          model: body.model,
          modelId: body.modelId,
          aspectRatio: body.aspectRatio,
          duration: body.duration,
          videoConfigObject: normalizedVideoConfigObject,
          referenceVideoUrls,
          referenceAudioUrls,
          referenceImageCount: minimaxReferenceImageCount,
          referenceImageExtraCost: minimaxReferenceImageExtraCost,
          progress: 0,
        },
        resultUrl: '',
        cost: estimatedCost,
        status: 'pending',
        balancePrecharged: true,
        balanceRefunded: false,
      });
    } catch (saveErr) {
      await updateUserBalance(user.id, estimatedCost, 'strict').catch(refundErr => {
        console.error('[API] Precharge rollback failed:', refundErr);
      });
      throw saveErr;
    }

    // 在后台异步处理（不等待完成）
    processGenerationTask(generation.id, user.id, normalizedBody, estimatedCost, origin).catch((err) => {
      console.error('[API] 后台任务启动失败:', err);
    });

    // 立即返回任务 ID
    return NextResponse.json({
      success: true,
      data: {
        id: generation.id,
        status: 'pending',
        message: '任务已创建，正在后台处理中',
      },
    });
  } catch (error) {
    console.error('[API] Sora generation error:', error);

    if (isPromptBlockedError(error)) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Prompt blocked by safety policy' },
        { status: 400 }
      );
    }
    
    const errorMessage = error instanceof Error ? error.message : '生成失败';
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    console.error('[API] Error details:', {
      message: errorMessage,
      stack: errorStack,
    });

    return NextResponse.json(
      { 
        error: errorMessage,
        details: process.env.NODE_ENV === 'development' ? errorStack : undefined,
      },
      { status: 500 }
    );
  }
}
