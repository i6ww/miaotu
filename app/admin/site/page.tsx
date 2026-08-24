'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Coins,
  Database,
  Globe,
  LayoutGrid,
  Loader2,
  Mail,
  Plus,
  Save,
  Shield,
  Trash2,
  UserPlus,
  Zap,
} from 'lucide-react';
import type { ChatModel, ImageBucketConfig, SystemConfig } from '@/types';
import { toast } from '@/components/ui/toaster';
import { useSiteConfigRefresh } from '@/components/providers/site-config-provider';
import { findBlockedWords } from '@/lib/prompt-blocklist-core';

function bucketId() {
  return `bucket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newBucket(): ImageBucketConfig {
  return {
    id: bucketId(),
    name: '',
    provider: 'picui',
    baseUrl: '',
    apiKey: '',
    secretKey: '',
    bucketName: '',
    storageId: '',
    region: 'auto',
    publicBaseUrl: '',
    pathPrefix: '',
    forcePathStyle: true,
    enabled: true,
  };
}

type LocalMediaCleanupResult = {
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function normalizeBucketProvider(value: string): ImageBucketConfig['provider'] {
  if (value === 's3-compatible') return 's3-compatible';
  if (value === 'lsky-v2') return 'lsky-v2';
  return 'picui';
}

function Card({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card/60">
      <div className="flex items-center gap-3 border-b border-border/70 p-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-card/80">
          <Icon className="h-4 w-4 text-foreground/70" />
        </div>
        <h2 className="font-medium text-foreground">{title}</h2>
      </div>
      <div className="space-y-4 p-4">{children}</div>
    </div>
  );
}

function Switch({
  checked,
  onClick,
  color,
}: {
  checked: boolean;
  onClick: () => void;
  color: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative h-6 w-12 rounded-full transition-colors ${
        checked ? color : 'bg-card/80'
      }`}
    >
      <span
        className={`absolute top-1 h-4 w-4 rounded-full bg-foreground transition-transform ${
          checked ? 'left-7' : 'left-1'
        }`}
      />
    </button>
  );
}

