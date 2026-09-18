'use client';
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  History,
  Image as ImageIcon,
  Images,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { Generation, GenerationBatchSummary, SafeImageModel } from '@/types';
import { toast } from '@/components/ui/toaster';
import { CustomSelect } from '@/components/ui/select-custom';
import { GenerationErrorAlert } from '@/components/generator/generation-error-alert';
import { cn, formatBalance } from '@/lib/utils';
import { compressImageToWebP, fileToBase64 } from '@/lib/image-compression';
import {
  fetchGenerationSubmit,
  pollGenerationTask,
  type GenerationStatusPayload,
} from '@/lib/generation-client';

type BatchTaskStatus =
  | 'idle'
  | 'submitting'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

type BatchImageItem = {
  id: string;
  file: File;
  preview: string;
};

type BatchTask = {
  id: string;
  prompt: string;
  images: BatchImageItem[];
  status: BatchTaskStatus;
  progress: number;
  modelId?: string;
  generationId?: string;
  resultUrl?: string;
  cost?: number;
  error?: string;
};

type DailyUsagePayload = {
  usage?: { imageCount?: number };
  limits?: { imageLimit?: number };
};

type BatchSubmitContext = {
  batchId: string;
  batchName: string;
  batchSize: number;
};

const MAX_IMAGES_PER_TASK = 6;
const MAX_BATCH_TASKS = 9;
const DEFAULT_TASK_COUNT = 6;
const SUBMIT_PARALLELISM = 3;
const GLOBAL_MODEL_VALUE = '__global__';

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createEmptyTask(index?: number): BatchTask {
  return {
    id: createId(`task-${index ?? 'new'}`),
    prompt: '',
    images: [],
    status: 'idle',
    progress: 0,
  };
}

function statusLabel(status: BatchTaskStatus): string {
  const labels: Record<BatchTaskStatus, string> = {
    idle: '\u5f85\u5f00\u59cb',
    submitting: '\u63d0\u4ea4\u4e2d',
    pending: '\u6392\u961f\u4e2d',
    processing: '\u751f\u6210\u4e2d',
    completed: '\u5df2\u5b8c\u6210',
    failed: '\u5931\u8d25',
  };
  return labels[status];
}

function statusClass(status: BatchTaskStatus): string {
  if (status === 'completed') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25';
  if (status === 'failed') return 'bg-red-500/15 text-red-300 border-red-500/25';
  if (status === 'processing') return 'bg-sky-500/15 text-sky-300 border-sky-500/25';
  if (status === 'pending' || status === 'submitting') return 'bg-amber-500/15 text-amber-300 border-amber-500/25';
  return 'bg-card/70 text-foreground/50 border-border/70';
}

function modelSupportsTask(model: SafeImageModel | undefined, task: BatchTask): boolean {
  if (!model) return false;
  const hasImages = task.images.length > 0;
  if (hasImages && !model.features.imageToImage) return false;
  if (model.requiresReferenceImage && !hasImages) return false;
  if (!model.allowEmptyPrompt && !task.prompt.trim()) return false;
  return true;
}

function resolveTaskModel(
  models: SafeImageModel[],
  defaultModelId: string,
  task: BatchTask
): SafeImageModel | undefined {
  return models.find((model) => model.id === (task.modelId || defaultModelId));
}

function resolveTaskAspectRatio(model: SafeImageModel, preferredAspectRatio: string): string {
  if (model.aspectRatios.includes(preferredAspectRatio)) return preferredAspectRatio;
  return model.defaultAspectRatio || model.aspectRatios[0] || '1:1';
}

function resolveTaskImageSize(model: SafeImageModel, preferredImageSize: string): string | undefined {
  if (!model.features.imageSize) return undefined;
  if (model.imageSizes?.includes(preferredImageSize)) return preferredImageSize;
  return model.defaultImageSize || model.imageSizes?.[0] || preferredImageSize;
}

async function compressTaskImages(images: BatchImageItem[]): Promise<Array<{ mimeType: string; data: string }>> {
  const compressed: Array<{ mimeType: string; data: string }> = [];

  for (const image of images) {
    const compressedFile = await compressImageToWebP(image.file);
    const base64 = await fileToBase64(compressedFile);
    compressed.push({
      mimeType: 'image/jpeg',
      data: `data:image/jpeg;base64,${base64}`,
    });
  }

  return compressed;
}

