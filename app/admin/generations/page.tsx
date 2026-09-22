'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { History, Trash2, Search, Loader2, Eye, X } from 'lucide-react';
import { formatDate, cn } from '@/lib/utils';
import { IMAGE_MODELS } from '@/lib/model-config';
import { inferImageSizeLabel, aspectRatioOfSize } from '@/lib/image-sizing';
import { IMAGE_QUALITY_OPTIONS, isQualityAwareModelName } from '@/lib/image-quality';
import { toast } from '@/components/ui/toaster';
import { PaginationControls } from '@/components/admin/pagination';

const GENERATIONS_PAGE_SIZE = 50;

interface GenerationParams {
  model?: string;
  modelId?: string;
  aspectRatio?: string;
  imageSize?: string;
  size?: string;
  quality?: string;
}

interface GenerationRecord {
  id: string;
  userId: string;
  userEmail: string;
  userName: string;
  type: string;
  params?: GenerationParams;
  prompt: string;
  resultUrl: string;
  cost: number;
  status: string;
  errorMessage?: string | null;
  channelId?: string;
  channelName?: string;
  balancePrecharged?: boolean;
  balanceRefunded?: boolean;
  createdAt: number;
  updatedAt?: number;
}

interface UserFilter {
  userId: string;
  label: string;
}

interface FailureCategory {
  key: string;
  label: string;
  count: number;
  topMessages: string[];
}

interface FailureSummary {
  total: number;
  categories: FailureCategory[];
}

const TIME_OPTIONS = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'custom', label: '自定义' },
];

// Format generation duration (updatedAt - createdAt) into a compact human label.
function formatDuration(record: GenerationRecord): string | undefined {
  if (!record.updatedAt || !record.createdAt) return undefined;
  const seconds = Math.max(0, Math.round((record.updatedAt - record.createdAt) / 1000));
  if (record.status === 'pending' || record.status === 'processing') return undefined;
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes}m${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

// A failed, precharged generation that was never refunded means the user's
// points were silently taken — the most important thing for an admin to spot.
function needsRefundAttention(record: GenerationRecord): boolean {
  return (
    record.status === 'failed' &&
    record.cost > 0 &&
    Boolean(record.balancePrecharged) &&
    !record.balanceRefunded
  );
}

// Human-friendly labels for known channel types; unknown types fall back to
// their raw value so new channel types work with zero code changes.
const CHANNEL_TYPE_LABELS: Record<string, string> = {
  sora: 'Sora',
  'openai-compatible': 'OpenAI 兼容',
  apexerapi: 'ApexerAPI',
  flow2api: 'Flow2API',
  ztyunjuan: 'ZTYunjuan',
  gitee: 'Gitee',
};

function channelTypeLabel(type: string): string {
  return CHANNEL_TYPE_LABELS[type] || type;
}

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'completed', label: '已完成' },
  { value: 'pending', label: '等待中' },
  { value: 'processing', label: '处理中' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
];

const IMAGE_MODEL_LABELS = new Map(
  IMAGE_MODELS.map((model) => [model.apiModel, model.name])
);

const TYPE_LABELS: Record<string, string> = {
  'sora-video': '视频',
  'sora-image': 'Sora 图像',
  'gemini-image': 'Gemini 图像',
  'zimage-image': 'Z-Image 图像',
  'gitee-image': 'Gitee 图像',
};

// Map a quality value to its display label, reusing the same strings the user
// picker shows (`IMAGE_QUALITY_OPTIONS` in lib/image-quality.ts) so admin and
// the user see the same word for the same value.
function qualityLabel(quality: string): string {
  const match = IMAGE_QUALITY_OPTIONS.find((option) => option.value === quality);
  return match?.label ?? quality;
}

