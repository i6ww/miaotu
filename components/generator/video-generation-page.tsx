'use client';
/* eslint-disable @next/next/no-img-element */

import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useSession } from 'next-auth/react';
import {
  Sparkles,
  Loader2,
  AlertCircle,
  Dices,
  User,
  Film,
  Music,
  Upload,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { compressImageToWebP, fileToBase64 } from '@/lib/image-compression';
import { toast } from '@/components/ui/toaster';
import { CustomSelect } from '@/components/ui/select-custom';
import { InlineToggle } from '@/components/generator/inline-toggle';
import { ReferenceImageInput } from '@/components/generator/reference-image-input';
import type { Task } from '@/components/generator/result-gallery';
import { useSiteConfig } from '@/components/providers/site-config-provider';
import type { Generation, CharacterCard, SafeVideoModel, DailyLimitConfig } from '@/types';
import {
  buildTaskFromGeneration,
  deleteGenerationRecord,
  deleteGenerationRecords,
  fetchGenerationSubmit,
  fetchPendingGenerationTasks,
  fetchRecentUserGenerations,
  filterGenerationsByKind,
  filterTasksByKind,
  isFailedGenerationStatus,
  isTerminalGenerationStatus,
  mergeGenerationsById,
  mergeTasksById,
  pollGenerationTask,
  replaceActiveTasks,
  type ReusableImageReference,
} from '@/lib/generation-client';

const ResultGallery = dynamic(
  () => import('@/components/generator/result-gallery').then((mod) => mod.ResultGallery),
  {
    ssr: false,
    loading: () => (
      <div className="surface p-6 text-sm text-foreground/50">Loading results...</div>
    ),
  }
);

// 每日使用量类型
interface DailyUsage {
  imageCount: number;
  videoCount: number;
  characterCardCount: number;
}

const MINIMAX_H3_MAX_REFERENCE_VIDEOS = 3;
const MINIMAX_H3_MAX_REFERENCE_AUDIOS = 3;
const MINIMAX_H3_MAX_REFERENCE_IMAGES = 9;
const MINIMAX_H3_MAX_TOTAL_REFERENCES = 12;
const MINIMAX_H3_FREE_REFERENCE_IMAGES = 5;
const MINIMAX_H3_EXTRA_REFERENCE_IMAGE_COST = 10;
const MINIMAX_H3_MAX_REFERENCE_VIDEO_BYTES = 200 * 1024 * 1024;
const MINIMAX_H3_MAX_REFERENCE_AUDIO_BYTES = 50 * 1024 * 1024;
const MINIMAX_H3_REFERENCE_AUDIO_MIN_SECONDS = 2;
const MINIMAX_H3_REFERENCE_AUDIO_MAX_SECONDS = 15;
const MINIMAX_H3_REFERENCE_VIDEO_MIN_SECONDS = 2;
const MINIMAX_H3_REFERENCE_VIDEO_MAX_SECONDS = 15;

type ReferenceMediaKind = 'video' | 'audio';

function parseReferenceUrlText(value: string): string[] {
  const urls = value
    .split(/[\n,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(urls));
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

function appendReferenceUrlText(value: string, url: string): string {
  const urls = parseReferenceUrlText(value);
  if (!urls.includes(url)) {
    urls.push(url);
  }
  return urls.join('\n');
}

function isReferenceMediaFile(file: File, kind: ReferenceMediaKind): boolean {
  const mimeType = file.type.toLowerCase();
  if (kind === 'audio') return mimeType.startsWith('audio/');
  return (
    mimeType.startsWith('video/') ||
    mimeType === 'application/x-mpegurl' ||
    mimeType === 'application/vnd.apple.mpegurl'
  );
}

function readBrowserMediaDurationSeconds(file: File, kind: ReferenceMediaKind): Promise<number | null> {
  return new Promise((resolve) => {
    const media = document.createElement(kind);
    const objectUrl = URL.createObjectURL(file);
    let settled = false;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      media.removeAttribute('src');
      media.load();
      URL.revokeObjectURL(objectUrl);
    };

    const finish = (duration: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(duration);
    };

    const timeoutId = window.setTimeout(() => finish(null), 10000);
    media.preload = 'metadata';
    media.onloadedmetadata = () => {
      const duration = media.duration;
      finish(Number.isFinite(duration) && duration > 0 ? duration : null);
    };
    media.onerror = () => finish(null);
    media.src = objectUrl;
  });
}

function getReferenceMediaDurationLimit(kind: ReferenceMediaKind): { min: number; max: number } {
  return kind === 'video'
    ? { min: MINIMAX_H3_REFERENCE_VIDEO_MIN_SECONDS, max: MINIMAX_H3_REFERENCE_VIDEO_MAX_SECONDS }
    : { min: MINIMAX_H3_REFERENCE_AUDIO_MIN_SECONDS, max: MINIMAX_H3_REFERENCE_AUDIO_MAX_SECONDS };
}

function isMinimaxH3ReferenceMediaDurationValid(kind: ReferenceMediaKind, durationSeconds: number): boolean {
  const limit = getReferenceMediaDurationLimit(kind);
  return (
    durationSeconds >= limit.min &&
    durationSeconds <= limit.max
  );
}

export interface VideoGenerationPageProps {
  embedded?: boolean;
  createModeSwitcher?: ReactNode;
  externalReference?: ReusableImageReference | null;
  onExternalReferenceChange?: (reference: ReusableImageReference | null) => void;
  isActive?: boolean;
}

export function VideoGenerationView({
  embedded = false,
  createModeSwitcher,
  externalReference: controlledExternalReference,
  onExternalReferenceChange,
  isActive = true,
}: VideoGenerationPageProps = {}) {
  const { update } = useSession();
  const siteConfig = useSiteConfig();
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const filesRef = useRef<Array<{ file: File; preview: string }>>([]);
  const referenceVideoFileInputRef = useRef<HTMLInputElement>(null);
  const referenceAudioFileInputRef = useRef<HTMLInputElement>(null);
  const refreshGenerationFeedRef = useRef<() => Promise<void>>(async () => {});
  const deletedGenerationIdsRef = useRef<Set<string>>(new Set());
  const isActiveRef = useRef(isActive);
  const submissionLockRef = useRef(false);
  const [localExternalReference, setLocalExternalReference] =
    useState<ReusableImageReference | null>(null);

  // 模型列表（从 API 获取）
  const [availableModels, setAvailableModels] = useState<SafeVideoModel[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);

  // 每日限制
  const [dailyUsage, setDailyUsage] = useState<DailyUsage>({ imageCount: 0, videoCount: 0, characterCardCount: 0 });
  const [dailyLimits, setDailyLimits] = useState<DailyLimitConfig>({ imageLimit: 0, videoLimit: 0, characterCardLimit: 0 });

  // 模型选择
  const [selectedModelId, setSelectedModelId] = useState<string>('');

  // 参数状态
  const [aspectRatio, setAspectRatio] = useState<string>('landscape');
  const [duration, setDuration] = useState<string>('8s');
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<Array<{ file: File; preview: string }>>([]);
  const [referenceVideoUrlsText, setReferenceVideoUrlsText] = useState('');
  const [referenceAudioUrlsText, setReferenceAudioUrlsText] = useState('');
  const [uploadingReferenceKind, setUploadingReferenceKind] = useState<ReferenceMediaKind | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [compressedCache, setCompressedCache] = useState<Map<File, string>>(new Map());

  // 任务状态
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [busyGenerationId, setBusyGenerationId] = useState<string | null>(null);
  const [clearingFailedTasks, setClearingFailedTasks] = useState(false);
  const [error, setError] = useState('');
  const [keepPrompt, setKeepPrompt] = useState(false);


  // 角色卡选择
  const [characterCards, setCharacterCards] = useState<CharacterCard[]>([]);
  const characterCardsLoadedRef = useRef(false);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);

  const [showCharacterMenu, setShowCharacterMenu] = useState(false);

  const activeExternalReference =
    controlledExternalReference !== undefined
      ? controlledExternalReference
      : localExternalReference;

  const setActiveExternalReference = useCallback(
    (reference: ReusableImageReference | null) => {
      if (onExternalReferenceChange) {
        onExternalReferenceChange(reference);
        return;
      }

      setLocalExternalReference(reference);
    },
    [onExternalReferenceChange]
  );

  const clearFiles = useCallback(() => {
    setFiles((prev) => {
      prev.forEach((file) => URL.revokeObjectURL(file.preview));
      return [];
    });
    setCompressedCache(new Map());
  }, []);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // 获取当前选中的模型配置
  const currentModel = useMemo(() => {
    return availableModels.find(m => m.id === selectedModelId) || availableModels[0];
  }, [availableModels, selectedModelId]);
  const isSoraChannel = currentModel?.channelType === 'sora';
  const isMinimaxH3Channel = currentModel?.channelType === 'minimax-h3';
  const referenceVideoUrls = useMemo(
    () => parseReferenceUrlText(referenceVideoUrlsText),
    [referenceVideoUrlsText]
  );
  const referenceAudioUrls = useMemo(
    () => parseReferenceUrlText(referenceAudioUrlsText),
    [referenceAudioUrlsText]
  );
  const canMentionCharacterCards = isSoraChannel && characterCards.length > 0;
  const referenceImageCount = files.length + (activeExternalReference ? 1 : 0);
  const selectedDurationCost = useMemo(() => {
    if (!currentModel) return 0;
    const exactDuration = currentModel.durations.find((item) => item.value === duration);
    return exactDuration?.cost || currentModel.durations[0]?.cost || 0;
  }, [currentModel, duration]);
  const referenceImageExtraCost = isMinimaxH3Channel
    ? Math.max(0, referenceImageCount - MINIMAX_H3_FREE_REFERENCE_IMAGES) * MINIMAX_H3_EXTRA_REFERENCE_IMAGE_COST
    : 0;
  const estimatedVideoCost = selectedDurationCost + referenceImageExtraCost;

  const modelsCacheRef = useRef<SafeVideoModel[] | null>(null);

  // Reload models on tab activation, browser tab focus and a low-frequency
  // poll so admin channel/model toggles reach open user pages quickly.
  useEffect(() => {
    if (!isActive) {
      return;
    }

    const refreshModels = async (isInitial: boolean) => {
      if (isInitial && modelsCacheRef.current) {
        setAvailableModels(modelsCacheRef.current);
        setModelsLoaded(true);
        return;
      }
      try {
        const res = await fetch('/api/video-models', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          const models = data.data?.models || [];
          modelsCacheRef.current = models;
          setAvailableModels(models);

          if (models.length > 0) {
            // Keep the updater pure: the fallback model's default aspect ratio and
            // duration are applied by the model-change effect below.
            setSelectedModelId((prev) => {
              if (prev && models.some((model: SafeVideoModel) => model.id === prev)) return prev;
              // fall back to the first model when the current one was disabled
              return models[0].id;
            });
          }
        }
      } catch (err) {
        // keep the stale list on refresh failures; only log on initial load
        if (isInitial) console.error('Failed to load models:', err);
      } finally {
        if (isInitial) setModelsLoaded(true);
      }
    };

    if (!modelsLoaded) {
      void refreshModels(true);
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refreshModels(false);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const timer = setInterval(() => {
      if (!document.hidden) void refreshModels(false);
    }, 60000);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      clearInterval(timer);
    };
  }, [isActive, modelsLoaded]);

  // 加载每日使用量
  useEffect(() => {
    if (!isActive) {
      return;
    }

    const loadDailyUsage = async () => {
      try {
        const res = await fetch('/api/user/daily-usage');
        if (res.ok) {
          const data = await res.json();
          setDailyUsage(data.data.usage);
          setDailyLimits(data.data.limits);
        }
      } catch (err) {
        console.error('Failed to load daily usage:', err);
      }
    };
    void loadDailyUsage();
  }, [isActive]);

  // appliedModelRef 记录已经套用过默认参数的模型：availableModels 在每次轮询 /
  // 切标签刷新后都是全新的数组与对象引用，不能用来判断“模型是否已切换”，
  // 否则会把用户选好的比例、时长重置回默认值，并误清空已上传的参考素材。
  const appliedModelRef = useRef<string>('');

  // 当模型改变时，重置参数到默认值
  useEffect(() => {
    if (!isActiveRef.current) {
      return;
    }

    const model = availableModels.find(m => m.id === selectedModelId);
    if (model) {
      if (appliedModelRef.current !== model.id) {
        appliedModelRef.current = model.id;
        setAspectRatio(model.defaultAspectRatio);
        setDuration(model.defaultDuration);
      }
      if (!model.features.imageToVideo && files.length > 0) {
        clearFiles();
      }
      if (!model.features.imageToVideo && activeExternalReference) {
        setActiveExternalReference(null);
      }
      if (model.channelType !== 'minimax-h3') {
        setReferenceVideoUrlsText('');
        setReferenceAudioUrlsText('');
      }
    }
  }, [selectedModelId, availableModels, activeExternalReference, clearFiles, files.length, setActiveExternalReference]);

  // Load character cards only when the active model can use Sora mentions.
  useEffect(() => {
    if (!isActive || !isSoraChannel || characterCardsLoadedRef.current) {
      return;
    }

    const loadCharacterCards = async () => {
      try {
        const res = await fetch('/api/user/character-cards');
        if (res.ok) {
          const data = await res.json();
          const completedCards = (data.data || []).filter(
            (c: CharacterCard) => c.status === 'completed' && c.characterName
          );
          setCharacterCards(completedCards);
          characterCardsLoadedRef.current = true;
        }
      } catch (err) {
        console.error('Failed to load character cards:', err);
      }
    };
    void loadCharacterCards();
  }, [isActive, isSoraChannel]);

  useEffect(() => {
    if (!isSoraChannel) {
      setShowCharacterMenu(false);
    }
  }, [isSoraChannel]);

  useEffect(() => {
    if (!activeExternalReference) return;
    if (files.length > 0) {
      clearFiles();
    }
  }, [activeExternalReference, clearFiles, files.length]);

  // 检测是否包含中文字符（暂时禁用）
  // const containsChinese = (text: string): boolean => {
  //   return /[\u4e00-\u9fa5]/.test(text);
  // };

  // 实时计算是否包含中文（暂时禁用）
  // const hasChinese = containsChinese(prompt);
  const hasChinese = false; // 暂时禁用中文检测

  // 处理提示词输入
  const handlePromptChange = (
    e: React.ChangeEvent<HTMLTextAreaElement>,
    setter: (value: string) => void
  ) => {
    setter(e.target.value);
  };

  const handleAddCharacter = (characterName: string) => {
    if (!isSoraChannel) return;
    const mention = `@${characterName}`;
    setPrompt((prev) => (prev ? `${prev} ${mention}` : mention));
    promptTextareaRef.current?.focus();
    setShowCharacterMenu(false);
  };

  const handleAddReferenceFiles = useCallback(
    (selectedFiles: File[]) => {
      const nextFiles: Array<{ file: File; preview: string }> = [];
      let hasOversizedImage = false;

      for (const file of selectedFiles) {
        if (!file.type.startsWith('image/')) continue;

        if (file.size > 15 * 1024 * 1024) {
          hasOversizedImage = true;
          continue;
        }

        nextFiles.push({ file, preview: URL.createObjectURL(file) });
      }

      if (hasOversizedImage) {
        toast({ title: '图片过大', description: '图片大小不能超过 15MB', variant: 'destructive' });
        setError('图片大小不能超过 15MB');
      }

      if (nextFiles.length > 0) {
        setError('');
        if (activeExternalReference) {
          setActiveExternalReference(null);
        }
        setFiles((prev) => [...prev, ...nextFiles]);
      }
    },
    [activeExternalReference, setActiveExternalReference]
  );

  const uploadReferenceMediaFile = useCallback(
    async (file: File, kind: ReferenceMediaKind): Promise<string> => {
      const formData = new FormData();
      formData.append('kind', kind);
      formData.append('file', file);

      const response = await fetch('/api/generate/sora/reference-media', {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || '参考素材上传失败');
      }

      const url = payload.data?.url;
      if (typeof url !== 'string' || !url.trim()) {
        throw new Error('参考素材上传成功但没有返回可用 URL');
      }

      return url.trim();
    },
    []
  );

  const handleAddReferenceMediaFiles = useCallback(
    async (selectedFiles: File[], kind: ReferenceMediaKind) => {
      if (!isMinimaxH3Channel) return;

      const existingCount = kind === 'video' ? referenceVideoUrls.length : referenceAudioUrls.length;
      const maxCount = kind === 'video' ? MINIMAX_H3_MAX_REFERENCE_VIDEOS : MINIMAX_H3_MAX_REFERENCE_AUDIOS;
      const maxBytes = kind === 'video' ? MINIMAX_H3_MAX_REFERENCE_VIDEO_BYTES : MINIMAX_H3_MAX_REFERENCE_AUDIO_BYTES;
      const referenceImageCount = files.length + (activeExternalReference ? 1 : 0);
      const totalReferenceCount = referenceImageCount + referenceVideoUrls.length + referenceAudioUrls.length;
      const acceptedFiles = selectedFiles.filter((file) => isReferenceMediaFile(file, kind));

      if (acceptedFiles.length === 0) {
        setError(kind === 'video' ? '请选择视频文件' : '请选择音频文件');
        return;
      }

      const oversizedFile = acceptedFiles.find((file) => file.size > maxBytes);
      if (oversizedFile) {
        setError(kind === 'video' ? '参考视频大小不能超过 200MB' : '参考音频大小不能超过 50MB');
        return;
      }

      const availableSlots = Math.max(0, maxCount - existingCount);
      const totalAvailableSlots = Math.max(0, MINIMAX_H3_MAX_TOTAL_REFERENCES - totalReferenceCount);
      const nextAvailableSlots = Math.min(availableSlots, totalAvailableSlots);
      if (nextAvailableSlots <= 0) {
        const countError =
          kind === 'video' ? `参考视频最多 ${maxCount} 条` : `参考音频最多 ${maxCount} 条`;
        setError(availableSlots <= 0 ? countError : `参考素材合计最多 ${MINIMAX_H3_MAX_TOTAL_REFERENCES} 个`);
        return;
      }

      const uploadFiles = acceptedFiles.slice(0, nextAvailableSlots);
      for (const file of uploadFiles) {
        const durationSeconds = await readBrowserMediaDurationSeconds(file, kind);
        if (durationSeconds !== null && !isMinimaxH3ReferenceMediaDurationValid(kind, durationSeconds)) {
          const limit = getReferenceMediaDurationLimit(kind);
          const kindName = kind === 'video' ? '视频' : '音频';
          const message = `参考${kindName}时长需在 ${limit.min}～${limit.max} 秒之间，当前检测为 ${durationSeconds.toFixed(2)} 秒。`;
          setError(message);
          toast({
            title: `参考${kindName}时长不符合要求`,
            description: message,
            variant: 'destructive',
          });
          return;
        }
      }

      setError('');
      setUploadingReferenceKind(kind);

      try {
        const uploadedUrls: string[] = [];
        for (const file of uploadFiles) {
          uploadedUrls.push(await uploadReferenceMediaFile(file, kind));
        }

        if (kind === 'video') {
          setReferenceVideoUrlsText((prev) =>
            uploadedUrls.reduce((next, url) => appendReferenceUrlText(next, url), prev)
          );
        } else {
          setReferenceAudioUrlsText((prev) =>
            uploadedUrls.reduce((next, url) => appendReferenceUrlText(next, url), prev)
          );
        }

        toast({
          title: kind === 'video' ? '参考视频已上传' : '参考音频已上传',
          description: `已添加 ${uploadedUrls.length} 条公网 URL`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : '参考素材上传失败';
        setError(message);
        toast({
          title: '参考素材上传失败',
          description: message,
          variant: 'destructive',
        });
      } finally {
        setUploadingReferenceKind(null);
      }
    },
    [
      isMinimaxH3Channel,
      activeExternalReference,
      files.length,
      referenceAudioUrls.length,
      referenceVideoUrls.length,
      uploadReferenceMediaFile,
    ]
  );

  const handleRemoveReferenceImage = useCallback((index: number) => {
    setFiles((prev) => {
      const target = prev[index];
      if (!target) return prev;

      URL.revokeObjectURL(target.preview);
      setCompressedCache((current) => {
        const nextCache = new Map(current);
        nextCache.delete(target.file);
        return nextCache;
      });

      return prev.filter((_, itemIndex) => itemIndex !== index);
    });
  }, []);


  const handlePromptKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!canMentionCharacterCards) {
      if (showCharacterMenu) {
        setShowCharacterMenu(false);
      }
      return;
    }

    const value = (e.target as HTMLTextAreaElement).value;
    const lastChar = value.slice(-1);
    if (lastChar === '@') {
      setShowCharacterMenu(true);
    } else if (e.key === 'Escape') {
      setShowCharacterMenu(false);
    }
  };

  const loadRecentGenerations = useCallback(async () => {
    try {
      const recentGenerations = await fetchRecentUserGenerations(12);
      const videoGenerations = filterGenerationsByKind(recentGenerations, 'video');
      const completedVideoGenerations = videoGenerations.filter(
        (generation) =>
          generation.resultUrl &&
          generation.status === 'completed' &&
          isTerminalGenerationStatus(generation.status) &&
          !deletedGenerationIdsRef.current.has(generation.id)
      );
      const failedVideoTasks = videoGenerations
        .filter(
          (generation) =>
            isFailedGenerationStatus(generation.status) &&
            !deletedGenerationIdsRef.current.has(generation.id)
        )
        .map(
          (generation) =>
            ({
              ...buildTaskFromGeneration(generation),
              persisted: true,
            }) satisfies Task
        );

      setGenerations((prev) =>
        mergeGenerationsById(prev, completedVideoGenerations)
      );
      if (failedVideoTasks.length > 0) {
        setTasks((prev) => mergeTasksById(prev, failedVideoTasks));
      }
    } catch (err) {
      console.error('Failed to load recent video generations:', err);
    }
  }, []);

  const markTaskAsFailed = useCallback((taskId: string, errorMessage: string, persisted = true) => {
    setTasks((prev) =>
      prev.map((task) =>
        task.id === taskId
          ? {
              ...task,
              status: 'failed' as const,
              errorMessage,
              persisted,
            }
          : task
      )
    );
  }, []);

  const handleClearFailedTasks = useCallback(async () => {
    if (clearingFailedTasks) return;

    const failedTasks = tasks.filter((task) => isFailedGenerationStatus(task.status));
    if (failedTasks.length === 0) return;

    const confirmed = window.confirm('确认清理当前生成页的错误记录吗？');
    if (!confirmed) return;

    const failedTaskIds = failedTasks
      .filter((task) => task.persisted !== false)
      .map((task) => task.id);
    const localOnlyCount = failedTasks.length - failedTaskIds.length;
    setClearingFailedTasks(true);
    setTasks((prev) => prev.filter((task) => !isFailedGenerationStatus(task.status)));

    try {
      const deletedCount = await deleteGenerationRecords(failedTaskIds);
      const description = [
        deletedCount > 0 ? `已删除 ${deletedCount} 条历史错误记录` : '',
        localOnlyCount > 0 ? `已移除 ${localOnlyCount} 条本地查询错误` : '',
      ]
        .filter(Boolean)
        .join('，') || '没有需要删除的历史错误记录';

      toast({
        title: '错误任务已清理',
        description,
      });
    } catch (err) {
      setTasks((prev) => mergeTasksById(prev, failedTasks));
      toast({
        title: '清理失败',
        description: err instanceof Error ? err.message : '清理错误任务失败',
        variant: 'destructive',
      });
    } finally {
      setClearingFailedTasks(false);
    }
  }, [clearingFailedTasks, tasks]);

  // 轮询任务状态
  const pollTaskStatus = useCallback(
    async (taskId: string, taskPrompt: string): Promise<void> => {
      if (abortControllersRef.current.has(taskId)) return;

      const controller = new AbortController();
      let shouldResyncAfterPoll = false;
      abortControllersRef.current.set(taskId, controller);

      try {
        await pollGenerationTask({
          taskId,
          taskPrompt,
          taskType: 'video',
          signal: controller.signal,
          onProgress: (payload) => {
            const nextStatus =
              payload.status === 'pending' || payload.status === 'processing'
                ? payload.status
                : 'processing';

            setTasks((prev) =>
              prev.map((task) =>
                task.id === taskId
                  ? {
                      ...task,
                      status: nextStatus,
                      progress:
                        typeof payload.progress === 'number'
                          ? payload.progress
                          : task.progress,
                    }
                  : task
              )
            );
          },
          onCompleted: async (generation) => {
            await update();
            setTasks((prev) => prev.filter((task) => task.id !== taskId));
            if (deletedGenerationIdsRef.current.has(generation.id)) return;
            setGenerations((prev) => mergeGenerationsById(prev, [generation]));
            void loadRecentGenerations();

            toast({
              title: '生成成功',
              description: `消耗 ${generation.cost} 积分`,
            });
          },
          onFailed: async (errorMessage, payload) => {
            if (!payload) {
              markTaskAsFailed(taskId, errorMessage, false);
              shouldResyncAfterPoll = true;
              return;
            }

            markTaskAsFailed(taskId, errorMessage, true);
          },
          onTimeout: async () => {
            markTaskAsFailed(taskId, '任务查询超时，请稍后刷新或到历史记录查看最终状态', false);
            shouldResyncAfterPoll = true;
          },
        });
      } finally {
        abortControllersRef.current.delete(taskId);
        if (shouldResyncAfterPoll) {
          await refreshGenerationFeedRef.current();
        }
      }
    },
    [loadRecentGenerations, markTaskAsFailed, update]
  );

  const loadPendingTasks = useCallback(async () => {
    try {
      const videoTasks = filterTasksByKind(
        await fetchPendingGenerationTasks(50),
        'video'
      ).map(
        (task) =>
          ({
            ...task,
            status: task.status === 'processing' ? 'processing' : 'pending',
            progress: typeof task.progress === 'number' ? task.progress : 0,
          }) satisfies Task
      );

      setTasks((prev) => replaceActiveTasks(prev, videoTasks));

      videoTasks.forEach((task) => {
        void pollTaskStatus(task.id, task.prompt);
      });
    } catch (err) {
      console.error('Failed to load pending video tasks:', err);
    }
  }, [pollTaskStatus]);

  const refreshGenerationFeed = useCallback(async () => {
    await Promise.allSettled([loadRecentGenerations(), loadPendingTasks()]);
  }, [loadPendingTasks, loadRecentGenerations]);

  useEffect(() => {
    refreshGenerationFeedRef.current = refreshGenerationFeed;
  }, [refreshGenerationFeed]);

  useEffect(() => {
    const abortControllers = abortControllersRef.current;
    if (!isActive) {
      abortControllers.forEach((controller) => controller.abort());
      abortControllers.clear();
      return;
    }

    const handleWindowFocus = () => {
      void refreshGenerationFeed();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshGenerationFeed();
      }
    };

    void refreshGenerationFeed();
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      abortControllers.forEach((controller) => controller.abort());
      abortControllers.clear();
    };
  }, [isActive, refreshGenerationFeed]);

  useEffect(() => {
    return () => {
      filesRef.current.forEach((file) => URL.revokeObjectURL(file.preview));
      filesRef.current = [];
    };
  }, []);

  const handleRemoveTask = useCallback(async (taskId: string) => {
    const controller = abortControllersRef.current.get(taskId);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(taskId);
    }

    try {
      await fetch(`/api/user/tasks/${taskId}`, { method: 'DELETE' });
    } catch (err) {
      console.error('取消任务请求失败:', err);
    }

    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  }, []);

  const handleRemoveGeneration = useCallback(
    async (generation: Generation) => {
      if (busyGenerationId) return;

      const confirmed = window.confirm('确认删除这条已生成记录吗？删除后将无法在当前站点继续访问该作品。');
      if (!confirmed) return;

      setBusyGenerationId(generation.id);
      deletedGenerationIdsRef.current.add(generation.id);
      setGenerations((prev) => prev.filter((item) => item.id !== generation.id));

      try {
        await deleteGenerationRecord(generation.id);
        if (activeExternalReference?.generationId === generation.id) {
          setActiveExternalReference(null);
        }
        toast({ title: '作品已删除' });
      } catch (err) {
        deletedGenerationIdsRef.current.delete(generation.id);
        setGenerations((prev) => mergeGenerationsById(prev, [generation]));
        toast({
          title: '删除失败',
          description: err instanceof Error ? err.message : '删除作品失败',
          variant: 'destructive',
        });
      } finally {
        setBusyGenerationId(null);
      }
    },
    [activeExternalReference, busyGenerationId, setActiveExternalReference]
  );

  // 构建提示词
  const buildPrompt = (): string => {
    return prompt.trim();
  };

  // 压缩并构建 files 数组
  const compressFilesIfNeeded = async (): Promise<{ mimeType: string; data: string }[]> => {
    if (files.length === 0 || !currentModel?.features.imageToVideo) {
      return [];
    }

    setCompressing(true);
    const results: { mimeType: string; data: string }[] = [];
    const nextCache = new Map(compressedCache);

    try {
      for (const { file } of files) {
        // Check cache first
        const cached = nextCache.get(file);
        if (cached) {
          results.push({
            mimeType: isMinimaxH3Channel ? 'image/jpeg' : 'image/webp',
            data: cached,
          });
          continue;
        }

        try {
          const compressedFile = await compressImageToWebP(file);
          const base64 = await fileToBase64(compressedFile);
          nextCache.set(file, base64);
          results.push({
            mimeType: isMinimaxH3Channel ? 'image/jpeg' : (compressedFile.type || 'image/webp'),
            data: base64,
          });
        } catch {
          const base64 = await fileToBase64(file);
          results.push({
            mimeType: file.type || 'image/jpeg',
            data: base64,
          });
        }
      }
      setCompressedCache(nextCache);
      return results;
    } finally {
      setCompressing(false);
    }
  };

  // 检查是否达到每日限制
  const isVideoLimitReached = dailyLimits.videoLimit > 0 && dailyUsage.videoCount >= dailyLimits.videoLimit;

  // 验证输入
  const validateInput = (): string | null => {
    if (!currentModel) return '请选择模型';
    if (uploadingReferenceKind) return '参考素材正在上传，请稍后提交';
    const invalidReferenceVideoUrl = referenceVideoUrls.find((url) => !isPublicReferenceUrl(url));
    const invalidReferenceAudioUrl = referenceAudioUrls.find((url) => !isPublicReferenceUrl(url));
    const referenceImageCount = files.length + (activeExternalReference ? 1 : 0);
    const totalReferenceCount = referenceImageCount + referenceVideoUrls.length + referenceAudioUrls.length;

    // 检查每日限制
    if (isVideoLimitReached) {
      return `今日视频生成次数已达上限 (${dailyLimits.videoLimit} 次)`;
    }
    if (!isMinimaxH3Channel && (referenceVideoUrls.length > 0 || referenceAudioUrls.length > 0)) {
      return '当前模型不支持视频或音频参考';
    }
    if (isMinimaxH3Channel && referenceVideoUrls.length > MINIMAX_H3_MAX_REFERENCE_VIDEOS) {
      return `参考视频最多 ${MINIMAX_H3_MAX_REFERENCE_VIDEOS} 条`;
    }
    if (isMinimaxH3Channel && referenceAudioUrls.length > MINIMAX_H3_MAX_REFERENCE_AUDIOS) {
      return `参考音频最多 ${MINIMAX_H3_MAX_REFERENCE_AUDIOS} 条`;
    }
    if (isMinimaxH3Channel && referenceImageCount > MINIMAX_H3_MAX_REFERENCE_IMAGES) {
      return `参考图片最多 ${MINIMAX_H3_MAX_REFERENCE_IMAGES} 张`;
    }
    if (isMinimaxH3Channel && totalReferenceCount > MINIMAX_H3_MAX_TOTAL_REFERENCES) {
      return `参考素材合计最多 ${MINIMAX_H3_MAX_TOTAL_REFERENCES} 个`;
    }
    if (isMinimaxH3Channel && invalidReferenceVideoUrl) {
      return `参考视频 URL 无效: ${invalidReferenceVideoUrl}`;
    }
    if (isMinimaxH3Channel && invalidReferenceAudioUrl) {
      return `参考音频 URL 无效: ${invalidReferenceAudioUrl}`;
    }
    if (activeExternalReference && !currentModel.features.imageToVideo) {
      return '当前模型不支持参考图，请切换支持图生视频的模型';
    }
    if (
      !prompt.trim() &&
      files.length === 0 &&
      !activeExternalReference &&
      referenceVideoUrls.length === 0 &&
      referenceAudioUrls.length === 0
    ) {
      return '请输入提示词或上传参考素材';
    }
    // 检测中文（暂时禁用）
    // if (containsChinese(prompt)) return '提示词禁止使用中文，请使用英文输入';
    return null;
  };

  const buildModelId = (ratio: string, dur: string): string => {
    return `sora2-${ratio}-${dur}`;
  };

  const getSubmissionFailureMessage = (result: PromiseRejectedResult) => {
    return result.reason instanceof Error ? result.reason.message : '生成失败';
  };

  // 单次提交任务的核心函数
  const submitSingleTask = async (
    taskPrompt: string,
    modelId: string,
    config: {
      aspectRatio: string;
      duration: string;
      files: { mimeType: string; data: string }[];
      referenceImageUrl?: string;
      referenceVideoUrls?: string[];
      referenceAudioUrls?: string[];
    }
  ) => {
    const fallbackModel = buildModelId(config.aspectRatio, config.duration);
    const res = await fetchGenerationSubmit('/api/generate/sora', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: fallbackModel,
        modelId,
        aspectRatio: config.aspectRatio,
        duration: config.duration,
        prompt: taskPrompt,
        files: config.files,
        referenceImageUrl: config.referenceImageUrl,
        referenceVideoUrls: config.referenceVideoUrls,
        referenceAudioUrls: config.referenceAudioUrls,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || '生成失败');
    }

    const newTask: Task = {
      id: data.data.id,
      prompt: taskPrompt,
      model: currentModel?.name || fallbackModel,
      modelId,
      type: 'sora-video',
      status: 'pending',
      createdAt: Date.now(),
    };
    setTasks((prev) => [newTask, ...prev]);
    void pollTaskStatus(data.data.id, taskPrompt);

    return data.data.id;
  };

  const handleGenerate = async () => {
    if (submissionLockRef.current) return;

    const validationError = validateInput();
    if (validationError) {
      setError(validationError);
      return;
    }

    submissionLockRef.current = true;
    setError('');
    setSubmitting(true);

    const taskPrompt = buildPrompt();

    try {
      // 处理图片压缩
      const taskFiles = await compressFilesIfNeeded();

      await submitSingleTask(taskPrompt, selectedModelId, {
        aspectRatio,
        duration,
        files: taskFiles,
        referenceImageUrl: activeExternalReference?.sourceUrl,
        referenceVideoUrls,
        referenceAudioUrls,
      });

      toast({
        title: '任务已提交',
        description: '任务已加入队列，可继续提交新任务',
      });

      // 更新今日使用量
      setDailyUsage(prev => ({ ...prev, videoCount: prev.videoCount + 1 }));

      // 清空输入（如果勾选了保留提示词则不清空）
      if (!keepPrompt) {
        setPrompt('');
        clearFiles();
        setActiveExternalReference(null);
        setReferenceVideoUrlsText('');
        setReferenceAudioUrlsText('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败');
    } finally {
      submissionLockRef.current = false;
      setSubmitting(false);
      setCompressing(false);
    }
  };

  // 抽卡模式：连续提交3个相同任务
  const handleGachaMode = async () => {
    if (submissionLockRef.current) return;

    const validationError = validateInput();
    if (validationError) {
      setError(validationError);
      return;
    }

    submissionLockRef.current = true;
    setError('');
    setSubmitting(true);

    const taskPrompt = buildPrompt();

    try {
      // 处理图片压缩 (只执行一次)
      const taskFiles = await compressFilesIfNeeded();
      const results = await Promise.allSettled(
        Array.from({ length: 3 }, () =>
          submitSingleTask(taskPrompt, selectedModelId, {
            aspectRatio,
            duration,
            files: taskFiles,
            referenceImageUrl: activeExternalReference?.sourceUrl,
            referenceVideoUrls,
            referenceAudioUrls,
          })
        )
      );
      const successfulCount = results.filter((result) => result.status === 'fulfilled').length;
      const failedResult = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );

      if (successfulCount === 0) {
        throw new Error(failedResult ? getSubmissionFailureMessage(failedResult) : '生成失败');
      }

      // 更新今日使用量
      setDailyUsage(prev => ({ ...prev, videoCount: prev.videoCount + successfulCount }));

      toast({
        title: successfulCount === 3 ? '已提交 3 个任务' : `已提交 ${successfulCount} / 3 个任务`,
        description:
          successfulCount === 3
            ? '抽卡模式启动，等待结果中...'
            : failedResult
              ? getSubmissionFailureMessage(failedResult)
              : '部分任务提交失败，请稍后重试',
      });

      // 清空输入（如果勾选了保留提示词则不清空）
      if (!keepPrompt) {
        setPrompt('');
        clearFiles();
        setActiveExternalReference(null);
        setReferenceVideoUrlsText('');
        setReferenceAudioUrlsText('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败');
    } finally {
      submissionLockRef.current = false;
      setSubmitting(false);
      setCompressing(false);
    }
  };


  return (
    <div
      className={cn(
        'flex w-full flex-col',
        embedded ? 'h-full min-h-0' : 'max-w-7xl mx-auto lg:h-[calc(100vh-100px)]'
      )}
    >
      {!embedded && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between mb-4 shrink-0">
          <div>
            <h1 className="text-2xl lg:text-3xl font-light text-foreground">视频生成</h1>
            <p className="text-foreground/50 text-sm lg:text-base mt-0.5 font-light">
              支持文本与参考图生成视频
            </p>
          </div>
          {dailyLimits.videoLimit > 0 && (
            <div className={cn(
              "px-3 py-1.5 rounded-lg border text-xs lg:text-sm",
              isVideoLimitReached
                ? "bg-red-500/10 border-red-500/30 text-red-400"
                : "bg-card/60 border-border/70 text-foreground/60"
            )}>
              今日: {dailyUsage.videoCount} / {dailyLimits.videoLimit}
            </div>
          )}
        </div>
      )}

      {embedded && dailyLimits.videoLimit > 0 && (
        <div className="mb-4 flex justify-end">
          <div className={cn(
            "px-3 py-1.5 rounded-lg border text-xs",
            isVideoLimitReached
              ? "bg-red-500/10 border-red-500/30 text-red-400"
              : "bg-card/60 border-border/70 text-foreground/60"
          )}>
            今日: {dailyUsage.videoCount} / {dailyLimits.videoLimit}
          </div>
        </div>
      )}

      {/* 警告提示 */}
      {modelsLoaded && availableModels.length === 0 && (
        <div className="p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-xl flex items-center gap-3 mb-4 shrink-0">
          <AlertCircle className="w-5 h-5 text-yellow-400 flex-shrink-0" />
          <p className="text-sm text-yellow-200">视频生成功能已被管理员禁用</p>
        </div>
      )}
      {isVideoLimitReached && (
        <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl flex items-center gap-3 mb-4 shrink-0">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-300">今日视频生成次数已达上限，请明天再试</p>
        </div>
      )}

      {/* 移动端：输入在上，结果在下 */}
      {/* 桌面端：结果在上，输入在下 */}
      
      {/* 底部创作面板 */}
      <div className={cn(
        "surface order-2 shrink-0 overflow-visible mt-4",
        embedded && "min-h-[15rem]",
        (availableModels.length === 0 || isVideoLimitReached) && "opacity-50 pointer-events-none"
      )}>
        <div className="flex flex-col gap-3 border-b border-border/70 px-3 py-3 xl:flex-row xl:items-center xl:justify-between">
          {createModeSwitcher && (
            <div className="w-full xl:w-auto xl:shrink-0">
              {createModeSwitcher}
            </div>
          )}
          <div className="flex min-w-0 flex-1 items-center justify-end">
            <div className="inline-flex items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm font-medium text-foreground">
              <Sparkles className="w-4 h-4 text-sky-300" />
              <span>生成</span>
            </div>
          </div>
        </div>

        <div className="p-4">
          {/* 输入区域：图片上传 + 文本输入 */}
          <div className="flex flex-col sm:flex-row gap-4 mb-4">
            {/* 图片上传区 */}
            {(currentModel?.features.imageToVideo || activeExternalReference) && (
              <div className="flex justify-start">
                <ReferenceImageInput
                  images={files}
                  externalReference={activeExternalReference}
                  emptyLabel="参考图/视频帧"
                  externalBadge="已生成"
                  onAddFiles={handleAddReferenceFiles}
                  onRemoveImage={handleRemoveReferenceImage}
                  onClearExternalReference={() => setActiveExternalReference(null)}
                />
              </div>
            )}

            {/* 文本输入区 */}
            <div className="flex-1 relative">
              <textarea
                ref={promptTextareaRef}
                value={prompt}
                onChange={(e) => handlePromptChange(e, setPrompt)}
                onKeyUp={canMentionCharacterCards ? handlePromptKeyUp : undefined}
                placeholder={isSoraChannel ? '描述视频动态，或拖入图片生成图生视频... 输入 @ 引用角色卡' : '描述视频动态，或拖入图片生成图生视频...'}
                className="w-full h-20 px-3 py-2 bg-input/70 border border-border/70 text-foreground rounded-lg resize-none text-sm focus:outline-none focus:border-border focus:ring-2 focus:ring-ring/30"
              />

              {/* @ 触发的角色卡弹出菜单，仅 sora 渠道显示 */}
              {isSoraChannel && showCharacterMenu && characterCards.length > 0 && (
                <div className="absolute bottom-full left-0 mb-2 w-64 max-h-48 overflow-auto bg-card border border-border/70 rounded-lg shadow-lg z-20">
                  <div className="p-2 border-b border-border/70 text-xs text-foreground/50">选择角色卡</div>
                  {characterCards.map((card) => (
                    <button
                      key={card.id}
                      onClick={() => handleAddCharacter(card.characterName)}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-card/80 transition-colors text-left"
                    >
                      <div className="w-6 h-6 rounded-full overflow-hidden bg-gradient-to-br from-emerald-500/20 to-sky-500/20 shrink-0">
                        {card.avatarUrl ? (
                          <img
                            src={card.avatarUrl}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                            decoding="async"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <User className="w-3 h-3 text-emerald-300/60" />
                          </div>
                        )}
                      </div>
                      <span className="text-sm text-foreground">@{card.characterName}</span>
                    </button>
                  ))}
                  <button onClick={() => setShowCharacterMenu(false)} className="w-full px-3 py-2 text-xs text-foreground/50 hover:bg-card/80 border-t border-border/70">关闭</button>
                </div>
              )}

            </div>
          </div>

          {isMinimaxH3Channel && (
            <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="space-y-1.5">
                <input
                  ref={referenceVideoFileInputRef}
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/mkv,application/x-mpegurl,application/vnd.apple.mpegurl"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    const selectedFiles = Array.from(event.target.files || []);
                    event.target.value = '';
                    void handleAddReferenceMediaFiles(selectedFiles, 'video');
                  }}
                />
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-foreground/60">
                    <Film className="h-3.5 w-3.5" />
                    参考视频 URL
                  </label>
                  <button
                    type="button"
                    onClick={() => referenceVideoFileInputRef.current?.click()}
                    disabled={uploadingReferenceKind !== null}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-card/60 px-2 text-xs text-foreground/70 transition-colors hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {uploadingReferenceKind === 'video' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" />
                    )}
                    上传
                  </button>
                </div>
                <textarea
                  value={referenceVideoUrlsText}
                  onChange={(e) => setReferenceVideoUrlsText(e.target.value)}
                  placeholder="https://example.com/reference.mp4"
                  className="h-16 w-full resize-none rounded-lg border border-border/70 bg-input/70 px-3 py-2 text-xs text-foreground placeholder:text-foreground/30 focus:border-border focus:outline-none focus:ring-2 focus:ring-ring/30"
                />
              </div>
              <div className="space-y-1.5">
                <input
                  ref={referenceAudioFileInputRef}
                  type="file"
                  accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/aac,audio/ogg,audio/webm,audio/mp4"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    const selectedFiles = Array.from(event.target.files || []);
                    event.target.value = '';
                    void handleAddReferenceMediaFiles(selectedFiles, 'audio');
                  }}
                />
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-foreground/60">
                    <Music className="h-3.5 w-3.5" />
                    参考音频 URL
                  </label>
                  <button
                    type="button"
                    onClick={() => referenceAudioFileInputRef.current?.click()}
                    disabled={uploadingReferenceKind !== null}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-card/60 px-2 text-xs text-foreground/70 transition-colors hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {uploadingReferenceKind === 'audio' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" />
                    )}
                    上传
                  </button>
                </div>
                <textarea
                  value={referenceAudioUrlsText}
                  onChange={(e) => setReferenceAudioUrlsText(e.target.value)}
                  placeholder="https://example.com/reference.mp3"
                  className="h-16 w-full resize-none rounded-lg border border-border/70 bg-input/70 px-3 py-2 text-xs text-foreground placeholder:text-foreground/30 focus:border-border focus:outline-none focus:ring-2 focus:ring-ring/30"
                />
              </div>
            </div>
          )}

          {/* 参数行：选择器 + 按钮 */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between w-full">
            {/* Left Parameter Group */}
            <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-0">
              {/* 模型选择 */}
              <div className="w-full sm:w-[220px] flex-shrink-0">
                <CustomSelect
                  value={selectedModelId}
                  onValueChange={setSelectedModelId}
                  options={availableModels.map((m) => ({
                    value: m.id,
                    label: m.name,
                    description: m.description,
                    highlight: m.highlight,
                  }))}
                  placeholder="选择模型"
                />
              </div>

              {/* 时长选择 */}
              {currentModel && (
                <div className="w-[calc(50%-0.32rem)] sm:w-[100px] flex-initial">
                  <CustomSelect
                    value={duration}
                    onValueChange={setDuration}
                    options={currentModel.durations.map((d) => ({
                      value: d.value,
                      label: d.label,
                    }))}
                    placeholder="时长"
                  />
                </div>
              )}

              {/* 比例选择 */}
              {currentModel && (
                <div className="w-[calc(50%-0.32rem)] sm:w-[120px] flex-initial">
                  <CustomSelect
                    value={aspectRatio}
                    onValueChange={setAspectRatio}
                    options={currentModel.aspectRatios.map((r) => ({
                      value: r.value,
                      label: r.label,
                    }))}
                    placeholder="比例"
                  />
                </div>
              )}

              {/* 保留提示词 */}
              <InlineToggle
                checked={keepPrompt}
                onCheckedChange={setKeepPrompt}
                label="保留输入"
              />

              {/* 错误提示 */}
              {error && (
                <div className="flex items-center gap-1.5 text-xs text-red-400">
                  <AlertCircle className="w-3 h-3" />
                  <span>{error}</span>
                </div>
              )}
            </div>

            {/* Right Action Group */}
            <div className="flex items-center gap-2 shrink-0 justify-end w-full lg:w-auto">
              {currentModel && (
                <div className="hidden sm:flex h-9 items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 text-xs font-medium text-amber-100">
                  <span>预计 {estimatedVideoCost} 积分</span>
                  {referenceImageExtraCost > 0 && (
                    <span className="text-amber-200/70">+{referenceImageExtraCost}</span>
                  )}
                </div>
              )}

              {/* 抽卡按钮 */}
              {siteConfig.gachaEnabled && (
                <button
                  onClick={handleGachaMode}
                  disabled={submitting || compressing || hasChinese}
                  className={cn(
                    'inline-flex h-9 items-center gap-2 rounded-lg border px-3.5 text-xs font-medium transition-all',
                    submitting || compressing || hasChinese
                      ? 'cursor-not-allowed border-border/70 bg-card/50 text-foreground/40'
                      : 'border-amber-500/30 bg-amber-500/12 text-amber-200 hover:bg-amber-500/18'
                  )}
                  title="一次性提交 3 个相同参数的视频任务"
                >
                  <Dices className="w-4 h-4" />
                  <span>抽卡 x3</span>
                </button>
              )}

              {/* 生成按钮 */}
              <button
                onClick={handleGenerate}
                disabled={submitting || compressing || hasChinese}
                className={cn(
                  'inline-flex h-9 items-center justify-center gap-2 px-5 rounded-lg font-medium text-sm transition-all',
                  submitting || compressing || hasChinese
                    ? 'bg-card/60 text-foreground/40 cursor-not-allowed'
                    : 'bg-gradient-to-r from-sky-500 to-emerald-500 text-white hover:opacity-90'
                )}
              >
                {submitting || compressing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{compressing ? '处理图片中...' : '提交中...'}</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    <span>立即生成</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 结果区域 - 移动端在下面，桌面端在上面 */}
      <div className="order-1 flex-1 min-h-0 overflow-hidden">
        <ResultGallery
          generations={generations}
          tasks={tasks}
          onRemoveTask={handleRemoveTask}
          onClearFailedTasks={handleClearFailedTasks}
          onRemoveGeneration={handleRemoveGeneration}
          busyGenerationId={busyGenerationId}
          clearingFailedTasks={clearingFailedTasks}
        />
      </div>
    </div>
  );
}

export default function VideoGenerationPage() {
  return <VideoGenerationView />;
}
