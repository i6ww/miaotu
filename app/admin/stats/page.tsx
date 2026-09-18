'use client';

import { useState, useEffect } from 'react';
import { BarChart3, Users, Zap, Loader2, MessageSquare, CreditCard, ReceiptText } from 'lucide-react';
import type { StatsOverview } from '@/types';
import { formatBalance } from '@/lib/utils';

function formatCurrency(cents: number): string {
  return `¥${(Math.max(0, Number(cents) || 0) / 100).toFixed(2)}`;
}

function formatDateTime(value?: number): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function dateInputToTimestamp(value: string, endOfDay = false): number | undefined {
  const normalized = value.trim().replace(/\//g, '-');
  if (!normalized) return undefined;
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(normalized)) return undefined;

  const [year, month, day] = normalized.split('-').map((part) => Number(part));
  const date = new Date(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0
  );
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return undefined;
  }

  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function paymentStatusLabel(status: string): string {
  if (status === 'succeeded') return '\u5df2\u652f\u4ed8';
  if (status === 'failed') return '\u5931\u8d25';
  return '\u5f85\u652f\u4ed8';
}

function paymentSourceLabel(order: { provider: string; paymentType: string; providerTradeNo?: string }): string {
  if (order.provider === 'manual' || order.paymentType === 'admin_balance') {
    return '\u7ba1\u7406\u5458\u52a0\u5206';
  }
  if (order.provider === 'redemption' || order.paymentType === 'redemption_code') {
    return order.providerTradeNo ? `\u5151\u6362\u7801 ${order.providerTradeNo}` : '\u5151\u6362\u7801';
  }
  return order.paymentType || '-';
}

function paymentStatusClass(status: string): string {
  if (status === 'succeeded') return 'text-emerald-300';
  if (status === 'failed') return 'text-red-300';
  return 'text-amber-300';
}