// Build the human readable "tier ratio" suffix from recorded params, e.g. "1K 16:9".
// imageSize already holds the normalized tier (1K/2K/4K); for legacy records without it
// we fall back to inferring both tier and ratio from the raw pixel size.
function getResolutionDetail(params?: GenerationParams): string | undefined {
  if (!params) return undefined;
  const parts: string[] = [];
  const tier = params.imageSize || inferImageSizeLabel(params.size);
  const ratio = params.aspectRatio || (params.size ? aspectRatioOfSize(params.size) : undefined);
  if (tier) parts.push(tier);
  if (ratio) parts.push(ratio);
  if (parts.length === 0 && params.size) parts.push(params.size);
  // `params.quality` is only populated by `resolveImageQuality`, which returns
  // `undefined` for models that don't participate in the quality pipeline. So a
  // non-empty value implies the model is quality-aware; the model-name check
  // is belt-and-suspenders against future writes from non-standard paths.
  if (params.quality && isQualityAwareModelName(params.model)) {
    parts.push(qualityLabel(params.quality));
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function getRecordTypeInfo(record: GenerationRecord): { label: string; detail?: string } {
  if (
    record.type === 'gemini-image' ||
    record.type === 'zimage-image' ||
    record.type === 'gitee-image'
  ) {
    const params = record.params;
    // Prefer the display name from the static model registry; when a channel-custom
    // model is unknown there (e.g. gpt-image-medium) show its real API model name
    // instead of degrading to the coarse channel type label.
    const modelLabel = params?.model
      ? IMAGE_MODEL_LABELS.get(params.model) || params.model
      : undefined;
    if (modelLabel) {
      const detail = getResolutionDetail(params);
      return detail ? { label: modelLabel, detail } : { label: modelLabel };
    }
  }

  return { label: TYPE_LABELS[record.type] || record.type };
}

export default function GenerationsPage() {
  const [records, setRecords] = useState<GenerationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [channelTypeFilter, setChannelTypeFilter] = useState('');
  const [availableChannelTypes, setAvailableChannelTypes] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [timeFilter, setTimeFilter] = useState('all');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [userFilter, setUserFilter] = useState<UserFilter | null>(null);
  const [failureSummary, setFailureSummary] = useState<FailureSummary | null>(null);
  const hasLoadedRecordsRef = useRef(false);
  const latestRecordsRequestRef = useRef(0);

  // Resolve the selected time filter into concrete timestamp bounds (ms).
  const getTimeRange = useCallback((): { start?: number; end?: number } => {
    if (timeFilter === 'today') {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return { start: d.getTime() };
    }
    if (timeFilter === '7d') return { start: Date.now() - 7 * 24 * 3600 * 1000 };
    if (timeFilter === '30d') return { start: Date.now() - 30 * 24 * 3600 * 1000 };
    if (timeFilter === 'custom') {
      const start = customStart ? new Date(`${customStart}T00:00:00`).getTime() : undefined;
      const end = customEnd ? new Date(`${customEnd}T23:59:59.999`).getTime() : undefined;
      return { start: Number.isFinite(start) ? start : undefined, end: Number.isFinite(end) ? end : undefined };
    }
    return {};
  }, [timeFilter, customStart, customEnd]);

  const loadRecords = useCallback(async (nextPage = 1, reset = false) => {
    const requestId = latestRecordsRequestRef.current + 1;
    latestRecordsRequestRef.current = requestId;
    const shouldShowInitialLoading = reset && !hasLoadedRecordsRef.current;

    try {
      if (shouldShowInitialLoading) {
        setLoading(true);
      } else {
        setFetching(true);
      }

      const params = new URLSearchParams();
      params.set('page', String(nextPage));
      params.set('limit', String(GENERATIONS_PAGE_SIZE));
      if (channelTypeFilter) params.set('channelType', channelTypeFilter);
      if (statusFilter) params.set('status', statusFilter);
      if (search.trim()) params.set('q', search.trim());
      if (userFilter) params.set('userId', userFilter.userId);
      const { start, end } = getTimeRange();
      if (start !== undefined) params.set('startTime', String(start));
      if (end !== undefined) params.set('endTime', String(end));

      const res = await fetch(`/api/admin/generations?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (requestId !== latestRecordsRequestRef.current) {
          return;
        }

        setRecords(data.data || []);
        setPage(data.page || nextPage);
        setTotal(data.total || 0);
        setFailureSummary(data.failureSummary || null);
        if (Array.isArray(data.availableChannelTypes)) {
          setAvailableChannelTypes(data.availableChannelTypes);
        }
        hasLoadedRecordsRef.current = true;
      } else {
        const data = await res.json().catch(() => ({}));
        toast({ title: '加载失败', description: data.error || '无法获取生成记录', variant: 'destructive' });
      }
    } catch (err) {
      toast({ title: '加载失败', description: err instanceof Error ? err.message : '无法获取生成记录', variant: 'destructive' });
    } finally {
      if (requestId === latestRecordsRequestRef.current) {
        setLoading(false);
        setFetching(false);
      }
    }
  }, [search, statusFilter, channelTypeFilter, userFilter, getTimeRange]);

  useEffect(() => {
    const handle = setTimeout(() => {
      loadRecords(1, true);
    }, 300);
    return () => clearTimeout(handle);
  }, [loadRecords]);

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此记录？')) return;
    
    try {
      const res = await fetch('/api/admin/generations', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        toast({ title: '记录已删除' });
        const nextPage = records.length === 1 && page > 1 ? page - 1 : page;
        loadRecords(nextPage, false);
      } else {
        const data = await res.json().catch(() => ({}));
        toast({ title: '删除失败', description: data.error || '无法删除记录', variant: 'destructive' });
      }
    } catch (err) {
      toast({ title: '删除失败', description: err instanceof Error ? err.message : '无法删除记录', variant: 'destructive' });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-foreground/30" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-light text-foreground">生成记录</h1>
        <p className="text-foreground/50 mt-1">管理所有用户的生成历史 · 共 {total} 条</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索用户或提示词..."
            className="w-full pl-11 pr-4 py-3 bg-card/60 border border-border/70 rounded-xl text-foreground placeholder:text-foreground/30 focus:outline-none focus:border-border/70"
          />
        </div>
        <select
          value={channelTypeFilter}
          onChange={(e) => setChannelTypeFilter(e.target.value)}
          className="px-4 py-3 bg-card/60 border border-border/70 rounded-xl text-foreground focus:outline-none focus:border-border/70"
        >
          <option value="">全部渠道类型</option>
          {availableChannelTypes.map(type => (
            <option key={type} value={type}>{channelTypeLabel(type)}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-4 py-3 bg-card/60 border border-border/70 rounded-xl text-foreground focus:outline-none focus:border-border/70"
        >
          {STATUS_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <select
          value={timeFilter}
          onChange={(e) => setTimeFilter(e.target.value)}
          className="px-4 py-3 bg-card/60 border border-border/70 rounded-xl text-foreground focus:outline-none focus:border-border/70"
        >
          {TIME_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        {timeFilter === 'custom' && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customStart}
              max={customEnd || undefined}
              onChange={(e) => setCustomStart(e.target.value)}
              className="px-3 py-3 bg-card/60 border border-border/70 rounded-xl text-foreground text-sm focus:outline-none focus:border-border/70"
            />
            <span className="text-foreground/40 text-sm">至</span>
            <input
              type="date"
              value={customEnd}
              min={customStart || undefined}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="px-3 py-3 bg-card/60 border border-border/70 rounded-xl text-foreground text-sm focus:outline-none focus:border-border/70"
            />
          </div>
        )}
        {userFilter && (
          <div className="flex items-center gap-2 px-4 py-3 bg-primary/10 border border-primary/30 rounded-xl">
            <span className="text-sm text-primary truncate max-w-[200px]" title={userFilter.label}>
              {userFilter.label}
            </span>
            <button
              onClick={() => setUserFilter(null)}
              className="p-1 text-primary/60 hover:text-primary hover:bg-primary/10 rounded transition-all"
              title="取消用户筛选"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Failure summary */}
      {failureSummary && failureSummary.total > 0 && (!statusFilter || statusFilter === 'failed') && (
        <div className="bg-red-500/5 border border-red-500/20 rounded-2xl px-5 py-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="text-sm font-medium text-red-400">失败原因分布</p>
            <p className="text-xs text-foreground/40">
              当前筛选范围内共 {failureSummary.total} 条失败 · 悬停查看典型错误信息
            </p>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            {failureSummary.categories.map((cat) => (
              <div
                key={cat.key}
                title={cat.topMessages.join('\n---\n') || undefined}
                className="px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/20 text-xs text-red-400 whitespace-nowrap"
              >
                {cat.label}
                <span className="ml-1.5 font-medium">{cat.count}</span>
                <span className="ml-1 text-foreground/35">
                  {Math.round((cat.count / failureSummary.total) * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Records Table */}
      <div className="bg-card/60 border border-border/70 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto no-scrollbar">
          <table className="w-full min-w-[860px]">
            <thead>
              <tr className="border-b border-border/70">
                <th className="text-left text-sm font-medium text-foreground/50 px-5 py-4">用户</th>
                <th className="text-left text-sm font-medium text-foreground/50 px-5 py-4">类型</th>
                <th className="text-left text-sm font-medium text-foreground/50 px-5 py-4 max-w-xs">提示词</th>
                <th className="text-center text-sm font-medium text-foreground/50 px-5 py-4">状态</th>
                <th className="text-right text-sm font-medium text-foreground/50 px-5 py-4">积分</th>
                <th className="text-right text-sm font-medium text-foreground/50 px-5 py-4">耗时</th>
                <th className="text-right text-sm font-medium text-foreground/50 px-5 py-4">时间</th>
                <th className="text-right text-sm font-medium text-foreground/50 px-5 py-4">操作</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => {
                const typeInfo = getRecordTypeInfo(record);
                return (
                <tr key={record.id} className="border-b border-border/70 hover:bg-card/60">
                  <td className="px-5 py-4">
                    <button
                      type="button"
                      onClick={() =>
                        setUserFilter(
                          userFilter?.userId === record.userId
                            ? null
                            : { userId: record.userId, label: record.userName || record.userEmail || record.userId }
                        )
                      }
                      className="text-left group"
                      title={userFilter?.userId === record.userId ? '取消该用户筛选' : '只看该用户的记录'}
                    >
                      <p className="text-foreground font-medium group-hover:text-primary transition-colors">
                        {record.userName || '-'}
                      </p>
                      <p className="text-xs text-foreground/40 group-hover:text-primary/60 transition-colors">
                        {record.userEmail}
                      </p>
                    </button>
                  </td>
                  <td className="px-5 py-4">
                    <span className="px-2 py-1 text-xs rounded-full bg-card/70 text-foreground/70 whitespace-nowrap">
                      {typeInfo.label}
                      {typeInfo.detail && (
                        <span className="text-foreground/40 ml-1.5">{typeInfo.detail}</span>
                      )}
                    </span>
                    {record.channelName && (
                      <p
                        className="text-xs text-foreground/40 mt-1 truncate max-w-[140px]"
                        title={`渠道: ${record.channelName}${record.channelId ? ` (${record.channelId})` : ''}`}
                      >
                        {record.channelName}
                      </p>
                    )}
                  </td>
                  <td className="px-5 py-4 max-w-xs">
                    <p className="text-foreground/70 truncate" title={record.prompt}>
                      {record.prompt || '-'}
                    </p>
                    {record.status === 'failed' && record.errorMessage && (
                      <p
                        className="text-xs text-red-400/80 truncate mt-1"
                        title={record.errorMessage}
                      >
                        {record.errorMessage}
                      </p>
                    )}
                  </td>
                  <td className="px-5 py-4 text-center">
                    <StatusBadge status={record.status} />
                    {needsRefundAttention(record) && (
                      <p className="text-xs text-amber-400 mt-1 whitespace-nowrap" title="生成失败但积分未退还，请人工核对">
                        未退款
                      </p>
                    )}
                  </td>
                  <td className="px-5 py-4 text-right text-red-400">-{record.cost}</td>
                  <td className="px-5 py-4 text-right text-foreground/50 text-sm whitespace-nowrap">
                    {formatDuration(record) || '-'}
                  </td>
                  <td className="px-5 py-4 text-right text-foreground/50 text-sm">
                    {formatDate(record.createdAt)}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {record.resultUrl && (
                        <a
                          href={record.resultUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-2 text-foreground/40 hover:text-foreground hover:bg-card/70 rounded-lg transition-all"
                        >
                          <Eye className="w-4 h-4" />
                        </a>
                      )}
                      <button
                        onClick={() => handleDelete(record.id)}
                        className="p-2 text-red-400/60 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {records.length === 0 && (
          <div className="text-center py-12 text-foreground/40">
            <History className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>暂无记录</p>
          </div>
        )}
      </div>

      {total > 0 && (
        <PaginationControls
          page={page}
          pageSize={GENERATIONS_PAGE_SIZE}
          total={total}
          onPageChange={(nextPage) => loadRecords(nextPage, false)}
          loading={fetching}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: 'bg-green-500/20 text-green-400 border-green-500/30',
    pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    processing: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    failed: 'bg-red-500/20 text-red-400 border-red-500/30',
    cancelled: 'bg-card/70 text-foreground/50 border-border/70',
  };
  const labels: Record<string, string> = {
    completed: '完成',
    pending: '等待',
    processing: '处理中',
    failed: '失败',
    cancelled: '取消',
  };

  return (
    <span className={cn('px-2 py-1 text-xs rounded-full border', styles[status] || styles.completed)}>
      {labels[status] || status}
    </span>
  );
}