export default function SiteConfigPage() {
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [chatModels, setChatModels] = useState<ChatModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [blocklistTestInput, setBlocklistTestInput] = useState('');
  const [mediaCleanup, setMediaCleanup] = useState<LocalMediaCleanupResult | null>(null);
  const [loadingMediaCleanup, setLoadingMediaCleanup] = useState(false);
  const [cleaningMedia, setCleaningMedia] = useState(false);
  const refreshSiteConfig = useSiteConfigRefresh();

  useEffect(() => {
    void loadConfig();
    void loadMediaCleanup();
  }, []);

  async function loadConfig() {
    try {
      const [settingsRes, modelsRes] = await Promise.all([
        fetch('/api/admin/settings', { cache: 'no-store' }),
        fetch('/api/chat/models?all=true', { cache: 'no-store' }),
      ]);
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setConfig(data.data);
      }
      if (modelsRes.ok) {
        const data = await modelsRes.json();
        setChatModels(data.data || []);
      }
    } finally {
      setLoading(false);
    }
  }

  async function saveConfig() {
    if (!config) return;
    setSaving(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteConfig: config.siteConfig,
          videoProxyEnabled: config.videoProxyEnabled,
          videoProxyBaseUrl: config.videoProxyBaseUrl,
          rateLimit: config.rateLimit,
          promptProcessing: config.promptProcessing,
          generationQueue: config.generationQueue,
          registerEnabled: config.registerEnabled,
          defaultBalance: config.defaultBalance,
          featureFlags: config.featureFlags,
          inviteSettings: config.inviteSettings,
          emailVerification: config.emailVerification,
          imageStorage: config.imageStorage,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '保存失败');
      setConfig(data.data || config);
      await refreshSiteConfig();
      toast({ title: '配置已保存' });
    } catch (error) {
      toast({
        title: '保存失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  }

  async function loadMediaCleanup() {
    setLoadingMediaCleanup(true);
    try {
      const res = await fetch('/api/admin/media/cleanup', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '本地媒体统计加载失败');
      setMediaCleanup(data.data || null);
    } catch (error) {
      toast({
        title: '本地媒体统计加载失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      });
    } finally {
      setLoadingMediaCleanup(false);
    }
  }

  async function cleanLocalMedia() {
    if (cleaningMedia) return;

    const orphanFiles = mediaCleanup?.orphanFiles || 0;
    const orphanBytes = mediaCleanup?.orphanBytes || 0;
    if (orphanFiles <= 0) {
      toast({ title: '没有需要清理的本地媒体文件' });
      return;
    }

    const confirmed = window.confirm(
      `确认删除 ${orphanFiles} 个未被历史记录引用的本地媒体文件，并释放约 ${formatBytes(orphanBytes)} 空间吗？此操作不可撤销。`
    );
    if (!confirmed) return;

    setCleaningMedia(true);
    try {
      const res = await fetch('/api/admin/media/cleanup', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '本地媒体清理失败');
      setMediaCleanup(data.data || null);
      toast({
        title: '本地媒体清理完成',
        description: `已删除 ${data.data?.deletedFiles || 0} 个文件，释放 ${formatBytes(data.data?.deletedBytes || 0)}`,
      });
    } catch (error) {
      toast({
        title: '本地媒体清理失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      });
    } finally {
      setCleaningMedia(false);
    }
  }

  function patch(updater: (prev: SystemConfig) => SystemConfig) {
    setConfig((prev) => (prev ? updater(prev) : prev));
  }

  const enabledBuckets = useMemo(
    () => config?.imageStorage.buckets.filter((bucket) => bucket.enabled) || [],
    [config]
  );
  const s3FieldMeta = [
    { key: 'secretKey', label: 'Secret Key', placeholder: 'S3 Secret Key' },
    { key: 'bucketName', label: 'Bucket Name', placeholder: 'Bucket name' },
    { key: 'region', label: 'Region', placeholder: 'auto / us-east-1' },
    { key: 'publicBaseUrl', label: 'Public Base URL', placeholder: 'https://cdn.example.com' },
    { key: 'pathPrefix', label: 'Path Prefix', placeholder: 'uploads/images' },
  ] as const;
  const blocklistMatches = config?.promptProcessing.blocklistEnabled
    ? findBlockedWords(blocklistTestInput, config.promptProcessing.blocklistWords)
    : [];

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-foreground/30" />
      </div>
    );
  }

  if (!config) {
    return <div className="py-12 text-center text-foreground/50">加载配置失败</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-extralight text-foreground sm:text-3xl">网站配置</h1>
          <p className="mt-1 text-sm text-foreground/50">后台统一管理全局站点与上传配置。</p>
        </div>
        <button
          type="button"
          onClick={saveConfig}
          disabled={saving}
          className="flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-background disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          保存
        </button>
      </div>

      <Card icon={Globe} title="基本信息">
        <div className="grid gap-4 sm:grid-cols-2">
          <input
            value={config.siteConfig.siteName}
            onChange={(event) =>
              patch((prev) => ({
                ...prev,
                siteConfig: { ...prev.siteConfig, siteName: event.target.value },
              }))
            }
            placeholder="网站名称"
            className="rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
          />
          <input
            value={config.siteConfig.siteTagline}
            onChange={(event) =>
              patch((prev) => ({
                ...prev,
                siteConfig: { ...prev.siteConfig, siteTagline: event.target.value },
              }))
            }
            placeholder="英文标语"
            className="rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
          />
          <input
            value={config.siteConfig.contactEmail}
            onChange={(event) =>
              patch((prev) => ({
                ...prev,
                siteConfig: { ...prev.siteConfig, contactEmail: event.target.value },
              }))
            }
            placeholder="联系邮箱"
            className="rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
          />
          <input
            value={config.siteConfig.copyright}
            onChange={(event) =>
              patch((prev) => ({
                ...prev,
                siteConfig: { ...prev.siteConfig, copyright: event.target.value },
              }))
            }
            placeholder="版权信息"
            className="rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
          />
        </div>
        <input
          value={config.siteConfig.siteDescription}
          onChange={(event) =>
            patch((prev) => ({
              ...prev,
              siteConfig: { ...prev.siteConfig, siteDescription: event.target.value },
            }))
          }
          placeholder="中文描述"
          className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
        />
        <textarea
          value={config.siteConfig.siteSubDescription}
          onChange={(event) =>
            patch((prev) => ({
              ...prev,
              siteConfig: { ...prev.siteConfig, siteSubDescription: event.target.value },
            }))
          }
          rows={3}
          placeholder="中文副描述"
          className="w-full resize-none rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
        />
        <input
          value={config.siteConfig.poweredBy}
          onChange={(event) =>
            patch((prev) => ({
              ...prev,
              siteConfig: { ...prev.siteConfig, poweredBy: event.target.value },
            }))
          }
          placeholder="技术支持信息"
          className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
        />
        <input
          value={config.siteConfig.pointsPurchaseUrl}
          onChange={(event) =>
            patch((prev) => ({
              ...prev,
              siteConfig: { ...prev.siteConfig, pointsPurchaseUrl: event.target.value },
            }))
          }
          placeholder="积分购买链接，例如 https://example.com/pricing"
          className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
        />
      </Card>

      <Card icon={LayoutGrid} title="功能与邀请码">
        <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
          <div>
            <p className="text-sm text-foreground">广场功能</p>
            <p className="mt-1 text-xs text-foreground/30">关闭后前端入口与接口都会同时禁用。</p>
          </div>
          <Switch
            checked={config.featureFlags.squareEnabled}
            onClick={() =>
              patch((prev) => ({
                ...prev,
                featureFlags: {
                  ...prev.featureFlags,
                  squareEnabled: !prev.featureFlags.squareEnabled,
                },
              }))
            }
            color="bg-sky-500"
          />
        </div>

        <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
          <div>
            <p className="text-sm text-foreground">抽卡模式</p>
            <p className="mt-1 text-xs text-foreground/30">关闭后图片与视频创作页不再显示连抽入口。</p>
          </div>
          <Switch
            checked={config.featureFlags.gachaEnabled}
            onClick={() =>
              patch((prev) => ({
                ...prev,
                featureFlags: {
                  ...prev.featureFlags,
                  gachaEnabled: !prev.featureFlags.gachaEnabled,
                },
              }))
            }
            color="bg-amber-500"
          />
        </div>

        <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
          <div>
            <p className="text-sm text-foreground">角色卡生成</p>
            <p className="mt-1 text-xs text-foreground/30">关闭后隐藏导航入口，并拒绝新的角色卡生成请求。</p>
          </div>
          <Switch
            checked={config.featureFlags.characterCardEnabled}
            onClick={() =>
              patch((prev) => ({
                ...prev,
                featureFlags: {
                  ...prev.featureFlags,
                  characterCardEnabled: !prev.featureFlags.characterCardEnabled,
                },
              }))
            }
            color="bg-indigo-500"
          />
        </div>

        <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
          <div>
            <p className="text-sm text-foreground">启用邀请码</p>
            <p className="mt-1 text-xs text-foreground/30">关闭后用户页不再显示邀请码入口。</p>
          </div>
          <Switch
            checked={config.inviteSettings.enabled}
            onClick={() =>
              patch((prev) => ({
                ...prev,
                inviteSettings: {
                  ...prev.inviteSettings,
                  enabled: !prev.inviteSettings.enabled,
                },
              }))
            }
            color="bg-emerald-500"
          />
        </div>

        <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
          <div>
            <p className="text-sm text-foreground">邀请奖励</p>
            <p className="mt-1 text-xs text-foreground/30">关闭后仍绑定邀请关系，但不发积分。</p>
          </div>
          <Switch
            checked={config.inviteSettings.rewardEnabled}
            onClick={() =>
              patch((prev) => ({
                ...prev,
                inviteSettings: {
                  ...prev.inviteSettings,
                  rewardEnabled: !prev.inviteSettings.rewardEnabled,
                },
              }))
            }
            color="bg-amber-500"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 rounded-lg border border-border/70 bg-card/60 p-4">
            <p className="text-sm text-foreground/60">被邀请人奖励</p>
            <div className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-amber-400" />
              <input
                type="number"
                min="0"
                value={config.inviteSettings.inviteeBonusPoints}
                disabled={!config.inviteSettings.rewardEnabled}
                onChange={(event) =>
                  patch((prev) => ({
                    ...prev,
                    inviteSettings: {
                      ...prev.inviteSettings,
                      inviteeBonusPoints: Math.max(0, Number(event.target.value) || 0),
                    },
                  }))
                }
                className="w-full bg-transparent text-foreground focus:outline-none disabled:opacity-50"
              />
              <span className="text-sm text-foreground/40">积分</span>
            </div>
          </div>
          <div className="space-y-2 rounded-lg border border-border/70 bg-card/60 p-4">
            <p className="text-sm text-foreground/60">邀请人奖励</p>
            <div className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-amber-400" />
              <input
                type="number"
                min="0"
                value={config.inviteSettings.inviterBonusPoints}
                disabled={!config.inviteSettings.rewardEnabled}
                onChange={(event) =>
                  patch((prev) => ({
                    ...prev,
                    inviteSettings: {
                      ...prev.inviteSettings,
                      inviterBonusPoints: Math.max(0, Number(event.target.value) || 0),
                    },
                  }))
                }
                className="w-full bg-transparent text-foreground focus:outline-none disabled:opacity-50"
              />
              <span className="text-sm text-foreground/40">积分</span>
            </div>
          </div>
        </div>
      </Card>
      <Card icon={Mail} title="邮箱验证">
        <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
          <div>
            <p className="text-sm text-foreground">注册邮箱验证码</p>
            <p className="mt-1 text-xs text-foreground/30">开启后，新用户注册时必须先接收并填写邮箱验证码。</p>
          </div>
          <Switch
            checked={config.emailVerification.enabled}
            onClick={() =>
              patch((prev) => ({
                ...prev,
                emailVerification: {
                  ...prev.emailVerification,
                  enabled: !prev.emailVerification.enabled,
                },
              }))
            }
            color="bg-emerald-500"
          />
        </div>

        <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
          <div>
            <p className="text-sm text-foreground">启用邮箱域名白名单</p>
            <p className="mt-1 text-xs text-foreground/30">只允许白名单内的邮箱域名注册。</p>
          </div>
          <Switch
            checked={config.emailVerification.domainWhitelistEnabled}
            onClick={() =>
              patch((prev) => ({
                ...prev,
                emailVerification: {
                  ...prev.emailVerification,
                  domainWhitelistEnabled: !prev.emailVerification.domainWhitelistEnabled,
                },
              }))
            }
            color="bg-sky-500"
          />
        </div>

        <textarea
          value={config.emailVerification.allowedDomains}
          onChange={(event) =>
            patch((prev) => ({
              ...prev,
              emailVerification: {
                ...prev.emailVerification,
                allowedDomains: event.target.value,
              },
            }))
          }
          placeholder="gmail.com, outlook.com, yahoo.com"
          rows={3}
          className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
        />

        <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
          <div>
            <p className="text-sm text-foreground">启用邮箱别名限制</p>
            <p className="mt-1 text-xs text-foreground/30">禁止使用带 + 号的邮箱别名注册。</p>
          </div>
          <Switch
            checked={config.emailVerification.aliasRestrictionEnabled}
            onClick={() =>
              patch((prev) => ({
                ...prev,
                emailVerification: {
                  ...prev.emailVerification,
                  aliasRestrictionEnabled: !prev.emailVerification.aliasRestrictionEnabled,
                },
              }))
            }
            color="bg-amber-500"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm text-foreground/50">SMTP 服务器</label>
            <input
              value={config.emailVerification.smtp.host}
              onChange={(event) =>
                patch((prev) => ({
                  ...prev,
                  emailVerification: {
                    ...prev.emailVerification,
                    smtp: {
                      ...prev.emailVerification.smtp,
                      host: event.target.value,
                    },
                  },
                }))
              }
              placeholder="smtp.gmail.com"
              className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-foreground/50">SMTP 端口</label>
            <input
              type="number"
              min="1"
              value={config.emailVerification.smtp.port}
              onChange={(event) =>
                patch((prev) => ({
                  ...prev,
                  emailVerification: {
                    ...prev.emailVerification,
                    smtp: {
                      ...prev.emailVerification.smtp,
                      port: Math.max(1, Number(event.target.value) || 1),
                    },
                  },
                }))
              }
              className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-foreground/50">SMTP 账号</label>
            <input
              value={config.emailVerification.smtp.username}
              onChange={(event) =>
                patch((prev) => ({
                  ...prev,
                  emailVerification: {
                    ...prev.emailVerification,
                    smtp: {
                      ...prev.emailVerification.smtp,
                      username: event.target.value,
                    },
                  },
                }))
              }
              placeholder="account@gmail.com"
              className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-foreground/50">发件邮箱</label>
            <input
              value={config.emailVerification.smtp.fromEmail}
              onChange={(event) =>
                patch((prev) => ({
                  ...prev,
                  emailVerification: {
                    ...prev.emailVerification,
                    smtp: {
                      ...prev.emailVerification.smtp,
                      fromEmail: event.target.value,
                    },
                  },
                }))
              }
              placeholder="account@gmail.com"
              className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <label className="text-sm text-foreground/50">授权码 / 应用密码</label>
            <input
              type="password"
              value={config.emailVerification.smtp.password}
              onChange={(event) =>
                patch((prev) => ({
                  ...prev,
                  emailVerification: {
                    ...prev.emailVerification,
                    smtp: {
                      ...prev.emailVerification.smtp,
                      password: event.target.value,
                    },
                  },
                }))
              }
              placeholder="Gmail app password"
              className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-foreground/50">验证码有效期（分钟）</label>
            <input
              type="number"
              min="1"
              value={config.emailVerification.codeExpiresMinutes}
              onChange={(event) =>
                patch((prev) => ({
                  ...prev,
                  emailVerification: {
                    ...prev.emailVerification,
                    codeExpiresMinutes: Math.max(1, Number(event.target.value) || 1),
                  },
                }))
              }
              className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
              <div>
                <p className="text-sm text-foreground">SSL</p>
              </div>
              <Switch
                checked={config.emailVerification.smtp.secure}
                onClick={() =>
                  patch((prev) => ({
                    ...prev,
                    emailVerification: {
                      ...prev.emailVerification,
                      smtp: {
                        ...prev.emailVerification.smtp,
                        secure: !prev.emailVerification.smtp.secure,
                      },
                    },
                  }))
                }
                color="bg-emerald-500"
              />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
              <div>
                <p className="text-sm text-foreground">AUTH LOGIN</p>
              </div>
              <Switch
                checked={config.emailVerification.smtp.authLogin}
                onClick={() =>
                  patch((prev) => ({
                    ...prev,
                    emailVerification: {
                      ...prev.emailVerification,
                      smtp: {
                        ...prev.emailVerification.smtp,
                        authLogin: !prev.emailVerification.smtp.authLogin,
                      },
                    },
                  }))
                }
                color="bg-indigo-500"
              />
            </div>
          </div>
        </div>
      </Card>

      <Card icon={Database} title="图床桶">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <select
            value={config.imageStorage.defaultBucketId || ''}
            onChange={(event) =>
              patch((prev) => ({
                ...prev,
                imageStorage: { ...prev.imageStorage, defaultBucketId: event.target.value },
              }))
            }
            className="rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
          >
            <option value="">未选择默认桶</option>
            {enabledBuckets.map((bucket) => (
              <option key={bucket.id} value={bucket.id}>
                {bucket.name || bucket.id}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() =>
              patch((prev) => ({
                ...prev,
                imageStorage: {
                  ...prev.imageStorage,
                  buckets: [...prev.imageStorage.buckets, newBucket()],
                },
              }))
            }
            className="inline-flex items-center gap-2 rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground"
          >
            <Plus className="h-4 w-4" />
            新增桶
          </button>
        </div>

        {config.imageStorage.buckets.map((bucket) => (
          <div key={bucket.id} className="space-y-3 rounded-xl border border-border/70 bg-card/50 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="grid flex-1 gap-3 sm:grid-cols-2">
                <input
                  value={bucket.name}
                  onChange={(event) =>
                    patch((prev) => ({
                      ...prev,
                      imageStorage: {
                        ...prev.imageStorage,
                        buckets: prev.imageStorage.buckets.map((item) =>
                          item.id === bucket.id ? { ...item, name: event.target.value } : item
                        ),
                      },
                    }))
                  }
                  placeholder="桶名称"
                  className="rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
                />
                <select
                  value={bucket.provider}
                  onChange={(event) =>
                    patch((prev) => ({
                      ...prev,
                      imageStorage: {
                        ...prev.imageStorage,
                        buckets: prev.imageStorage.buckets.map((item) =>
                          item.id === bucket.id
                            ? {
                                ...item,
                                provider: normalizeBucketProvider(event.target.value),
                              }
                            : item
                        ),
                      },
                    }))
                  }
                  className="rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
                >
                  <option value="picui">PicUI</option>
                  <option value="lsky-v2">Lsky v2</option>
                  <option value="s3-compatible">S3 兼容</option>
                </select>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  checked={bucket.enabled}
                  onClick={() =>
                    patch((prev) => {
                      const buckets = prev.imageStorage.buckets.map((item) =>
                        item.id === bucket.id ? { ...item, enabled: !item.enabled } : item
                      );
                      const defaultBucketId =
                        buckets.find((item) => item.id === prev.imageStorage.defaultBucketId && item.enabled)?.id ||
                        buckets.find((item) => item.enabled)?.id ||
                        '';
                      return { ...prev, imageStorage: { ...prev.imageStorage, buckets, defaultBucketId } };
                    })
                  }
                  color="bg-purple-500"
                />
                <button
                  type="button"
                  onClick={() =>
                    patch((prev) => {
                      const buckets = prev.imageStorage.buckets.filter((item) => item.id !== bucket.id);
                      const defaultBucketId =
                        prev.imageStorage.defaultBucketId === bucket.id
                          ? buckets.find((item) => item.enabled)?.id || ''
                          : prev.imageStorage.defaultBucketId;
                      return { ...prev, imageStorage: { ...prev.imageStorage, buckets, defaultBucketId } };
                    })
                  }
                  className="inline-flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-red-300"
                >
                  <Trash2 className="h-4 w-4" />
                  删除
                </button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <input
                value={bucket.baseUrl}
                onChange={(event) =>
                  patch((prev) => ({
                    ...prev,
                    imageStorage: {
                      ...prev.imageStorage,
                      buckets: prev.imageStorage.buckets.map((item) =>
                        item.id === bucket.id ? { ...item, baseUrl: event.target.value } : item
                      ),
                    },
                  }))
                }
                placeholder={bucket.provider === 's3-compatible' ? 'Endpoint 地址' : '接口地址'}
                className="rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
              />
              <input
                value={bucket.apiKey}
                onChange={(event) =>
                  patch((prev) => ({
                    ...prev,
                    imageStorage: {
                      ...prev.imageStorage,
                      buckets: prev.imageStorage.buckets.map((item) =>
                        item.id === bucket.id ? { ...item, apiKey: event.target.value } : item
                      ),
                    },
                  }))
                }
                placeholder={bucket.provider === 's3-compatible' ? 'Access Key' : 'API Key'}
                className="rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
              />
            </div>

            {bucket.provider === 'lsky-v2' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  value={bucket.storageId || ''}
                  onChange={(event) =>
                    patch((prev) => ({
                      ...prev,
                      imageStorage: {
                        ...prev.imageStorage,
                        buckets: prev.imageStorage.buckets.map((item) =>
                          item.id === bucket.id ? { ...item, storageId: event.target.value } : item
                        ),
                      },
                    }))
                  }
                  placeholder="Storage ID"
                  className="rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
                />
              </div>
            )}

            {bucket.provider === 's3-compatible' && (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {s3FieldMeta.map((field) => (
                    <div key={field.key} className="space-y-2">
                      <label className="text-sm text-foreground/60">{field.label}</label>
                      <input
                        value={bucket[field.key] || ''}
                        onChange={(event) =>
                          patch((prev) => ({
                            ...prev,
                            imageStorage: {
                              ...prev.imageStorage,
                              buckets: prev.imageStorage.buckets.map((item) =>
                                item.id === bucket.id ? { ...item, [field.key]: event.target.value } : item
                              ),
                            },
                          }))
                        }
                        placeholder={field.placeholder}
                        className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
                      />
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/60 p-4">
                  <div>
                    <p className="text-sm text-foreground">Force Path Style</p>
                    <p className="mt-1 text-xs text-foreground/30">
                      MinIO、R2 等兼容服务通常建议开启；如果使用虚拟主机风格可关闭。
                    </p>
                  </div>
                  <Switch
                    checked={bucket.forcePathStyle !== false}
                    onClick={() =>
                      patch((prev) => ({
                        ...prev,
                        imageStorage: {
                          ...prev.imageStorage,
                          buckets: prev.imageStorage.buckets.map((item) =>
                            item.id === bucket.id
                              ? { ...item, forcePathStyle: item.forcePathStyle === false }
                              : item
                          ),
                        },
                      }))
                    }
                    color="bg-sky-500"
                  />
                </div>
              </div>
            )}
          </div>
        ))}
      </Card>

      <Card icon={Database} title="Local Media Cleanup">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-border/70 bg-card/50 p-3">
            <p className="text-xs text-foreground/45">Local files</p>
            <p className="mt-1 text-lg font-medium text-foreground">
              {mediaCleanup ? mediaCleanup.totalFiles : '-'}
            </p>
          </div>
          <div className="rounded-lg border border-border/70 bg-card/50 p-3">
            <p className="text-xs text-foreground/45">Referenced files</p>
            <p className="mt-1 text-lg font-medium text-foreground">
              {mediaCleanup ? mediaCleanup.referencedFiles : '-'}
            </p>
          </div>
          <div className="rounded-lg border border-border/70 bg-card/50 p-3">
            <p className="text-xs text-foreground/45">Orphan files</p>
            <p className="mt-1 text-lg font-medium text-amber-300">
              {mediaCleanup ? mediaCleanup.orphanFiles : '-'}
            </p>
          </div>
          <div className="rounded-lg border border-border/70 bg-card/50 p-3">
            <p className="text-xs text-foreground/45">Reclaimable space</p>
            <p className="mt-1 text-lg font-medium text-emerald-300">
              {mediaCleanup ? formatBytes(mediaCleanup.orphanBytes) : '-'}
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-border/70 bg-card/50 p-3 text-xs text-foreground/45">
          <p>Media directory: {mediaCleanup?.mediaDir || '/app/data/media'}</p>
          {mediaCleanup && mediaCleanup.failed.length > 0 && (
            <p className="mt-1 text-red-300">
              {mediaCleanup.failed.length} files failed to read or delete. Check server logs.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-foreground/40">
            Only local files that are not referenced by generation history are deleted. Files still referenced by file: records are kept.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void loadMediaCleanup()}
              disabled={loadingMediaCleanup || cleaningMedia}
              className="inline-flex items-center gap-2 rounded-lg border border-border/70 bg-card/60 px-4 py-2 text-sm text-foreground disabled:opacity-50"
            >
              {loadingMediaCleanup ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
              Refresh stats
            </button>
            <button
              type="button"
              onClick={() => void cleanLocalMedia()}
              disabled={cleaningMedia || loadingMediaCleanup || !mediaCleanup || mediaCleanup.orphanFiles === 0}
              className="inline-flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2 text-sm text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cleaningMedia ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Clean orphan files
            </button>
          </div>
        </div>
      </Card>


      <Card icon={Shield} title="提示词处理">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
            <div>
              <p className="text-sm text-foreground">启用净化</p>
              <p className="mt-1 text-xs text-foreground/30">先重写提示词。</p>
            </div>
            <Switch
              checked={config.promptProcessing.filterEnabled}
              onClick={() =>
                patch((prev) => ({
                  ...prev,
                  promptProcessing: {
                    ...prev.promptProcessing,
                    filterEnabled: !prev.promptProcessing.filterEnabled,
                  },
                }))
              }
              color="bg-orange-500"
            />
          </div>
          <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
            <div>
              <p className="text-sm text-foreground">启用翻译</p>
              <p className="mt-1 text-xs text-foreground/30">翻译为稳定英文。</p>
            </div>
            <Switch
              checked={config.promptProcessing.translateEnabled}
              onClick={() =>
                patch((prev) => ({
                  ...prev,
                  promptProcessing: {
                    ...prev.promptProcessing,
                    translateEnabled: !prev.promptProcessing.translateEnabled,
                  },
                }))
              }
              color="bg-sky-500"
            />
          </div>
        </div>
        <select
          value={config.promptProcessing.filterModelId}
          onChange={(event) =>
            patch((prev) => ({
              ...prev,
              promptProcessing: { ...prev.promptProcessing, filterModelId: event.target.value },
            }))
          }
          className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
        >
          <option value="">请选择净化模型</option>
          {chatModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} ({model.modelId})
            </option>
          ))}
        </select>
        <textarea
          value={config.promptProcessing.filterPrompt}
          onChange={(event) =>
            patch((prev) => ({
              ...prev,
              promptProcessing: { ...prev.promptProcessing, filterPrompt: event.target.value },
            }))
          }
          rows={3}
          placeholder="净化指令"
          className="w-full resize-none rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
        />
        <select
          value={config.promptProcessing.translateModelId}
          onChange={(event) =>
            patch((prev) => ({
              ...prev,
              promptProcessing: { ...prev.promptProcessing, translateModelId: event.target.value },
            }))
          }
          className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
        >
          <option value="">请选择翻译模型</option>
          {chatModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} ({model.modelId})
            </option>
          ))}
        </select>
        <textarea
          value={config.promptProcessing.translatePrompt}
          onChange={(event) =>
            patch((prev) => ({
              ...prev,
              promptProcessing: { ...prev.promptProcessing, translatePrompt: event.target.value },
            }))
          }
          rows={3}
          placeholder="翻译指令"
          className="w-full resize-none rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
        />
        <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
          <div>
            <p className="text-sm text-foreground">启用黑名单</p>
            <p className="mt-1 text-xs text-foreground/30">命中规则后直接拦截。</p>
          </div>
          <Switch
            checked={config.promptProcessing.blocklistEnabled}
            onClick={() =>
              patch((prev) => ({
                ...prev,
                promptProcessing: {
                  ...prev.promptProcessing,
                  blocklistEnabled: !prev.promptProcessing.blocklistEnabled,
                },
              }))
            }
            color="bg-red-500"
          />
        </div>
        <textarea
          value={config.promptProcessing.blocklistWords}
          onChange={(event) =>
            patch((prev) => ({
              ...prev,
              promptProcessing: { ...prev.promptProcessing, blocklistWords: event.target.value },
            }))
          }
          rows={5}
          placeholder="黑名单规则，每行一条"
          className="w-full resize-none rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
        />
        <textarea
          value={blocklistTestInput}
          onChange={(event) => setBlocklistTestInput(event.target.value)}
          rows={3}
          placeholder="黑名单测试器"
          className="w-full resize-none rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
        />
        <p className={`text-xs ${blocklistMatches.length > 0 ? 'text-red-400' : 'text-foreground/40'}`}>
          {config.promptProcessing.blocklistEnabled
            ? blocklistMatches.length > 0
              ? `命中规则：${blocklistMatches.join('，')}`
              : '未命中任何规则'
            : '黑名单当前未启用'}
        </p>
      </Card>
      <Card icon={Zap} title="运行参数">
        <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
          <div>
            <p className="text-sm text-foreground">视频加速</p>
            <p className="mt-1 text-xs text-foreground/30">替换视频域名到你的代理地址。</p>
          </div>
          <Switch
            checked={config.videoProxyEnabled}
            onClick={() =>
              patch((prev) => ({
                ...prev,
                videoProxyEnabled: !prev.videoProxyEnabled,
              }))
            }
            color="bg-purple-500"
          />
        </div>
        <input
          value={config.videoProxyBaseUrl}
          onChange={(event) =>
            patch((prev) => ({
              ...prev,
              videoProxyBaseUrl: event.target.value,
            }))
          }
          placeholder="视频加速域名"
          className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
        />
        <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
          <div>
            <p className="text-sm text-foreground">生成队列</p>
            <p className="mt-1 text-xs text-foreground/30">控制图片生成任务进入上游渠道前的并发数量。</p>
          </div>
          <Switch
            checked={config.generationQueue.enabled}
            onClick={() =>
              patch((prev) => ({
                ...prev,
                generationQueue: {
                  ...prev.generationQueue,
                  enabled: !prev.generationQueue.enabled,
                },
              }))
            }
            color="bg-emerald-500"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-2">
            <label className="text-sm text-foreground/50">全局图片并发</label>
            <input
              type="number"
              min="1"
              value={config.generationQueue.imageConcurrency}
              onChange={(event) =>
                patch((prev) => ({
                  ...prev,
                  generationQueue: {
                    ...prev.generationQueue,
                    imageConcurrency: Math.max(1, Number(event.target.value) || 1),
                  },
                }))
              }
              className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-foreground/50">单渠道并发</label>
            <input
              type="number"
              min="1"
              value={config.generationQueue.channelConcurrency}
              onChange={(event) =>
                patch((prev) => ({
                  ...prev,
                  generationQueue: {
                    ...prev.generationQueue,
                    channelConcurrency: Math.max(1, Number(event.target.value) || 1),
                  },
                }))
              }
              className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-foreground/50">锁超时秒数</label>
            <input
              type="number"
              min="30"
              value={config.generationQueue.lockTimeoutSeconds}
              onChange={(event) =>
                patch((prev) => ({
                  ...prev,
                  generationQueue: {
                    ...prev.generationQueue,
                    lockTimeoutSeconds: Math.max(30, Number(event.target.value) || 30),
                  },
                }))
              }
              className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-foreground/50">最大尝试次数</label>
            <input
              type="number"
              min="1"
              value={config.generationQueue.maxAttempts}
              onChange={(event) =>
                patch((prev) => ({
                  ...prev,
                  generationQueue: {
                    ...prev.generationQueue,
                    maxAttempts: Math.max(1, Number(event.target.value) || 1),
                  },
                }))
              }
              className="w-full rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm text-foreground/50">图片请求上限 / 窗口秒数</label>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                min="1"
                value={config.rateLimit.imageMaxRequests}
                onChange={(event) =>
                  patch((prev) => ({
                    ...prev,
                    rateLimit: {
                      ...prev.rateLimit,
                      imageMaxRequests: Math.max(1, Number(event.target.value) || 1),
                    },
                  }))
                }
                className="rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
              />
              <input
                type="number"
                min="1"
                value={config.rateLimit.imageWindowSeconds}
                onChange={(event) =>
                  patch((prev) => ({
                    ...prev,
                    rateLimit: {
                      ...prev.rateLimit,
                      imageWindowSeconds: Math.max(1, Number(event.target.value) || 1),
                    },
                  }))
                }
                className="rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm text-foreground/50">视频请求上限 / 窗口秒数</label>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                min="1"
                value={config.rateLimit.videoMaxRequests}
                onChange={(event) =>
                  patch((prev) => ({
                    ...prev,
                    rateLimit: {
                      ...prev.rateLimit,
                      videoMaxRequests: Math.max(1, Number(event.target.value) || 1),
                    },
                  }))
                }
                className="rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
              />
              <input
                type="number"
                min="1"
                value={config.rateLimit.videoWindowSeconds}
                onChange={(event) =>
                  patch((prev) => ({
                    ...prev,
                    rateLimit: {
                      ...prev.rateLimit,
                      videoWindowSeconds: Math.max(1, Number(event.target.value) || 1),
                    },
                  }))
                }
                className="rounded-lg border border-border/70 bg-card/60 px-4 py-3 text-foreground focus:outline-none"
              />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between rounded-xl border border-border/70 bg-card/50 p-4">
          <div>
            <p className="text-sm text-foreground">开放注册</p>
            <p className="mt-1 text-xs text-foreground/30">控制新用户是否可以注册。</p>
          </div>
          <Switch
            checked={config.registerEnabled}
            onClick={() =>
              patch((prev) => ({
                ...prev,
                registerEnabled: !prev.registerEnabled,
              }))
            }
            color="bg-green-500"
          />
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-card/60 px-4 py-3">
          <Coins className="h-4 w-4 text-yellow-400" />
          <input
            type="number"
            min="0"
            value={config.defaultBalance}
            onChange={(event) =>
              patch((prev) => ({
                ...prev,
                defaultBalance: Math.max(0, Number(event.target.value) || 0),
              }))
            }
            className="w-full bg-transparent text-foreground focus:outline-none"
          />
          <span className="text-sm text-foreground/50">注册送积分</span>
        </div>
      </Card>
    </div>
  );
}