// Calculate nice Y-axis ticks
function calcYAxisTicks(max: number): number[] {
  if (max <= 0) return [0];
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  let step = magnitude;
  if (max / step < 3) step = magnitude / 2;
  if (max / step > 6) step = magnitude * 2;
  step = Math.max(1, Math.round(step));
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

export default function StatsPage() {
  const [stats, setStats] = useState<StatsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [paymentPage, setPaymentPage] = useState(1);
  const [paymentSearch, setPaymentSearch] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('all');
  const [paymentStartDate, setPaymentStartDate] = useState('');
  const [paymentEndDate, setPaymentEndDate] = useState('');

  useEffect(() => {
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, paymentPage, paymentSearch, paymentStatus, paymentStartDate, paymentEndDate]);

  const loadStats = async () => {
    try {
      if (!stats) {
        setLoading(true);
      }
      const params = new URLSearchParams({
        days: String(days),
        paymentPage: String(paymentPage),
        paymentLimit: '20',
      });
      if (paymentSearch.trim()) params.set('paymentSearch', paymentSearch.trim());
      if (paymentStatus !== 'all') params.set('paymentStatus', paymentStatus);
      const startTime = dateInputToTimestamp(paymentStartDate);
      const endTime = dateInputToTimestamp(paymentEndDate, true);
      if (startTime) params.set('paymentStartTime', String(startTime));
      if (endTime) params.set('paymentEndTime', String(endTime));

      const res = await fetch(`/api/admin/stats?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setStats(data.data);
      }
    } catch (err) {
      console.error('Failed to load stats:', err);
    } finally {
      setLoading(false);
    }
  };

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-foreground/30" />
      </div>
    );
  }

  const maxGen = Math.max(...stats.dailyStats.map(d => d.generations), 1);
  const maxUsers = Math.max(...stats.dailyStats.map(d => d.users), 1);
  const genTicks = calcYAxisTicks(maxGen);
  const userTicks = calcYAxisTicks(maxUsers);
  const genCeil = genTicks[genTicks.length - 1] || 1;
  const userCeil = userTicks[userTicks.length - 1] || 1;
  const totalTypeCount = stats.generationTypes.reduce((sum, item) => sum + item.count, 0);
  const paymentTotal = stats.paymentOrdersTotal ?? stats.recentPaymentOrders.length;
  const paymentTotalPages = Math.max(1, Math.ceil(paymentTotal / 20));
  const typeMeta: Record<string, { label: string; color: string }> = {
    'sora-video': { label: '视频', color: 'from-sky-500 to-emerald-500' },
    'sora-image': { label: 'Sora 图像', color: 'from-blue-500 to-cyan-500' },
    'gemini-image': { label: 'Gemini 图像', color: 'from-emerald-500 to-lime-500' },
    'zimage-image': { label: 'Z-Image 图像', color: 'from-amber-500 to-orange-500' },
    'gitee-image': { label: 'Gitee 图像', color: 'from-pink-500 to-rose-500' },
    chat: { label: 'Chat', color: 'from-violet-500 to-fuchsia-500' },
    'character-card': { label: '角色卡', color: 'from-indigo-500 to-blue-500' },
  };
  const typeItems = stats.generationTypes
    .map((item) => {
      const meta = typeMeta[item.type] || { label: item.type, color: 'from-slate-500 to-slate-400' };
      const percent = totalTypeCount > 0 ? Math.round((item.count / totalTypeCount) * 100) : 0;
      return { ...item, label: meta.label, color: meta.color, percent };
    })
    .sort((a, b) => b.count - a.count);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-light text-foreground">数据统计</h1>
          <p className="text-foreground/50 mt-1">系统运行数据概览</p>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="px-4 py-2 bg-card/70 border border-border/70 rounded-xl text-foreground focus:outline-none focus:border-border/70 [&>option]:bg-card/95 [&>option]:text-foreground"
        >
          <option value={7}>最近 7 天</option>
          <option value={30}>最近 30 天</option>
          <option value={90}>最近 90 天</option>
        </select>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard icon={Users} label="总用户" value={stats.totalUsers} color="blue" />
        <StatCard icon={Zap} label="总生成" value={stats.totalGenerations} color="green" />
        <StatCard icon={MessageSquare} label="聊天模型" value={stats.totalChatModels} color="violet" />
        <StatCard icon={Users} label="今日新增用户" value={stats.todayUsers} color="sky" />
        <StatCard icon={BarChart3} label="今日生成" value={stats.todayGenerations} color="orange" />
        <StatCard icon={MessageSquare} label="启用模型" value={stats.enabledChatModels} color="emerald" />
      </div>

      {/* Payment Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <PaymentStatCard
          icon={CreditCard}
          label={'\u4eca\u65e5\u5145\u503c'}
          amount={stats.paymentStats.todayAmountCents}
          points={stats.paymentStats.todayPoints}
        />
        <PaymentStatCard
          icon={CreditCard}
          label={'\u672c\u5468\u5145\u503c'}
          amount={stats.paymentStats.weekAmountCents}
          points={stats.paymentStats.weekPoints}
        />
        <PaymentStatCard
          icon={CreditCard}
          label={'\u672c\u6708\u5145\u503c'}
          amount={stats.paymentStats.monthAmountCents}
          points={stats.paymentStats.monthPoints}
        />
      </div>

      {/* Generation Chart */}
      <div className="bg-card/60 border border-border/70 rounded-2xl p-6 relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.12),transparent_55%)] pointer-events-none" />
        <div className="relative">
          <h2 className="text-lg font-semibold text-foreground mb-4">生成量趋势</h2>
        {stats.dailyStats.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-foreground/40">暂无数据</div>
        ) : (
          <div className="flex">
            {/* Y-axis */}
            <div className="flex flex-col justify-between h-48 pr-2 text-right">
              {[...genTicks].reverse().map((v) => (
                <span key={v} className="text-[10px] text-foreground/40">{v}</span>
              ))}
            </div>
            {/* Chart */}
            <div className="flex-1 flex flex-col">
              <div className="h-48 flex items-end gap-[2px] border-l border-b border-border/70 pl-1 relative">
                <div className="absolute inset-0 bg-[linear-gradient(to_top,rgba(148,163,184,0.2)_1px,transparent_1px)] bg-[length:100%_24px] pointer-events-none" />
                {stats.dailyStats.map((day, i) => (
                  <div key={day.date || i} className="flex-1 h-full flex items-end justify-center group relative min-w-[6px]">
                    <div 
                      className="w-full max-w-[20px] bg-gradient-to-t from-sky-500 to-emerald-500 rounded-t opacity-80 group-hover:opacity-100 transition-opacity"
                      style={{ height: `${(day.generations / genCeil) * 100}%`, minHeight: day.generations > 0 ? '4px' : '0' }}
                      title={`${day.date}: ${day.generations}`}
                    />
                  </div>
                ))}
              </div>
              {/* X-axis */}
              <div className="flex justify-between mt-2 pl-1">
                {stats.dailyStats.filter((_, i) => i % Math.ceil(stats.dailyStats.length / 7) === 0).map((day) => (
                  <span key={day.date} className="text-[10px] text-foreground/40">{day.date?.slice(5)}</span>
                ))}
              </div>
            </div>
          </div>
        )}
        </div>
      </div>

      {/* User Growth Chart */}
      <div className="bg-card/60 border border-border/70 rounded-2xl p-6 relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.12),transparent_55%)] pointer-events-none" />
        <div className="relative">
          <h2 className="text-lg font-semibold text-foreground mb-4">用户增长</h2>
        {stats.dailyStats.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-foreground/40">暂无数据</div>
        ) : (
          <div className="flex">
            {/* Y-axis */}
            <div className="flex flex-col justify-between h-48 pr-2 text-right">
              {[...userTicks].reverse().map((v) => (
                <span key={v} className="text-[10px] text-foreground/40">{v}</span>
              ))}
            </div>
            {/* Chart */}
            <div className="flex-1 flex flex-col">
              <div className="h-48 flex items-end gap-[2px] border-l border-b border-border/70 pl-1 relative">
                <div className="absolute inset-0 bg-[linear-gradient(to_top,rgba(148,163,184,0.2)_1px,transparent_1px)] bg-[length:100%_24px] pointer-events-none" />
                {stats.dailyStats.map((day, i) => (
                  <div key={day.date || i} className="flex-1 h-full flex items-end justify-center group relative min-w-[6px]">
                    <div 
                      className="w-full max-w-[20px] bg-gradient-to-t from-blue-500 to-cyan-500 rounded-t opacity-80 group-hover:opacity-100 transition-opacity"
                      style={{ height: `${(day.users / userCeil) * 100}%`, minHeight: day.users > 0 ? '4px' : '0' }}
                      title={`${day.date}: ${day.users}`}
                    />
                  </div>
                ))}
              </div>
              {/* X-axis */}
              <div className="flex justify-between mt-2 pl-1">
                {stats.dailyStats.filter((_, i) => i % Math.ceil(stats.dailyStats.length / 7) === 0).map((day) => (
                  <span key={day.date} className="text-[10px] text-foreground/40">{day.date?.slice(5)}</span>
                ))}
              </div>
            </div>
          </div>
        )}
        </div>
      </div>

      {/* Generation Type Distribution */}
      <div className="bg-card/60 border border-border/70 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground">生成类型分布</h2>
          <span className="text-xs text-foreground/40">最近 {days} 天</span>
        </div>
        {typeItems.length === 0 ? (
          <div className="h-40 flex items-center justify-center text-foreground/40">暂无数据</div>
        ) : (
          <div className="space-y-3">
            {typeItems.map((item) => (
              <div key={item.type} className="flex items-center gap-3">
                <div className="w-28 text-xs text-foreground/60">{item.label}</div>
                <div className="flex-1 h-2.5 rounded-full bg-card/70 border border-border/70 overflow-hidden">
                  <div
                    className={`h-full bg-gradient-to-r ${item.color}`}
                    style={{ width: `${item.percent}%` }}
                  />
                </div>
                <div className="w-12 text-right text-xs text-foreground/60">{item.count}</div>
                <div className="w-10 text-right text-xs text-foreground/40">{item.percent}%</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Payment Records Table */}
      <div className="bg-card/60 border border-border/70 rounded-2xl overflow-hidden">
        <div className="space-y-4 p-5 border-b border-border/70">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-2">
              <ReceiptText className="w-5 h-5 text-sky-300" />
              <h2 className="text-lg font-semibold text-foreground">{'\u5145\u503c\u8bb0\u5f55'}</h2>
              <span className="rounded-full border border-border/70 px-2 py-0.5 text-xs text-foreground/45">
                {`${paymentTotal} \u6761`}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-foreground/45">
              <span>{`\u7b2c ${paymentPage} / ${paymentTotalPages} \u9875`}</span>
              <button
                type="button"
                onClick={() => setPaymentPage((page) => Math.max(1, page - 1))}
                disabled={paymentPage <= 1}
                className="rounded-lg border border-border/70 px-3 py-1.5 text-foreground/70 transition hover:bg-card/80 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {'\u4e0a\u4e00\u9875'}
              </button>
              <button
                type="button"
                onClick={() => setPaymentPage((page) => Math.min(paymentTotalPages, page + 1))}
                disabled={paymentPage >= paymentTotalPages}
                className="rounded-lg border border-border/70 px-3 py-1.5 text-foreground/70 transition hover:bg-card/80 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {'\u4e0b\u4e00\u9875'}
              </button>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-[minmax(180px,1fr)_150px_150px_150px_auto]">
            <input
              value={paymentSearch}
              onChange={(event) => {
                setPaymentPage(1);
                setPaymentSearch(event.target.value);
              }}
              placeholder={'\u641c\u7d22\u7528\u6237\u3001\u90ae\u7bb1\u6216\u8ba2\u5355\u53f7'}
              className="rounded-xl border border-border/70 bg-input/70 px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-muted-foreground/60 focus:border-border focus:ring-2 focus:ring-ring/30"
            />
            <select
              value={paymentStatus}
              onChange={(event) => {
                setPaymentPage(1);
                setPaymentStatus(event.target.value);
              }}
              className="rounded-xl border border-border/70 bg-input/70 px-3 py-2 text-sm text-foreground outline-none focus:border-border"
            >
              <option value="all">{'\u5168\u90e8\u72b6\u6001'}</option>
              <option value="pending">{'\u5f85\u652f\u4ed8'}</option>
              <option value="succeeded">{'\u5df2\u652f\u4ed8'}</option>
              <option value="failed">{'\u5931\u8d25'}</option>
            </select>
            <input
              type="text"
              inputMode="numeric"
              value={paymentStartDate}
              onChange={(event) => {
                setPaymentPage(1);
                setPaymentStartDate(event.target.value);
              }}
              placeholder="YYYY-MM-DD"
              className="rounded-xl border border-border/70 bg-input/70 px-3 py-2 text-sm text-foreground outline-none focus:border-border"
            />
            <input
              type="text"
              inputMode="numeric"
              value={paymentEndDate}
              onChange={(event) => {
                setPaymentPage(1);
                setPaymentEndDate(event.target.value);
              }}
              placeholder="YYYY-MM-DD"
              className="rounded-xl border border-border/70 bg-input/70 px-3 py-2 text-sm text-foreground outline-none focus:border-border"
            />
            <button
              type="button"
              onClick={() => {
                setPaymentPage(1);
                setPaymentSearch('');
                setPaymentStatus('all');
                setPaymentStartDate('');
                setPaymentEndDate('');
              }}
              className="rounded-xl border border-border/70 px-4 py-2 text-sm text-foreground/70 transition hover:bg-card/80 hover:text-foreground"
            >
              {'\u91cd\u7f6e'}
            </button>
          </div>
        </div>
        {stats.recentPaymentOrders.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-foreground/40">
            {'\u6682\u65e0\u5145\u503c\u8bb0\u5f55'}
          </div>
        ) : (
          <div className="overflow-x-auto no-scrollbar max-h-96">
            <table className="w-full min-w-[840px]">
              <thead className="sticky top-0 bg-background/60 backdrop-blur">
                <tr className="border-b border-border/70">
                  <th className="text-left text-sm font-medium text-foreground/50 px-5 py-3">{'\u7528\u6237'}</th>
                  <th className="text-left text-sm font-medium text-foreground/50 px-5 py-3">{'\u8ba2\u5355\u53f7'}</th>
                  <th className="text-right text-sm font-medium text-foreground/50 px-5 py-3">{'\u5b9e\u4ed8\u91d1\u989d'}</th>
                  <th className="text-right text-sm font-medium text-foreground/50 px-5 py-3">{'\u5230\u8d26\u79ef\u5206'}</th>
                  <th className="text-right text-sm font-medium text-foreground/50 px-5 py-3">{'\u72b6\u6001'}</th>
                  <th className="text-right text-sm font-medium text-foreground/50 px-5 py-3">{'\u65f6\u95f4'}</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentPaymentOrders.map((order) => (
                  <tr key={order.id} className="border-b border-border/70 hover:bg-card/60">
                    <td className="px-5 py-3">
                      <div className="text-sm text-foreground">{order.userName || '-'}</div>
                      <div className="text-xs text-foreground/40">{order.userEmail || order.userId}</div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="font-mono text-xs text-foreground/60">{order.outTradeNo}</div>
                      <div className="mt-1 text-[10px] text-foreground/35">{paymentSourceLabel(order)}</div>
                    </td>
                    <td className="px-5 py-3 text-right text-foreground">
                      {order.provider === 'manual' || order.provider === 'redemption' ? '-' : formatCurrency(order.paidAmountCents)}
                    </td>
                    <td className="px-5 py-3 text-right text-emerald-300">+{formatBalance(order.points)}</td>
                    <td className={`px-5 py-3 text-right ${paymentStatusClass(order.status)}`}>
                      {paymentStatusLabel(order.status)}
                    </td>
                    <td className="px-5 py-3 text-right text-xs text-foreground/50">
                      {formatDateTime(order.paidAt || order.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Daily Details Table */}
      <div className="bg-card/60 border border-border/70 rounded-2xl overflow-hidden">
        <div className="p-5 border-b border-border/70">
          <h2 className="text-lg font-semibold text-foreground">每日明细</h2>
        </div>
        <div className="overflow-x-auto no-scrollbar max-h-96">
          <table className="w-full min-w-[640px]">
            <thead className="sticky top-0 bg-background/60 backdrop-blur">
              <tr className="border-b border-border/70">
                <th className="text-left text-sm font-medium text-foreground/50 px-5 py-3">日期</th>
                <th className="text-right text-sm font-medium text-foreground/50 px-5 py-3">新用户</th>
                <th className="text-right text-sm font-medium text-foreground/50 px-5 py-3">生成次数</th>
                <th className="text-right text-sm font-medium text-foreground/50 px-5 py-3">消耗积分</th>
              </tr>
            </thead>
            <tbody>
              {[...stats.dailyStats].reverse().map((day) => (
                <tr key={day.date} className="border-b border-border/70 hover:bg-card/60">
                  <td className="px-5 py-3 text-foreground">{day.date}</td>
                  <td className="px-5 py-3 text-right text-blue-400">{day.users}</td>
                  <td className="px-5 py-3 text-right text-sky-400">{day.generations}</td>
                  <td className="px-5 py-3 text-right text-orange-400">{formatBalance(day.points)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: { 
  icon: typeof Users; 
  label: string; 
  value: number; 
  color: 'blue' | 'green' | 'sky' | 'orange' | 'violet' | 'emerald'
}) {
  const colors = {
    blue: { bg: 'bg-blue-500/20', text: 'text-blue-400' },
    green: { bg: 'bg-green-500/20', text: 'text-green-400' },
    sky: { bg: 'bg-sky-500/20', text: 'text-sky-400' },
    orange: { bg: 'bg-orange-500/20', text: 'text-orange-400' },
    violet: { bg: 'bg-violet-500/20', text: 'text-violet-400' },
    emerald: { bg: 'bg-emerald-500/20', text: 'text-emerald-400' },
  };
  const { bg, text } = colors[color];

  return (
    <div className="bg-card/60 border border-border/70 rounded-2xl p-5 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.05),transparent_55%)] pointer-events-none" />
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 ${bg} rounded-xl flex items-center justify-center`}>
          <Icon className={`w-5 h-5 ${text}`} />
        </div>
        <div>
          <p className="text-2xl font-semibold text-foreground">{value.toLocaleString()}</p>
          <p className="text-sm text-foreground/50">{label}</p>
        </div>
      </div>
    </div>
  );
}

function PaymentStatCard({ icon: Icon, label, amount, points }: {
  icon: typeof CreditCard;
  label: string;
  amount: number;
  points: number;
}) {
  return (
    <div className="bg-card/60 border border-border/70 rounded-2xl p-5 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.12),transparent_55%)] pointer-events-none" />
      <div className="relative flex items-center gap-3">
        <div className="w-10 h-10 bg-sky-500/20 rounded-xl flex items-center justify-center">
          <Icon className="w-5 h-5 text-sky-300" />
        </div>
        <div>
          <p className="text-2xl font-semibold text-foreground">{formatCurrency(amount)}</p>
          <p className="text-sm text-foreground/50">{label}</p>
          <p className="mt-1 text-xs text-emerald-300">+{formatBalance(points)} {'\u79ef\u5206'}</p>
        </div>
      </div>
    </div>
  );
}