async function downloadUrl(url: string, filename: string) {
  const response = await fetch(url);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

export function BatchImageGenerationPage() {
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const fileInputRefs = useRef<Map<string, HTMLInputElement | null>>(new Map());
  const [models, setModels] = useState<SafeImageModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [imageSize, setImageSize] = useState('1K');
  const [tasks, setTasks] = useState<BatchTask[]>(() =>
    Array.from({ length: DEFAULT_TASK_COUNT }, (_, index) => createEmptyTask(index + 1))
  );
  const [promptImport, setPromptImport] = useState('');
  const [submittingAll, setSubmittingAll] = useState(false);
  const [dailyUsage, setDailyUsage] = useState({ imageCount: 0, imageLimit: 0 });
  const [recentBatches, setRecentBatches] = useState<GenerationBatchSummary[]>([]);
  const [error, setError] = useState('');

  const currentModel = useMemo(
    () => models.find((model) => model.id === selectedModelId),
    [models, selectedModelId]
  );

  const runnableTasks = useMemo(
    () =>
      tasks.filter((task) =>
        modelSupportsTask(resolveTaskModel(models, selectedModelId, task), task)
      ),
    [models, selectedModelId, tasks]
  );

  const completedTasks = tasks.filter((task) => task.status === 'completed');
  const runningCount = tasks.filter((task) =>
    ['submitting', 'pending', 'processing'].includes(task.status)
  ).length;
  const totalCost = completedTasks.reduce((sum, task) => sum + (task.cost || 0), 0);
  const remainingDaily = dailyUsage.imageLimit > 0
    ? Math.max(0, dailyUsage.imageLimit - dailyUsage.imageCount)
    : Infinity;

  const updateTask = useCallback((taskId: string, patch: Partial<BatchTask>) => {
    setTasks((current) =>
      current.map((task) => (task.id === taskId ? { ...task, ...patch } : task))
    );
  }, []);

  const loadModels = useCallback(async (isInitial = true) => {
    try {
      if (isInitial) setModelsLoading(true);
      const response = await fetch('/api/image-models', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to load models');

      const availableModels = (payload.data?.models || []) as SafeImageModel[];
      setModels(availableModels);
      if (availableModels.length > 0) {
        const fallback = availableModels[0];
        setSelectedModelId((prev) => {
          if (prev && availableModels.some((model) => model.id === prev)) return prev;
          // fall back to the first model when the current one was disabled
          setAspectRatio(fallback.defaultAspectRatio || fallback.aspectRatios[0] || '1:1');
          setImageSize(fallback.defaultImageSize || fallback.imageSizes?.[0] || '1K');
          return fallback.id;
        });
      }
    } catch (err) {
      // keep the stale list on refresh failures; only surface errors on initial load
      if (isInitial) setError(err instanceof Error ? err.message : 'Failed to load models');
    } finally {
      if (isInitial) setModelsLoading(false);
    }
  }, []);

  const loadDailyUsage = useCallback(async () => {
    try {
      const response = await fetch('/api/user/daily-usage', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json();
      const data = (payload.data || {}) as DailyUsagePayload;
      setDailyUsage({
        imageCount: Number(data.usage?.imageCount || 0),
        imageLimit: Number(data.limits?.imageLimit || 0),
      });
    } catch {
      // ignore
    }
  }, []);

  const loadRecentBatches = useCallback(async () => {
    try {
      const response = await fetch('/api/user/generation-batches?limit=6', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json();
      setRecentBatches((payload.data || []) as GenerationBatchSummary[]);
    } catch {
      // ignore
    }
  }, []);

  const deleteBatch = useCallback(
    async (batchId: string, batchName: string) => {
      if (!window.confirm(`Delete batch "${batchName}"? This cannot be undone.`)) return;
      try {
        const response = await fetch('/api/user/generation-batches', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchId }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || 'Failed to delete batch');
        }
        setRecentBatches((current) => current.filter((batch) => batch.batchId !== batchId));
        toast({ title: '\u6279\u6b21\u5df2\u5220\u9664', description: `\u5df2\u5220\u9664 ${payload.deletedCount} \u6761\u8bb0\u5f55` });
      } catch (err) {
        toast({
          title: '\u5220\u9664\u5931\u8d25',
          description: err instanceof Error ? err.message : '\u5220\u9664\u5931\u8d25',
          variant: 'destructive',
        });
      }
    },
    []
  );

  const deleteAllBatches = useCallback(async () => {
    if (!window.confirm('Delete ALL batches? Active tasks are kept. This cannot be undone.')) return;
    try {
      const response = await fetch('/api/user/generation-batches', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Failed to delete batches');
      }
      setRecentBatches([]);
      toast({ title: '\u5df2\u6e05\u7a7a\u6279\u6b21', description: `\u5df2\u5220\u9664 ${payload.deletedCount} \u6761\u8bb0\u5f55` });
    } catch (err) {
      toast({
        title: '\u5220\u9664\u5931\u8d25',
        description: err instanceof Error ? err.message : '\u5220\u9664\u5931\u8d25',
        variant: 'destructive',
      });
    }
  }, []);

  useEffect(() => {
    void loadModels();
    void loadDailyUsage();
    void loadRecentBatches();
    const abortControllers = abortControllersRef.current;

    // Reload models on browser tab focus and a low-frequency poll so admin
    // channel/model toggles reach open user pages quickly.
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void loadModels(false);
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const timer = setInterval(() => {
      if (!document.hidden) void loadModels(false);
    }, 60000);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      clearInterval(timer);
      abortControllers.forEach((controller) => controller.abort());
      tasks.forEach((task) => task.images.forEach((image) => URL.revokeObjectURL(image.preview)));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDailyUsage, loadModels, loadRecentBatches]);

  const handleModelChange = (modelId: string) => {
    const model = models.find((item) => item.id === modelId);
    setSelectedModelId(modelId);
    if (model) {
      setAspectRatio(model.defaultAspectRatio || model.aspectRatios[0] || '1:1');
      setImageSize(model.defaultImageSize || model.imageSizes?.[0] || '1K');
    }
  };

  const applyModelToAllTasks = () => {
    if (!selectedModelId) return;
    setTasks((current) =>
      current.map((task) => ({
        ...task,
        modelId: selectedModelId,
      }))
    );
    toast({ title: '\u5df2\u5c06\u7edf\u4e00\u6a21\u578b\u5e94\u7528\u5230\u5168\u90e8\u4efb\u52a1' });
  };

  const addTask = () => {
    if (tasks.length >= MAX_BATCH_TASKS) {
      toast({
        title: '\u6279\u91cf\u4efb\u52a1\u5df2\u8fbe\u5230\u4e0a\u9650',
        description: `\u4e00\u6b21\u6700\u591a\u53ef\u4ee5\u51c6\u5907 ${MAX_BATCH_TASKS} \u4e2a\u4efb\u52a1`,
      });
      return;
    }

    setTasks((current) => {
      if (current.length >= MAX_BATCH_TASKS) {
        return current;
      }
      return [...current, createEmptyTask(current.length + 1)];
    });
  };

  const removeTask = (taskId: string) => {
    if (tasks.length <= 1) return;
    const task = tasks.find((item) => item.id === taskId);
    task?.images.forEach((image) => URL.revokeObjectURL(image.preview));
    abortControllersRef.current.get(taskId)?.abort();
    abortControllersRef.current.delete(taskId);
    setTasks((current) => current.filter((item) => item.id !== taskId));
  };

  const clearAll = () => {
    abortControllersRef.current.forEach((controller) => controller.abort());
    abortControllersRef.current.clear();
    tasks.forEach((task) => task.images.forEach((image) => URL.revokeObjectURL(image.preview)));
    setTasks(Array.from({ length: DEFAULT_TASK_COUNT }, (_, index) => createEmptyTask(index + 1)));
    setPromptImport('');
    setError('');
  };

  const applyPromptImport = () => {
    const prompts = promptImport
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (prompts.length === 0) {
      toast({ title: '\u8bf7\u5148\u8f93\u5165\u63d0\u793a\u8bcd' });
      return;
    }

    const limitedPrompts = prompts.slice(0, MAX_BATCH_TASKS);

    setTasks((current) => {
      const next = [...current];
      while (next.length < limitedPrompts.length && next.length < MAX_BATCH_TASKS) {
        next.push(createEmptyTask(next.length + 1));
      }
      return next.map((task, index) =>
        index < limitedPrompts.length
          ? { ...task, prompt: limitedPrompts[index], status: 'idle', progress: 0, error: undefined }
          : task
      );
    });

    toast({
      title: '\u5df2\u5bfc\u5165\u63d0\u793a\u8bcd',
      description: prompts.length > MAX_BATCH_TASKS
        ? `\u5df2\u5bfc\u5165\u524d ${MAX_BATCH_TASKS} \u4e2a\uff0c\u8d85\u51fa\u90e8\u5206\u8bf7\u5206\u6279\u5904\u7406`
        : `${limitedPrompts.length} \u4e2a\u6279\u91cf\u4efb\u52a1\u5df2\u51c6\u5907`,
    });
  };

  const addFilesToTask = (taskId: string, files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    setTasks((current) =>
      current.map((task) => {
        if (task.id !== taskId) return task;
        const availableSlots = Math.max(0, MAX_IMAGES_PER_TASK - task.images.length);
        if (imageFiles.length > availableSlots) {
          toast({
            title: '\u53c2\u8003\u56fe\u5df2\u8fbe\u5230\u4e0a\u9650',
            description: `\u6bcf\u4e2a\u4efb\u52a1\u6700\u591a\u652f\u6301 ${MAX_IMAGES_PER_TASK} \u5f20\u53c2\u8003\u56fe`,
          });
        }
        const nextImages = imageFiles.slice(0, availableSlots).map((file) => ({
          id: createId('image'),
          file,
          preview: URL.createObjectURL(file),
        }));
        return { ...task, images: [...task.images, ...nextImages] };
      })
    );
  };

  const removeImageFromTask = (taskId: string, imageId: string) => {
    setTasks((current) =>
      current.map((task) => {
        if (task.id !== taskId) return task;
        const target = task.images.find((image) => image.id === imageId);
        if (target) URL.revokeObjectURL(target.preview);
        return { ...task, images: task.images.filter((image) => image.id !== imageId) };
      })
    );
  };

  const pollTask = useCallback(
    async (task: BatchTask, generationId: string) => {
      const controller = new AbortController();
      abortControllersRef.current.set(task.id, controller);

      try {
        await pollGenerationTask({
          taskId: generationId,
          taskPrompt: task.prompt,
          taskType: 'image',
          signal: controller.signal,
          onProgress: (payload: GenerationStatusPayload) => {
            updateTask(task.id, {
              status: payload.status === 'processing' ? 'processing' : 'pending',
              progress: typeof payload.progress === 'number' ? payload.progress : 0,
            });
          },
          onCompleted: async (generation: Generation) => {
            updateTask(task.id, {
              status: 'completed',
              progress: 100,
              resultUrl: generation.resultUrl,
              cost: generation.cost,
              error: undefined,
            });
            setDailyUsage((current) => ({ ...current, imageCount: current.imageCount + 1 }));
          },
          onFailed: async (message: string, payload) => {
            if (!payload) {
              updateTask(task.id, {
                status: task.status === 'processing' ? 'processing' : 'pending',
                error: message,
              });
              return;
            }

            updateTask(task.id, { status: 'failed', error: message, progress: 0 });
          },
          onTimeout: async () => {
            updateTask(task.id, {
              status: task.status === 'processing' ? 'processing' : 'pending',
              error: '任务仍在处理中，请稍后到历史记录查看最终结果。',
            });
          },
        });
      } finally {
        abortControllersRef.current.delete(task.id);
      }
    },
    [updateTask]
  );

  const submitTask = useCallback(
    async (task: BatchTask, batchContext?: BatchSubmitContext, batchIndex?: number) => {
      const taskModel = resolveTaskModel(models, selectedModelId, task);
      if (!taskModel) throw new Error('\u8bf7\u5148\u9009\u62e9\u6a21\u578b');
      if (!modelSupportsTask(taskModel, task)) {
        if (!task.prompt.trim() && !taskModel.allowEmptyPrompt) {
          throw new Error('当前模型必须填写提示词，不能只上传参考图');
        }
        if (taskModel.requiresReferenceImage && task.images.length === 0) {
          throw new Error('当前模型需要上传参考图');
        }
        if (task.images.length > 0 && !taskModel.features.imageToImage) {
          throw new Error('当前模型不支持参考图生成');
        }
        throw new Error('任务内容不完整，请检查提示词、模型和参考图');
      }

      const taskAspectRatio = resolveTaskAspectRatio(taskModel, aspectRatio);
      const taskImageSize = resolveTaskImageSize(taskModel, imageSize);

      updateTask(task.id, {
        status: 'submitting',
        progress: 0,
        error: undefined,
        resultUrl: undefined,
        generationId: undefined,
      });

      const images = await compressTaskImages(task.images);
      const response = await fetchGenerationSubmit('/api/generate/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: taskModel.id,
          prompt: task.prompt.trim(),
          aspectRatio: taskAspectRatio,
          imageSize: taskImageSize,
          images,
          clientRequestId: createId('batch-image'),
          batchId: batchContext?.batchId,
          batchName: batchContext?.batchName,
          batchIndex,
          batchSize: batchContext?.batchSize,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || '\u751f\u6210\u4efb\u52a1\u63d0\u4ea4\u5931\u8d25');
      }

      const generationId = payload.data.id as string;
      updateTask(task.id, {
        status: 'pending',
        generationId,
        progress: 0,
      });
      void pollTask(task, generationId);
    },
    [aspectRatio, imageSize, models, pollTask, selectedModelId, updateTask]
  );

  const submitTasks = useCallback(
    async (targetTasks: BatchTask[]) => {
      if (!selectedModelId && targetTasks.every((task) => !task.modelId)) {
        setError('\u8bf7\u5148\u9009\u62e9\u6a21\u578b');
        return;
      }

      const eligible = targetTasks.filter((task) =>
        modelSupportsTask(resolveTaskModel(models, selectedModelId, task), task)
      );
      if (eligible.length > MAX_BATCH_TASKS) {
        setError(`\u4e00\u6b21\u6700\u591a\u63d0\u4ea4 ${MAX_BATCH_TASKS} \u4e2a\u6279\u91cf\u4efb\u52a1\uff0c\u8bf7\u5206\u6279\u5904\u7406`);
        return;
      }
      if (eligible.length === 0) {
        setError('\u6ca1\u6709\u53ef\u63d0\u4ea4\u7684\u4efb\u52a1');
        return;
      }

      if (dailyUsage.imageLimit > 0 && eligible.length > remainingDaily) {
        setError(`\u4eca\u65e5\u5269\u4f59\u56fe\u50cf\u751f\u6210\u6b21\u6570\u4e0d\u8db3\uff0c\u5269\u4f59 ${remainingDaily} \u6b21`);
        return;
      }

      setError('');
      setSubmittingAll(true);
      const shouldCreateBatch = targetTasks.length > 1;
      const batchContext: BatchSubmitContext | undefined = shouldCreateBatch
        ? {
            batchId: createId('batch'),
            batchName: `Batch ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
            batchSize: eligible.length,
          }
        : undefined;
      let cursor = 0;
      let submitted = 0;

      async function worker() {
        while (cursor < eligible.length) {
          const task = eligible[cursor];
          const taskIndex = cursor + 1;
          cursor += 1;
          try {
            await submitTask(task, batchContext, taskIndex);
            submitted += 1;
          } catch (err) {
            updateTask(task.id, {
              status: 'failed',
              error: err instanceof Error ? err.message : '图片生成失败，请稍后重试',
              progress: 0,
            });
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(SUBMIT_PARALLELISM, eligible.length) }, worker));
      setSubmittingAll(false);
      if (batchContext) {
        void loadRecentBatches();
      }

      toast({
        title: '\u6279\u91cf\u4efb\u52a1\u5df2\u5904\u7406',
        description: `${submitted} / ${eligible.length} \u4e2a\u4efb\u52a1\u5df2\u5b8c\u6210\u6216\u8fdb\u5165\u8f6e\u8be2`,
      });
    },
    [dailyUsage.imageLimit, loadRecentBatches, models, remainingDaily, selectedModelId, submitTask, updateTask]
  );

  const submitSingle = (task: BatchTask) => {
    void submitTasks([task]);
  };

  const downloadAll = async () => {
    const downloadable = completedTasks.filter((task) => task.resultUrl);
    if (downloadable.length === 0) return;

    for (let index = 0; index < downloadable.length; index += 1) {
      const task = downloadable[index];
      await downloadUrl(task.resultUrl!, `batch-image-${index + 1}.png`);
    }
  };

  const modelOptions = models.map((model) => ({
    value: model.id,
    label: model.name,
    description: model.description,
    highlight: model.highlight,
  }));

  const aspectOptions = (currentModel?.aspectRatios || ['1:1']).map((ratio) => ({
    value: ratio,
    label: ratio,
  }));

  const sizeOptions = (currentModel?.imageSizes || ['1K']).map((size) => ({
    value: size,
    label: size,
  }));

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      <section className="surface overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-border/70 p-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-sky-500/25 bg-sky-500/10 px-3 py-1 text-xs text-sky-300">
                <Images className="h-3.5 w-3.5" />
                {'\u6279\u91cf\u521b\u4f5c'}
              </div>
              <h1 className="text-2xl font-light text-foreground">{'\u6279\u91cf\u751f\u56fe'}</h1>
              <span className="rounded-full border border-border/70 bg-card/50 px-2.5 py-1 text-xs text-foreground/45">
                {`${tasks.length} / ${MAX_BATCH_TASKS} \u4e2a\u4efb\u52a1`}
              </span>
            </div>
            <p className="mt-2 text-sm text-foreground/50">
              {'\u4e00\u6b21\u51c6\u5907\u591a\u4e2a\u63d0\u793a\u8bcd\u6216\u53c2\u8003\u56fe\uff0c\u6309\u961f\u5217\u6279\u91cf\u63d0\u4ea4\u751f\u6210'}
            </p>
          </div>
          <div className="grid w-full grid-cols-3 gap-2 rounded-xl border border-border/70 bg-card/45 p-2 text-center sm:w-auto sm:min-w-[300px]">
            <div className="rounded-lg bg-background/25 px-3 py-2">
              <p className="text-base font-semibold text-foreground">{runnableTasks.length}</p>
              <p className="text-[11px] text-foreground/45">{'\u53ef\u63d0\u4ea4'}</p>
            </div>
            <div className="rounded-lg bg-background/25 px-3 py-2">
              <p className="text-base font-semibold text-sky-300">{runningCount}</p>
              <p className="text-[11px] text-foreground/45">{'\u8fdb\u884c\u4e2d'}</p>
            </div>
            <div className="rounded-lg bg-background/25 px-3 py-2">
              <p className="text-base font-semibold text-emerald-300">{formatBalance(totalCost)}</p>
              <p className="text-[11px] text-foreground/45">{'\u5df2\u6d88\u8017'}</p>
            </div>
          </div>
        </div>

        <div className="grid gap-3 p-4 lg:grid-cols-[minmax(240px,1.25fr)_minmax(150px,0.7fr)_minmax(150px,0.7fr)_auto] lg:items-end">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <label className="text-xs uppercase tracking-wider text-foreground/45">{'\u6a21\u578b'}</label>
              <button
                type="button"
                onClick={applyModelToAllTasks}
                disabled={!selectedModelId}
                className="text-xs text-sky-300 transition hover:text-sky-200 disabled:cursor-not-allowed disabled:text-foreground/30"
              >
                {'\u5e94\u7528\u5230\u5168\u90e8'}
              </button>
            </div>
            <CustomSelect
              value={selectedModelId}
              onValueChange={handleModelChange}
              options={modelOptions}
              disabled={modelsLoading}
              placeholder={modelsLoading ? 'Loading...' : '\u9009\u62e9\u6a21\u578b'}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wider text-foreground/45">{'\u753b\u9762\u6bd4\u4f8b'}</label>
            <CustomSelect value={aspectRatio} onValueChange={setAspectRatio} options={aspectOptions} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wider text-foreground/45">{'\u5206\u8fa8\u7387'}</label>
            <CustomSelect
              value={imageSize}
              onValueChange={setImageSize}
              options={sizeOptions}
              disabled={!currentModel?.features.imageSize}
            />
          </div>
          <button
            type="button"
            onClick={() => void submitTasks(tasks)}
            disabled={submittingAll || runnableTasks.length === 0}
            className={cn(
              'inline-flex h-10 items-center justify-center gap-2 rounded-xl px-6 text-sm font-medium transition-all',
              submittingAll || runnableTasks.length === 0
                ? 'cursor-not-allowed bg-card/60 text-foreground/40'
                : 'bg-gradient-to-r from-sky-500 to-emerald-500 text-white shadow-sm hover:opacity-90'
            )}
          >
            {submittingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {'\u5168\u90e8\u5f00\u59cb'}
          </button>
        </div>
      </section>

      {error && (
        <GenerationErrorAlert error={error} />
      )}

      <section className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid auto-rows-min gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {tasks.map((task, index) => (
            <TaskCard
              key={task.id}
              index={index}
              task={task}
              modelOptions={modelOptions}
              globalModelId={selectedModelId}
              canRemove={tasks.length > 1}
              fileInputRef={(node) => fileInputRefs.current.set(task.id, node)}
              onModelChange={(modelId) =>
                updateTask(task.id, {
                  modelId: modelId === GLOBAL_MODEL_VALUE ? undefined : modelId,
                })
              }
              onPromptChange={(prompt) => updateTask(task.id, { prompt })}
              onAddFiles={(files) => addFilesToTask(task.id, files)}
              onRemoveImage={(imageId) => removeImageFromTask(task.id, imageId)}
              onRemove={() => removeTask(task.id)}
              onStart={() => submitSingle(task)}
            />
          ))}
          <button
            type="button"
            onClick={addTask}
            disabled={tasks.length >= MAX_BATCH_TASKS}
            className={cn(
              'min-h-[220px] rounded-xl border border-dashed border-border/80 bg-card/30 text-foreground/45 transition',
              tasks.length >= MAX_BATCH_TASKS
                ? 'cursor-not-allowed opacity-50'
                : 'hover:border-sky-400/50 hover:bg-sky-500/10 hover:text-sky-300'
            )}
          >
            <Plus className="mx-auto h-6 w-6" />
            <span className="mt-2 block text-sm">
              {tasks.length >= MAX_BATCH_TASKS ? '\u5df2\u8fbe\u4e0a\u9650' : '\u6dfb\u52a0\u4efb\u52a1'}
            </span>
          </button>
        </div>

        <aside className="space-y-3 lg:sticky lg:top-4">
          <div className="surface overflow-hidden">
            <div className="border-b border-border/70 p-4">
              <h2 className="text-sm font-medium text-foreground">{'\u6279\u91cf\u5bfc\u5165'}</h2>
              <p className="mt-1 text-xs text-foreground/40">{'\u6bcf\u884c\u4e00\u4e2a\u63d0\u793a\u8bcd\uff0c\u81ea\u52a8\u5206\u914d\u5230\u4efb\u52a1\u5361'}</p>
            </div>
            <div className="space-y-3 p-4">
              <textarea
                value={promptImport}
                onChange={(event) => setPromptImport(event.target.value)}
                rows={6}
                placeholder={'\u672a\u6765\u57ce\u5e02\u591c\u666f\n\u4e2d\u5f0f\u8282\u65e5\u6d77\u62a5\n\u4ea7\u54c1\u6444\u5f71\uff0c\u767d\u8272\u80cc\u666f'}
                className="w-full resize-none rounded-lg border border-border/70 bg-input/70 px-3 py-2.5 text-sm text-foreground outline-none transition placeholder:text-muted-foreground/60 focus:border-border focus:ring-2 focus:ring-ring/30"
              />
              <button
                type="button"
                onClick={applyPromptImport}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border/70 bg-card/60 px-4 py-2.5 text-sm text-foreground transition hover:bg-card/80"
              >
                <Upload className="h-4 w-4" />
                {'\u5e94\u7528\u5230\u4efb\u52a1'}
              </button>
            </div>
          </div>

          <div className="surface p-3">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={clearAll}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-border/70 bg-card/60 px-4 py-2.5 text-sm text-foreground/70 transition hover:bg-card/80 hover:text-foreground"
              >
                <RotateCcw className="h-4 w-4" />
                {'\u6e05\u7a7a'}
              </button>
              <button
                type="button"
                onClick={() => void downloadAll()}
                disabled={completedTasks.length === 0}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-sm text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                {'\u4e0b\u8f7d'}
              </button>
            </div>
            <div className="mt-3 rounded-lg border border-border/70 bg-card/50 p-3 text-xs text-foreground/45">
              {dailyUsage.imageLimit > 0
                ? `\u4eca\u65e5\u5df2\u7528 ${dailyUsage.imageCount} / ${dailyUsage.imageLimit} \u6b21\u56fe\u50cf\u751f\u6210`
                : '\u4eca\u65e5\u56fe\u50cf\u751f\u6210\u6b21\u6570\u672a\u8bbe\u9650'}
            </div>
          </div>

          <div className="surface overflow-hidden">
            <div className="flex items-center justify-between border-b border-border/70 p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <History className="h-4 w-4 text-sky-300" />
                {'\u6700\u8fd1\u6279\u6b21'}
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void loadRecentBatches()}
                  className="text-xs text-sky-300 transition hover:text-sky-200"
                >
                  {'\u5237\u65b0'}
                </button>
                {recentBatches.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void deleteAllBatches()}
                    className="inline-flex items-center gap-1 text-xs text-red-300 transition hover:text-red-200"
                  >
                    <Trash2 className="h-3 w-3" />
                    {'\u6e05\u7a7a'}
                  </button>
                )}
              </div>
            </div>
            <div className="space-y-2 p-3">
              {recentBatches.length === 0 ? (
                <div className="rounded-lg border border-border/70 bg-card/50 p-3 text-xs text-foreground/45">
                  {'\u6682\u65e0\u6279\u6b21\u8bb0\u5f55'}
                </div>
              ) : (
                recentBatches.map((batch) => (
                  <div key={batch.batchId} className="rounded-lg border border-border/70 bg-card/50 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{batch.batchName}</p>
                        <p className="mt-1 truncate text-xs text-foreground/40">
                          {batch.samplePrompt || batch.batchId.slice(0, 8)}
                        </p>
                      </div>
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-foreground/50">
                        {batch.total}
                      </span>
                      <button
                        type="button"
                        onClick={() => void deleteBatch(batch.batchId, batch.batchName)}
                        className="shrink-0 rounded-md p-1.5 text-foreground/40 transition hover:bg-red-500/10 hover:text-red-300"
                        title={'\u5220\u9664\u6b64\u6279\u6b21'}
                        aria-label={'\u5220\u9664\u6b64\u6279\u6b21'}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-1.5 text-center text-xs">
                      <div className="rounded-md bg-emerald-500/10 py-1.5 text-emerald-300">
                        <p className="font-semibold">{batch.completed}</p>
                        <p className="text-[10px] opacity-70">{'\u5b8c\u6210'}</p>
                      </div>
                      <div className="rounded-md bg-amber-500/10 py-1.5 text-amber-300">
                        <p className="font-semibold">{batch.active}</p>
                        <p className="text-[10px] opacity-70">{'\u8fdb\u884c'}</p>
                      </div>
                      <div className="rounded-md bg-red-500/10 py-1.5 text-red-300">
                        <p className="font-semibold">{batch.failed}</p>
                        <p className="text-[10px] opacity-70">{'\u5931\u8d25'}</p>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-foreground/40">
                      <span>{`-\u6d88\u8017 ${formatBalance(batch.totalCost)}`}</span>
                      <span>{new Date(batch.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}

type TaskCardProps = {
  index: number;
  task: BatchTask;
  modelOptions: Array<{ value: string; label: string; description?: string; highlight?: boolean }>;
  globalModelId: string;
  canRemove: boolean;
  fileInputRef: (node: HTMLInputElement | null) => void;
  onModelChange: (modelId: string) => void;
  onPromptChange: (prompt: string) => void;
  onAddFiles: (files: File[]) => void;
  onRemoveImage: (imageId: string) => void;
  onRemove: () => void;
  onStart: () => void;
};

function TaskCard({
  index,
  task,
  modelOptions,
  globalModelId,
  canRemove,
  fileInputRef,
  onModelChange,
  onPromptChange,
  onAddFiles,
  onRemoveImage,
  onRemove,
  onStart,
}: TaskCardProps) {
  const isBusy = ['submitting', 'pending', 'processing'].includes(task.status);
  const taskModelOptions = [
    {
      value: GLOBAL_MODEL_VALUE,
      label: '\u8ddf\u968f\u7edf\u4e00\u6a21\u578b',
      description: globalModelId ? undefined : '\u8bf7\u5148\u9009\u62e9\u7edf\u4e00\u6a21\u578b',
    },
    ...modelOptions,
  ];

  return (
    <div
      className={cn(
        'rounded-xl border bg-card/55 p-3 shadow-sm transition',
        task.status === 'completed'
          ? 'border-emerald-500/35'
          : task.status === 'failed'
            ? 'border-red-500/35'
            : isBusy
              ? 'border-sky-500/35'
              : 'border-border/70 hover:border-border'
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{`\u4efb\u52a1 ${index + 1}`}</h3>
          <span className={cn('rounded-full border px-2 py-0.5 text-[11px]', statusClass(task.status))}>
            {statusLabel(task.status)}
          </span>
        </div>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md p-1.5 text-foreground/40 transition hover:bg-card/80 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="mb-2.5 space-y-1.5">
        <label className="text-xs uppercase tracking-wider text-foreground/45">{'\u6a21\u578b'}</label>
        <CustomSelect
          value={task.modelId || GLOBAL_MODEL_VALUE}
          onValueChange={onModelChange}
          options={taskModelOptions}
          disabled={isBusy}
          placeholder={'\u9009\u62e9\u6a21\u578b'}
        />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          onAddFiles(Array.from(event.target.files || []));
          event.target.value = '';
        }}
      />

      <div className="grid grid-cols-3 gap-1.5">
        {Array.from({ length: Math.max(3, Math.min(MAX_IMAGES_PER_TASK, task.images.length + 1)) }).map((_, slotIndex) => {
          const image = task.images[slotIndex];
          return image ? (
            <div key={image.id} className="group relative aspect-square overflow-hidden rounded-lg border border-border/70 bg-card/60">
              <img src={image.preview} alt="" className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => onRemoveImage(image.id)}
                className="absolute right-1 top-1 rounded-md bg-black/55 p-1 text-white opacity-0 transition group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              key={`slot-${slotIndex}`}
              type="button"
              onClick={() => {
                const input = document.querySelector<HTMLInputElement>(
                  `input[data-batch-task-id="${task.id}"]`
                );
                input?.click();
              }}
              className="aspect-square rounded-lg border-2 border-dashed border-border/70 bg-input/40 text-foreground/40 transition hover:border-sky-400/50 hover:bg-sky-500/10 hover:text-sky-300"
            >
              <Plus className="mx-auto h-5 w-5" />
            </button>
          );
        })}
      </div>
      <input
        data-batch-task-id={task.id}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          onAddFiles(Array.from(event.target.files || []));
          event.target.value = '';
        }}
      />

      <textarea
        value={task.prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        rows={2}
        placeholder={'\u8f93\u5165\u63d0\u793a\u8bcd...'}
        className="mt-2.5 w-full resize-none rounded-lg border border-border/70 bg-input/70 px-3 py-2.5 text-sm text-foreground outline-none transition placeholder:text-muted-foreground/60 focus:border-border focus:ring-2 focus:ring-ring/30"
      />

      {task.error && (
        <GenerationErrorAlert error={task.error} compact className="mt-2.5" />
      )}

      {task.resultUrl && (
        <a
          href={task.resultUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2.5 block overflow-hidden rounded-lg border border-border/70 bg-card/60"
        >
          <img src={task.resultUrl} alt="" className="aspect-video w-full object-cover" />
        </a>
      )}

      {isBusy && (
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-card/80">
          <div
            className="h-full rounded-full bg-gradient-to-r from-sky-400 to-emerald-400 transition-all"
            style={{ width: `${Math.max(8, task.progress || 8)}%` }}
          />
        </div>
      )}

      <button
        type="button"
        onClick={onStart}
        disabled={isBusy}
        className={cn(
          'mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg px-5 text-sm font-medium transition-all',
          isBusy
            ? 'cursor-not-allowed bg-card/60 text-foreground/40'
            : 'bg-gradient-to-r from-sky-500 to-emerald-500 text-white hover:opacity-90'
        )}
      >
        {task.status === 'completed' ? <CheckCircle2 className="h-4 w-4" /> : isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
        {task.status === 'completed' ? '\u91cd\u65b0\u751f\u6210' : '\u5f00\u59cb'}
      </button>
    </div>
  );
}

export default BatchImageGenerationPage;
