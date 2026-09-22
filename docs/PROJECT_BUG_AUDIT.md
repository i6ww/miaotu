# 项目 Bug 审计报告

> **审计日期**: 2026-09-22
> **审计范围**: `f:\sanhub` 全量源代码（Next.js 13+ App Router + TypeScript + MySQL/better-sqlite3）
> **审计方法**: LSP 语义分析 + 精确 ripgrep + 直接阅读高风险文件 + code-explorer 子代理广度扫描
> **修复优先级**: Critical > High > Medium > Low
> **约定**: 严重度判定依据 = 影响范围（资金/安全/数据完整性/可用性）× 可利用门槛

---

## 目录

- [Executive Summary](#executive-summary)
- [Critical (1)](#critical)
- [High (10)](#high)
- [Medium (10)](#medium)
- [Low (13)](#low)
- [跨切片建议](#跨切片建议)
- [已验证 OK 的点](#已验证-ok-的点)
- [修复路线图](#修复路线图)

---

## Executive Summary

| 严重度 | 数量 | 主要影响类别 |
| --- | --- | --- |
| Critical | 1 | 直接资金损失（重复白嫖） |
| High | 10 | 资金损失、账号接管、SSRF、进程级 DoS、代码设计错误 |
| Medium | 10 | 资金边缘损失、隐私泄漏、单点 500、功能失效 |
| Low | 13 | 鲁棒性、日志卫生、API 契约 |
| **合计** | **34** | — |

**资金类问题（5 项）**：C1, H1, H4, H5, M8 → 建议 1-2 个 sprint 内全部处理。

**安全类问题（6 项）**：H2, H3, H4, H7, M3, M4 → 涉及账号接管 / SSRF / 暴力破解，需尽快处理。

**可用性问题（7 项）**：H3, H6, H7, H9, H10, M2, M3 → 单个请求可拖垮进程或全部任务。

**设计 / 契约问题（6 项）**：M6, M7, M8, L1, L6, L13 → 代码没崩但行为与预期不符。

---

## Critical

### C1 · `app/api/user/tasks/[id]/route.ts:37-48` + `lib/generation-queue.ts:388-398` + `app/api/generate/sora/route.ts:314-328` · 取消任务后后台完成可白嫖

**现象**：

```ts
// app/api/user/tasks/[id]/route.ts:37-43
await updateGeneration(params.id, { status: 'cancelled' });
try {
  await refundGenerationBalance(generation.id, generation.userId, generation.cost);
} catch (refundErr) {
  console.error('[API] Failed to refund balance:', refundErr);
}

// generation-queue.ts:388-398（以及 sora/route.ts 完成分支）
await updateGeneration(generationId, {
  status: 'completed',
  resultUrl: savedMedia.url,
  errorMessage: '',
  params: { ...payload.generationParams, progress: 100 },
});
// ↑ 不检查当前 status；不检查已 refund
```

**影响**：
用户提交生成任务 → 进度 ≥ 90% 时调 `DELETE /api/user/tasks/{id}` → 立即 `status='cancelled'` + 全额退款 → 几秒后后台任务真正完成，**无条件**写入 `status='completed' + resultUrl`，把 `cancelled` 覆盖掉。**可复现、零成本、无门槛**的资金漏洞。

**根因**：
- `updateGeneration` 与 `completeGenerationJob` 写入终态时**不带状态条件**；
- 取消路径没有让 worker 感知到并停掉，只改 DB 标记；
- 退款路径与"任务真正完成"两条写无任何同步。

**修复方案**：
1. 所有"终态写入"改为条件更新：
   ```sql
   UPDATE generations
   SET status = 'completed', result_url = ?, ...
   WHERE id = ?
     AND status NOT IN ('cancelled', 'failed', 'refunded')
     AND balance_refunded = 0
   ```
   受影响行数为 0 时丢弃结果，不覆盖状态、不再次落库。
2. 或在 `updateGeneration` 加防御：入参 `status === 'completed' | 'failed'` 且当前 `status === 'cancelled' | 'refunded'` 时直接拒绝。
3. 取消任务时同步向 worker 投递"软取消"信号（内存态即可，单实例），worker 在下一段落地丢弃。

**验证方式**：
提交生成任务，progress ≥ 90 时 DELETE，等任务结束，断言：
- 记录最终保持 `cancelled` 且无 `resultUrl`；
- `balance_refunded = 1` 不会被回滚；
- 用户/管理员查询看不到任何完成产物。

---

## High

### H1 · `lib/db.ts:1484-1517` · 支付回调"标成功"与"加余额"不在同一事务

**现象**：

```ts
const [result] = await db.execute(
  `UPDATE payment_orders
   SET status = 'succeeded', provider_trade_no = ?, raw_notify = ?, paid_at = ?, updated_at = ?
   WHERE out_trade_no = ? AND status = 'pending'`,
  [...]
);
const credited = getAffectedRows(result) > 0;
if (credited) {
  await updateUserBalance(order.userId, order.points, 'strict'); // 抛错 → 订单已是 succeeded
}
```

**影响**：
`updateUserBalance` 抛错时订单已 `succeeded`，`handleEasyPayCallback` 返回 500 → 易支付重试回调 → `status='pending'` 条件不再命中 → `credited=false` → 仍是 200 success。**用户付了钱永远拿不到积分，只能人工补单。**

**根因**：两条写不在同一事务；重试路径对"已成功未入账"状态无补偿逻辑。

**修复方案**：
1. 用事务包裹两条 UPDATE（MySQL `START TRANSACTION` / better-sqlite3 `db.transaction`）。
2. 或改为先 `UPDATE users SET balance = balance + ? WHERE id = ?`，再条件更新订单；失败时回滚余额。
3. 在 `credited=false` 时检测"已 succeeded 但疑似未入账"并告警（健康检查）。

**验证方式**：mock `updateUserBalance` 抛错，调用 `completePaymentOrder` 后再次调用，断言第二次调用能完成入账（修复后）且余额只加一次。

---

### H2 · `app/api/user/password/route.ts:14-31` · 修改密码可跳过"原密码"校验

**现象**：

```ts
const { currentPassword, newPassword } = await request.json();
if (!newPassword || newPassword.length < 6) return ...400;
if (currentPassword) {                          // ← 只有提供了才验证
  const valid = await verifyPassword(user.email, currentPassword);
  if (!valid) return ...400;
}
await updateUser(session.user.id, { password: newPassword });
```

**影响**：
任何持有有效会话的场景（XSS 窃取 fetch 能力、共用电脑未退出、被盗 session cookie）可直接重置密码完成**账号接管**。"当前密码"这道防线完全可跳过。

**根因**：把验证逻辑放在条件分支里而非强制要求。

**修复方案**：强制 `if (!currentPassword) return 400`，始终校验后再更新。

**验证方式**：登录后 `POST /api/user/password` body 仅 `{"newPassword":"xxxxxx"}`，修复前返回 success，修复后应 400。

---

### H3 · `lib/image-generator.ts:91` · `imageAgent.bodyTimeout: 0` 无响应体超时

**现象**：

```ts
const imageAgent = new Agent({
  bodyTimeout: 0,                    // ← 永远不超时
  headersTimeout: IMAGE_REQUEST_TIMEOUT_MS,   // 5min
  keepAliveTimeout: IMAGE_REQUEST_TIMEOUT_MS,
  keepAliveMaxTimeout: IMAGE_REQUEST_TIMEOUT_MS,
  pipelining: 0,
  connections: 30,
  connect: { timeout: IMAGE_REQUEST_TIMEOUT_MS },
});
```

**影响**：
headers 在 5 分钟内到达后，只要上游开始往 socket 写 body，就**永远不会被掐断**。任何一次"先发 headers 再卡住"的故障都会让 worker 占满 30 路连接槽位，直到进程级回收。单次卡死足以让整个图片通道 30 路并发全部打挂，影响所有用户的同渠道请求。

**根因**：body read timeout 被显式关掉。

**修复方案**：将 `bodyTimeout` 设为明确上限（与 `headersTimeout` 同 5min，或更保守 90s），根据上游最快可观察的 stall 时间选值。

**验证方式**：起一个 mock upstream，发完 headers 后 sleep 60s 不写 body，断言请求被中断（而非一直等待）。

---

### H4 · `app/api/generate/sora/route.ts:83-150, 491-511` · 参考视频 URL 仅做 hostname 黑名单，SSRF 可读回内网

**现象**：

```ts
function isPublicReferenceUrl(value: string): boolean {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const isPublicProtocol = url.protocol === 'http:' || url.protocol === 'https:';
  const hasAllowedPort = !url.port || url.port === '80' || url.port === '443';
  return isPublicProtocol && hasAllowedPort && hostname !== 'localhost' && !hostname.endsWith('.localhost');
}
// fetchRemoteReferenceMedia 用 fetchWithRetry 默认跟随重定向
```

**影响**：
已登录用户（选择 minimax-h3 模型时）提交 `referenceVideoUrls: ["http://169.254.169.254/latest/meta-data/iam/security-credentials/"]`、`http://127.0.0.1:8000/admin`、`http://[::1]/`、十进制 IP `http://2130706433/` 均可通过校验，服务器会实际下载内容（最大 200MB）。错误信息 `${error.message}：${url}` 还会把内网响应片段回显给用户（`details.slice(0, 200)`），构成**可读回的 SSRF + 内网探测**；重定向跟随使校验形同虚设。

**根因**：
- 只排除 `localhost` 字符串，未做私网 IP / 保留段过滤；
- 未做 DNS 解析后 IP 校验；
- 未禁止重定向。

**修复方案**：
复用 `lib/safe-fetch.ts` 的 `resolveAndValidateUrl` / `fetchExternalBuffer`（已具备私网拦截）替换 `fetchRemoteReferenceMedia` 内的裸 `fetch`；或在 `isPublicReferenceUrl` 中增加 IPv4 / IPv6 私网段（127/8、10/8、172.16/12、192.168/16、169.254/16、::1、fc00::/7、fe80::/10）与十进制 / 十六进制 IP 字面量判断，并设 `redirect: 'manual'` 逐跳校验。

**验证方式**：本地起监听 `127.0.0.1:9999` 返回固定内容的 HTTP 服务，POST `/api/generate/sora` 携带 `referenceVideoUrls: ["http://127.0.0.1:9999/x.mp4"]`（modelId 指向 minimax-h3 模型），修复后应返回 400 `Invalid public reference URL`。

---

### H5 · `app/api/generate/sora/route.ts:21-50, 521-525` + `lib/sora.ts:1400-1429, 729-740` · 视频时长分档价格可被绕过

**现象**：

```ts
// 计费（resolveModelDurationCost）：只看 request.duration
const requestedDurationValue = (request.duration || '').trim().toLowerCase();
const exactValueMatch = model.durations.find(d => d.value.trim().toLowerCase() === requestedDurationValue);

// 实际生成（resolveVideoConfigObject）：videoConfigObject.video_length 优先
const videoLengthRaw = typeof requestConfig?.video_length === 'number'
  ? requestConfig.video_length : ...;

// 路由侧仅 clamp 到 [4,30]，不与 duration 交叉校验
output.video_length = Math.max(4, Math.min(30, Math.floor(raw.video_length)));
```

**影响**：
当视频模型配置了 `durations` 分档价格时，用户提交 `duration: "4s"`（最低价档）+ `videoConfigObject: { video_length: 30 }`，grok2api 渠道实际生成 20 秒视频但只扣 4s 档积分。**可复现的定价绕过**。

**根因**：计费看 `request.duration`，生成看 `videoConfigObject.video_length`，两者不交叉校验。

**修复方案**：
1. 在 `normalizeIncomingVideoConfigObject` 之后、计费之前，强制 `videoConfigObject.video_length` 与 `duration` 解析秒数一致（以较大者为准重算价格）。
2. 或让 `resolveModelDurationCost` 在存在 `videoConfigObject.video_length` 时优先按它匹配档位。

**验证方式**：构造模型 `durations: [{value:'4s',cost:10},{value:'20s',cost:50}]`，POST `{duration:'4s', videoConfigObject:{video_length:30}}`，断言预扣 50 而非 10。

---

### H6 · `lib/sora-api.ts:584-677` · `pollVideoCompletion` 是无终止条件的 `while (true)`

**现象**：

```ts
while (true) {
  status = await getVideoStatus(videoId, channelId);
  if (isCompletedStatus(status.status)) { ... return status; }
  if (status.status === 'failed') { ... }
  // 'cancelled' 或任何未知状态：既不退出也不报错
  const interval = getPollingInterval(status.progress, stallCount);
  await new Promise(resolve => setTimeout(resolve, interval));
}
```

**影响**：
上游任务若返回 `cancelled`、卡死在 `processing`、或返回未知状态字符串，轮询永远继续：生成记录永远停留在 `processing`，**预扣积分永不退还**，且每个卡住的任务永久占用一个后台定时循环（句柄/内存泄漏，随时间累积拖垮进程）。对比 `lib/sora.ts` 的 Minimax 轮询有 `MINIMAX_H3_MAX_WAIT_MS = 20min`，此处缺失。

**根因**：无全局超时、未处理 `cancelled` 与未识别状态的兜底分支。

**修复方案**：
1. 增加 `startedAt` + 最大等待（如 20 分钟）超时抛错。
2. 将 `cancelled` 及非 `isInProgressStatus` 的未知状态视为终态失败抛出（消息中带上原始 status）。

**验证方式**：mock `getVideoStatus` 恒返回 `{ status: 'cancelled', progress: 50 }`，调用 `generateVideo`，修复后应在有限时间内抛出"任务已取消/超时"错误而非挂起（可用 `Promise.race` + fake timers 单测）。

---

### H7 · `lib/reference-image.ts:110-116` · 参考图递归只检测相邻层（A→B→A 会爆栈）

**现象**：

```ts
const nestedGenerationId = extractInternalGenerationId(generation.resultUrl, options.origin);
if (nestedGenerationId) {
  if (nestedGenerationId === generationId) {  // ← 只挡了 A→A
    throw new Error('Invalid recursive reference image');
  }
  return readInternalGenerationImage(nestedGenerationId, options);  // 递归无深度上限
}
```

**影响**：
`A` 引用 `B`、`B` 引用 `A`，进入 `B` 后再递归进入 `A` 时，`generationId === nestedGenerationId`（这次比较的 A 与 B）不命中，循环至**栈溢出 / Node `Maximum call stack size exceeded`**。链更长（A→B→C→A）同样崩。

**触发条件**：用户编辑 / 管理后台任意两张可互相链接的生成记录。

**修复方案**：在 `readInternalGenerationImage` 入口传一个 `visited: Set<string>` 参数（或深度上限 `maxDepth = 5`）。每次进入把 `generationId` 加进去，命中集合就抛错。

**验证方式**：单测里构造 `A→B`、`A→B→A`、`A→B→C→A→...`，断言抛错而非崩溃。

---

### H8 · `lib/db.ts` + `lib/db-codes.ts` · 多处 `JSON.parse(row.*)` 无 try/catch

**现象**：以下位置直接 `JSON.parse` 数据库字符串字段，无异常处理：

```
lib/db.ts:2356, 2413, 2441, 2467   params: typeof row.params === 'string' ? JSON.parse(row.params) : row.params
lib/db.ts:3162-3163                disabledModels: { imageModels: JSON.parse(...), videoModels: JSON.parse(...) }
lib/db.ts:3913                     images: typeof row.images === 'string' ? JSON.parse(row.images) : (row.images || [])
lib/db-codes.ts:1018               params: typeof row.params === 'string' ? JSON.parse(row.params || '{}') : row.params
```

**影响**：
- 任意一行 `generations.params` 因截断写入（超 TEXT 长度被 MySQL 截断）或手工修库变成非法 JSON 后：该用户任务状态查询 / 历史接口全部 500。
- 若损坏的是 `system_config.disabled_image_models`，`getSystemConfig` 抛错将导致**全站所有接口 500**（几乎每个路由都调它）。

**根因**：行映射绕过了已有的 `parseJsonValue` 安全解析。

**修复方案**：全部替换为 `parseJsonValue<Generation['params']>(row.params, {})`（db.ts 内已存在该 helper）；`disabled_image_models / disabled_video_models` 用 try/catch 包裹并回退 `[]`。

**验证方式**：`UPDATE generations SET params = '{bad json' WHERE id = '<id>'`，修复前 `GET /api/generate/status/<id>` 返回 500，修复后返回 200 且 `params` 为 `{}`。

---

### H9 · 容器重启遗留孤儿 jobs + sweep 被并发预算挤掉 · **真实事故案例 2026-09-22**

**现象**（来自 2026-09-22 服务器事故）：

```ts
// lib/generation-queue.ts:540-573 — tick() 入口
async function tick(state: QueueRuntime) {
  const config = await getSystemConfig();
  const queueConfig = config.generationQueue;
  if (!queueConfig.enabled) return;

  const globalAvailable = Math.max(0, queueConfig.imageConcurrency - state.active);
  if (globalAvailable <= 0) return;        // ← (a) sweep 和 claim 共用一个并发预算

  const lockTimeoutMs = queueConfig.lockTimeoutSeconds * 1_000;
  const expiredJobs = await sweepExpiredGenerationJobs(Math.max(1, globalAvailable));   // ← sweep 受 (a) 限制
  for (const job of expiredJobs) {
    void finalizeExpiredJob(job);          // ← mark failed + refund
  }
  ...
}
```

```ts
// lib/db.ts:2136-2149 — sweep 自身又有 hard 过滤
SELECT * FROM generation_jobs
 WHERE status = 'running'
   AND locked_until < ?            -- lock 必须到期
   AND attempts >= max_attempts    -- 必须"用完所有重试"
 ORDER BY locked_until ASC, created_at ASC
 LIMIT ${safeLimit}
```

```dockerfile
# Dockerfile — 没有 STOPSIGNAL 与 graceful shutdown
FROM node:20-alpine AS runner
...
CMD ["node", "server.js"]            # ← 收到 SIGTERM 直接进程退出，不释放 lock
```

**真实事故时序**：

```
T0   用户执行 `git pull` + `docker compose build sanhub && docker compose up -d sanhub`
T0   旧容器（workerId=b0249defcc34-1-9ncbnt）在执行 8 条 generation
T0   旧容器被 kill（默认 SIGKILL，10s 后）
T0   新容器（workerId=b64df697b891-1-85lwzl）启动
T0+1 新 worker 的 tick() 跑 → sweep 命中"locked_by='', locked_until=0"的那条（id=352779fd）
     → finalizeExpiredJob 把它标 completed + 退还积分（实际是 completed，不退）
T0+1 其它 7 条 job 的 lock 还停在 900s 后才到期 → sweep 现在拿不到
T0+15分钟 7 条 lock 全部到期
T0+15分钟 下一轮 tick sweep 命中 → mark failed + 退款 ✓
```

**事故当时看到的数据**：

```
generations.status='processing' 的 8 条全部卡在同一 channel
  ↓
  locked_by='b0249defcc34-1-9ncbnt'（旧 worker）
  locked_until 在未来 7~31 秒
  ↓
  sweep 的 WHERE `locked_until < now` 不命中（lock 没到期）
  ↓
  sweep 的 WHERE `attempts >= max_attempts` 在 attempts=1/max_attempts=1 下能命中，但前置条件卡死
```

**影响**：
- 任何一次**容器重启 / 部署** 都会留下遗孤 jobs，至少要等 `lockTimeoutSeconds`（默认 900s = 15 分钟）才能自然恢复；
- 业务高峰期间 `state.active` 接近 `imageConcurrency` 时，**sweep 直接被 `return` 早退**，遗孤 jobs 永久卡死（需更激进的修复）；
- 用户在前端看到的"处理中"最长能拖 15 分钟，期间无法提交新任务或撤销，造成客诉（本次事故里 `576668740@qq.com` 一人占 5 条，催了客服）。

**根因（分层归因，事故后修正）**：

> **修正说明**：原本把这版归到"重启遗孤 + sweep 被挤"，但 2026-09-22 事故中用户确认**部署之前就已观察到卡死**——说明重启只是放大了症状，真正的根因是更底层。下面按"底层 → 表层"排列：

**底层（真正的病因）**：
- **上游 hang 不报错**：`imageAgent.bodyTimeout: 0`（H3）允许上游接受请求后永远不返回 body；上游（例如 `bc61379f` 渠道 + `fd56462c` 模型）某次开始 hang 时，worker 进程不退出、lock 一直被续（每 5 min 一次）、job 永远不推进。本次事故里 **6 条卡死 50+ 分钟** 全部同模型同渠道（`fd56462c + bc61379f`），是上游 hang 的强证据。
- **缺渠道级 circuit breaker / 健康检查**：单渠道进入 hang 状态后，无任何机制把它摘掉或降速。其他渠道继续工作正常，但本渠道的 jobs 持续堆积。

**表层（让恢复拖了 15 分钟）**：
- 没有优雅停服：worker 死亡或重启时 lock 不会主动释放，必须等 `lockTimeoutSeconds` 自然到期；
- sweep 与 claim 共用并发预算：`tick()` 把"扫过期"和"接新单"绑在同一个 `globalAvailable`，系统忙时 sweep 被 `return` 早退，遗孤 jobs 永久卡死；
- sweep 硬过滤 `attempts >= max_attempts`：`max_attempts > 1` 时首次卡死（`attempts=0`）就永远扫不到。

> 顺序含义：**不修底层（H3 + circuit breaker），只修表层，hang 还是会发生，只是恢复更快；反之修了底层，表层缺陷也不致命**。所以本条目按"先修底层、再修表层"排修复优先级。

**修复方案**：

**先修底层（root cause）**：

1. **给 imageAgent 加上 bodyTimeout**（修复 H3）：
   ```ts
   const imageAgent = new Agent({
     bodyTimeout: 90_000,                 // 90s，比 headersTimeout 短
     headersTimeout: IMAGE_REQUEST_TIMEOUT_MS,
     ...
   });
   ```
   同样的思路应该扩展到 `reference-image.ts` / `media-storage.ts` 的下游 fetch。

2. **加渠道级 circuit breaker / 健康检查**（新 H10，见后）：
   - 维护"近 N 分钟内失败率 / 平均延迟"窗口；
   - 超过阈值（如 5 分钟内 5 次连续超时）→ 自动把该渠道标记为 `unhealthy`，admin 后台告警；
   - `generateImage` 调度时跳过 unhealthy 渠道，提示用户稍后重试。

**再修表层（恢复期）**：

3. **优雅停服**：
   - `Dockerfile` 加 `STOPSIGNAL SIGTERM`
   - `docker-entrypoint.sh` 加 trap：
     ```sh
     trap 'echo "[SanHub] Shutting down..."; kill -TERM $NODE_PID; wait $NODE_PID' TERM
     ```
   - 在 Next.js 启动脚本里监听 SIGTERM：先把 `generation_queue.enabled=false`，等所有 running 任务结算（最长 60s），再 `process.exit(0)`

4. **sweep 独立预算**：
   ```ts
   // tick() 拆成两步：sweep 永远跑，claim 受并发限制
   const sweepBudget = Math.max(8, queueConfig.imageConcurrency / 4);
   const expiredJobs = await sweepExpiredGenerationJobs(sweepBudget);
   for (const job of expiredJobs) void finalizeExpiredJob(job);

   const globalAvailable = Math.max(0, queueConfig.imageConcurrency - state.active);
   if (globalAvailable > 0) {
     const candidates = await claimGenerationJobs(...);
     ...
   }
   ```

5. **放宽 sweep 条件**：
   ```sql
   -- lib/db.ts:2136-2149
   WHERE status = 'running'
     AND locked_until < ?
     AND attempts > 0              -- 改成 ">0" 而不是 ">= max_attempts"
   ```

6. **降低 `lockTimeoutSeconds` 默认值**：从 900 改为 300（5 分钟），减少用户等待时间

**验证方式**：

```bash
# 1. H3 修复：起一个 mock upstream，发完 headers 后 sleep 60s 不写 body
# 修复前请求挂 60s；修复后 bodyTimeout=90s 时立刻被中断
curl -i http://localhost:9999/test   # 触发上游 hang，断言 90s 内 504/超时

# 2. circuit breaker 修复：
# 模拟同一渠道连续 5 次 5xx → admin 后台该渠道 status 变 'unhealthy' → 第 6 次请求被拒

# 3. tick() 单元测试：mock state.active = imageConcurrency，验证 sweep 仍跑

# 4. 真实事故重现（修复后）：
# 在 bc61379f 渠道上发 5 条 hang → 重启容器 → 期望：SIGTERM trap 先释放 lock，sweep 立刻命中
```

**事故后现场状态**（2026-09-22 修复前）：

```
A. 8 条 generations 最终状态：
   - 7 条 'failed' + balance_refunded=1 + err="Generation job expired after reaching max attempts"
   - 1 条 'completed' + balance_refunded=0（用户拿到了图）
B. 4 个用户余额与预期一致：
   - 1541314966@qq.com   1485  (= 1470 + 15)
   - 17819386903@163.com  605   (= 625 - 20 completed)
   - 576668740@qq.com    987   (= 947 + 100 退款 - 60 新生成)
   - 749873830@qq.com    1450  (= 1430 + 20)
C. generation_jobs 全表只剩 succeeded/failed，无 running
D. 事故前后用户反馈：
   - 用户确认"部署之前就已观察到 1 条以上卡死"——证明本次事故的根因是上游 hang
     + bodyTimeout=0，不是容器重启
   - 卡死的 6 条全部同 model fd56462c + 同 channel bc61379f，强证据指向该渠道上游 hang
E. 结论：用户感知层面已恢复（sweep 兜底 + 重启解除了 hang 的 worker），但根因未修
   下次同渠道再 hang 还会复现
```

---

### H10 · 缺渠道级 circuit breaker / 健康检查，单渠道 hang 能拖垮整个 worker

**现象**：

```ts
// lib/image-generator.ts — generateImage 路径直接选 channel，没有健康度判断
// 即便某渠道上游持续 hang，也不会自动跳过
const channel = await pickChannelForModel(modelId, options);
const result = await dispatch(channel, payload);   // ← hang 在这里会卡住 worker
```

```ts
// image_channels 表当前没有 health 状态字段（schema 缺）：
//   - consecutive_timeouts  INT DEFAULT 0
//   - last_failure_at       BIGINT DEFAULT 0
//   - last_success_at       BIGINT DEFAULT 0
//   - health_status         ENUM('healthy','degraded','unhealthy','manual_disabled') DEFAULT 'healthy'
//   - auto_disable_until    BIGINT DEFAULT 0  -- 自动跳过的截止时间
```

**影响**：
- 单个渠道上游出现持续 hang（本次事故的 `bc61379f` + `fd56462c`），所有发往该渠道的请求都会卡在 worker 上，直到 `bodyTimeout`（现在是 `0` = 永不超时）；
- 与 H3 / H9 复合放大：用户看到"处理中"长达数小时；其他渠道正常工作；
- 没有任何机制告警 / 自动降级 / 自动恢复，依赖人工发现并 disable 该渠道。

**根因**：
- 渠道调度时**只看优先级 / cost / enabled**，不看**近期成功率 / 平均延迟**；
- 没有滑动窗口记录渠道健康度；
- 没有"近 N 次失败 → 临时跳过 → 冷却 → 重试"的 circuit breaker 模式；
- admin 后台只能手动 disable，需要人盯着。

**修复方案**（推荐 4 件，按优先级）：

1. **加 channel health 表 / 字段**：
   ```sql
   ALTER TABLE image_channels
     ADD COLUMN consecutive_failures  INT DEFAULT 0,
     ADD COLUMN last_failure_at       BIGINT DEFAULT 0,
     ADD COLUMN last_success_at       BIGINT DEFAULT 0,
     ADD COLUMN health_status ENUM('healthy','degraded','unhealthy','disabled') DEFAULT 'healthy',
     ADD COLUMN auto_disable_until    BIGINT DEFAULT 0;
   ```

2. **渠道调度时跳过 unhealthy**：
   ```ts
   async function pickChannelForModel(modelId: string): Promise<ImageChannel> {
     const now = Date.now();
     const candidates = await listChannelsByModel(modelId);
     return candidates.find(c =>
       c.enabled
       && c.healthStatus !== 'unhealthy'
       && (c.autoDisableUntil === 0 || c.autoDisableUntil < now)
     ) ?? throw new Error('No healthy channel available');
   }
   ```

3. **失败计数 + 自动降级**：
   ```ts
   // generateImage 出口 / 出口错误处
   if (isTimeoutError(e) || is5xx(e)) {
     await incrementChannelFailures(channel.id);
     const fail = channel.consecutiveFailures + 1;
     if (fail >= 5) {
       await markChannelUnhealthy(channel.id, cooldownMs: 5 * 60 * 1000);
       notifyAdmin(`渠道 ${channel.name} 自动降级，连续 ${fail} 次失败`);
     }
   } else {
     await resetChannelFailures(channel.id);
   }
   ```

4. **admin 后台 health 可视化**（UI 增列 + 自动降级原因）：
   - 列表加 `health_status` 列，hover 显示 `last_failure_at` / `auto_disable_until`；
   - "恢复"按钮可手动把 unhealthy 拉回 healthy。

**验证方式**：
- mock 上游持续返回 500 → 第 5 次失败后该渠道自动转 unhealthy → 第 6 次请求被 dispatch 跳过 → admin 后台 UI 显示降级原因
- 5 分钟后 cooldown 到期，下一次请求恢复尝试（half-open 模式）

**与 H3 / H9 的关系**：
- H3（`bodyTimeout: 0`）让 hang 可以无限长；
- H9 让 hang 的恢复被拖 15 分钟；
- **H10 在 hang 刚发生时就把该渠道摘掉**，是比 H3/H9 更上游的防御；
- 三个修法必须配套使用，只修一个治标不治本。

**事故关联**：本次事故里 `bc61379f` 渠道持续 hang 50+ 分钟，期间系统没有任何机制察觉它病了——H10 正是为了把这种"静默生病"变成"主动告警 + 自动摘除"。

---

## Medium

### M1 · `lib/rate-limit.ts:78-89` · `x-real-ip` 无条件信任，限流可被任意伪造

**现象**：

```ts
const trustProxy = process.env.TRUST_PROXY === 'true';
const forwarded = request.headers.get('x-forwarded-for');
if (trustProxy && forwarded) { return forwarded.split(',')[0].trim(); }
const realIP = request.headers.get('x-real-ip');
if (realIP) { return realIP; }   // ← 任何客户端可伪造
```

**影响**：
未设置 `TRUST_PROXY=true` 时（默认），攻击者每次请求带上随机 `X-Real-IP` 头即可让限流键永远 miss，**完全绕过**所有端点限流——包括 `AUTH`（5 次/分钟）的登录 / 注册 / 邮箱验证码暴力破解保护，和生成接口成本保护。同时每个伪造 IP 在 Map 中新增一条记录，高速打满时造成内存膨胀（清理间隔 60 秒）。

**根因**：`x-real-ip` 的信任不依赖 `TRUST_PROXY`，且限流器为进程内存态。

**修复方案**：`x-real-ip` 同样仅在 `TRUST_PROXY === 'true'` 时采信；并给 Map 加上限（如超过 10 万条时淘汰最旧条目）。

**验证方式**：对 `/api/auth/email-code` 连续发送 10 个请求、每次 `X-Real-IP` 随机，修复前全部 200，修复后第 6 个起应返回 429。

---

### M2 · `app/(auth)/register/page.tsx:129` + `app/api/auth/register/route.ts` + `app/api/captcha/verify/route.ts` · 验证码只在前端校验，服务端不强制

**现象**：
验证码只在前端页面调用 `/api/captcha/verify` 校验，真正的注册接口 `POST /api/auth/register` 与 NextAuth 登录（`lib/auth.ts` credentials）均**不校验**验证码。全库搜索 `verifyCaptcha` 仅被 `captcha/verify/route.ts` 引用。

**影响**：
图形验证码形同虚设：脚本直接 POST `/api/auth/register`（仅需过 5 次/分钟、且可被 M1 绕过的 IP 限流）即可批量注册；登录爆破同样无视验证码。

**根因**：验证码校验结果从未被服务端消费端点强制要求。

**修复方案**：register 与 NextAuth `authorize` 中接收并服务端调用 `verifyCaptcha(id, code)`（一次性），失败返回 400。

**验证方式**：不带任何验证码字段直接 `curl -X POST /api/auth/register -d '{"name":"x","email":"a@b.com","password":"123456"}'`，修复后应返回 400。

---

### M3 · `app/api/generate/sora/route.ts:385, 438-446` + `app/api/generate/image/route.ts:332-359` + `app/api/generate/character-card/route.ts:124` · 内联 base64 载荷无大小/形状校验

**现象**：

```ts
// generate/sora：body.files 直接透传，未校验每项大小与字段类型
const body: SoraGenerateRequest = await request.json();
// lib/sora.ts:1442 / 1536: file.mimeType.startsWith('image/') — files:[{}] 即 TypeError
// generate/image：images.filter(isInlineImageInput) 仅查类型，不限制 data 字节数
// character-card：body.videoBase64 完全无大小限制
```

**影响**：
- 已登录用户可 POST 数百 MB 的 base64 JSON（30 次/分钟限流），每个请求在内存中多次复制（JSON 解析、FormData、Buffer、data URL 拼接），快速打爆 Node 进程内存 = **拒绝服务**。
- `files:[{"data":"x"}]` 这类缺 `mimeType` 的畸形输入在 minimax-h3 路径同步抛 `TypeError`（500），其他渠道在后台任务抛错。
- 角色卡 `videoBase64` 同样无上限。

**根因**：只校验了数组长度 / 引用 URL 大小，未校验内联 base64 总字节数与元素结构。

**修复方案**：在路由入口统一校验：`files / images` 每项 `typeof mimeType === 'string' && typeof data === 'string'`，并限制单文件与合计 base64 长度（如单文件 ≤ 15MB、合计 ≤ 50MB，对照 `MAX_REFERENCE_IMAGE_BYTES`）；`videoBase64` 加上限（如 100MB）。

**验证方式**：POST `/api/generate/sora`，body 含 `files:[{data:'x'}]`（无 mimeType），修复后返回 400 而非 500；再发 200MB base64，修复后返回 413/400。

---

### M4 · `lib/email-verification.ts:61-63, 124-126` + `app/api/auth/email-code/route.ts` · 邮箱验证码 `Math.random` 且无重发冷却

**现象**：

```ts
function createVerificationCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));  // 非加密随机
}
// sendEmailVerificationCode: emailCodeStore.set(email, ...) 直接覆盖旧码并立即发信
```

**影响**：
- 结合 M1 的 `X-Real-IP` 绕过，攻击者可对受害邮箱**无限触发**验证码邮件（每次覆盖旧码），形成邮件轰炸并使受害者真实验证码失效。
- `Math.random` 状态可预测时 6 位验证码存在理论可预测性（虽有 5 次尝试上限，实际风险低）。
- 内存态 store 在多实例 / serverless 下注册流程直接失败。

**根因**：缺 per-email 重发冷却（如 60s）与每日上限；PRNG 非 CSPRNG。

**修复方案**：改用 `crypto.randomInt(100000, 1000000)`；在 store 中记录 `lastSentAt`，同邮箱 60 秒内拒绝重发；生产多实例时落库 / Redis。

**验证方式**：同邮箱连续两次 POST `/api/auth/email-code`，修复后第二次应 429/400；单测断言两次 code 不可由 `Math.random` 状态推出。

---

### M5 · `app/api/v1/chat/completions/route.ts:429-436` · 上游错误体原样回传且无长度限制

**现象**：

```ts
if (!upstreamResponse.ok) {
  const errorText = await upstreamResponse.text();
  return buildErrorResponse(`Upstream error (${upstreamResponse.status}): ${errorText.slice(0, 200)}`);
}
```

**影响**：
上游可故意返回巨长 body 触发 `await response.text()` 占用内存；slice 前已完整读入。若上游注入恶意 HTML 或 JavaScript 字符串，调用方把它作为 JSON 字段返回给浏览器，存在二次反射风险（特别是当上游平台是 admin 可配置的 channel 时）。

**根因**：`response.text()` 无 stream 截断；slice 是"读完再截"。

**修复方案**：用 stream reader 限制读取字节数（如 ≤ 4KB 截断）；或直接用 `response.headers.get('content-type')` + `statusText` 构建错误响应，不读 body。

**验证方式**：构造一个始终返回 1MB body 的 mock upstream，断言客户端收到 4KB 截断后错误且服务端读取耗时 < 100ms。

---

### M6 · `lib/image-generator.ts:1225-1273` · `generateWithOpenAIChat` 把 `size/quality` 全部塞进 `extra_body.google.image_config`，真实 OpenAI chat endpoint 不会读

**现象**：

```ts
const imageConfig: Record<string, string> = {};
if (normalizedAspectRatio) imageConfig.aspect_ratio = normalizedAspectRatio;
if (request.imageSize) imageConfig.image_size = request.imageSize;
if (request.size) imageConfig.size = request.size.replace(/×/g, 'x');
...
if (Object.keys(imageConfig).length > 0) {
  payload.extra_body = { google: { image_config: imageConfig } };
}
```

**问题**：top-level `payload` 上**根本没有 `size` / `quality`**，唯一的尺寸信号是 `extra_body.google.image_config` —— 这是 Gemini 兼容约定。真正的 OpenAI `/v1/chat/completions`（以及大多数不自称 Gemini 兼容的中转）会忽略它，结果就是：挂在 `openai-chat` 渠道上的模型，**`size` / `quality` 用户实际看到的不生效**，分辨率由上游自己决定。

**和 ezaiclub 中转现象同族** —— 症状一样，只是这次是代码设计如此，不是中转的 bug。

**修复方案**：
- 在 chat 路径同步发出顶层 `payload.size = target.size`（取 `resolvedTarget.size`）和 `payload.quality = request.quality`；
- 或在 dispatcher 处校验 channel 的 baseUrl 必须命中 Gemini 兼容特征，否则拒绝路由到 `generateWithOpenAIChat`；
- 验证：用真实 OpenAI chat 端点（不只是 Gemini 兼容代理）发起，确认响应里图的实际尺寸等于请求尺寸。

**验证方式**：参考 `docs/image-quality-and-image-size-review.md` 的 curl 复测方式，用真实 OpenAI 端点发起，确认尺寸一致。

---

### M7 · `lib/image-generator.ts:557-573` · `generateWithOpenAI` 给非 Gemini 模型也加 `extra_body.google.image_config`

**现象**：

```ts
const googleConfig: Record<string, string> = {};
if (normalizedRequest.aspectRatio) googleConfig.aspect_ratio = normalizedAspectRatio;
const compatibleImageSize = request.imageSize || (isGeminiModel ? inferGeminiImageSize(...) : undefined);
if (compatibleImageSize) googleConfig.image_size = compatibleImageSize;
if (typeof payload.size === 'string') googleConfig.size = payload.size;
...
if (Object.keys(googleConfig).length > 0) {
  payload.extra_body = { google: { image_config: googleConfig } };  // 无条件
}
```

**问题**：只有当 `isGeminiModel` 时这一坨才有意义。但当前实现**对所有 openai-compatible 渠道**都加这坨 `extra_body`。对真 OpenAI 是无害的，但对部分中转 / 聚合（如 `api9`、`ai2api` 等 Gemini 兼容代理）的配置它可能被识别 / 干扰，且在 admin 配置成 "openai-compatible 但 upstream 是 Gemini 兼容代理" 这种边界情况下，会与上游真实期望的字段不一致。

**修复方案**：把 `if (Object.keys(googleConfig).length > 0)` 包成 `if (isGeminiModel && Object.keys(googleConfig).length > 0)`。

**验证方式**：在已确认忠实遵守 size 的 `duolapi` 上对照新旧两次出图，确认 `extra_body` 缺失不会破坏结果。

---

### M8 · `lib/image-generator.ts:38-47` · `getNextApiKey` 不会在 retry 上换 key

**现象**：

```ts
function getNextApiKey(keys: string, channelId: string): string {
  const keyList = keys.split(',').map(k => k.trim()).filter(k => k);
  ...
  const currentIndex = keyIndexMap.get(channelId) || 0;
  const key = keyList[currentIndex % keyList.length];
  keyIndexMap.set(channelId, currentIndex + 1);
  return key;
}
```

**影响**：
当前 `GENERATION_POST_RETRY_OPTIONS.attempts = 1` 让这个 bug 暂时不爆，但任何想开 retry 的改动都会撞到同一个 key 反复失败（403/429/5xx 时不切换）。

**修复方案**：把 key 选择抽到 `http-retry` 的 fetcher 层，retry 回调里报 `attempt` 时重选。

---

### M9 · `lib/image-generator.ts:36` · 模块级 `keyIndexMap` 永远不被清理

**现象**：跨请求跨进程常驻；如果 admin 删除 / 新增渠道，旧 entry 不会被 GC；多 key 轮询后也只增不减。

**修复方案**：把 index 改成 weak-keyed（按 channel 存在性自行失效），或干脆去掉 —— round-robin 完全可以在请求内每次随机起算，效果等价。

---

### M10 · `lib/safe-fetch.ts:79-109` · DNS rebinding 已知风险

**现象**：

```ts
const records = await dns.lookup(url.hostname, { all: true });
... // 校验
const response = await fetchWithRetry(fetch, currentUrl.toString(), ...);
```

**影响**：在 `dns.lookup` 与 `fetch` 之间，攻击者控制的 DNS 可再次返回公网 IP（DNS rebinding）。校验窗口很短，但确实是 SSRF 教科书的经典遗漏。该函数被 `reference-image.ts:118` 和 `media-storage.ts:145` 的下载路径使用。

**修复方案**：在 undici dispatcher 上做 connect-time 校验（custom Connector），或在 fetch URL 时把 hostname 直接 pin 到已校验的 IP（修改 `Host` 头）。如果不想做这些，至少加一个 SSRF 监控告警。

---

## Low

### L1 · `app/api/v1/videos/route.ts` 等 · `videoId` 未做 URL 编码传入上游

**现象**：直接拼到 `https://.../videos/{videoId}`，若 `videoId` 含 `/` / `?` 等被上游解读为路径分隔符，可能泄露别的任务。

**修复方案**：`encodeURIComponent(videoId)`；或换 query 参数。

---

### L2 · `lib/easypay.ts:32-38` · 签名比较未使用 timing-safe 比较

**现象**：

```ts
return signEasyPayParams(params, apiKey) === params.sign;
```

**影响**：理论上 `===` 字符串比较在 Node V8 上不等长就立即返回，可被精确计时区分；实际攻击门槛较高。

**修复方案**：`crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))`；先校验等长度。

---

### L3 · 调试日志 · 上游返回的"签名 URL"被完整打印

**现象**：在若干 catch 路径下 `console.error('Upstream error ...', errorText)`，上游 CDN 的预签 URL（含短时 token）会被写入日志。

**修复方案**：生产日志脱敏（mask `?token=` / `?signature=` 后的查询串）。

---

### L4 · `lib/prompt-blocklist-core.ts:25-28, 100-136` · Blocklist 规则每次请求重新编译 / `substr:` 与默认 whole-word 都线性扫描

**现象**：`findBlockedWords` 每次调用都重新 `parseBlocklistWords → parseRule → new RegExp`，且对每条规则执行 `regex.test(prompt)`。N 条规则 × 每请求 O(N)。

**修复方案**：把编译后的规则数组做成 LRU + TTL 缓存；或在 db.ts 层把 `blocklistWords` 缓存为已编译规则，TTL 60s。

---

### L5 · `app/api/prompts/route.ts` · 用户提示词共享列表可被枚举

**现象**：查询条件可遍历 `limit + offset`，且似乎不做 admin 鉴权或访问控制。需结合实际代码确认。

**修复方案**：限制单页 + 强制登录用户只能看到自己的；或仅 admin 可读。

---

### L6 · `app/api/**/route.ts` · `request.json()` 普遍未包 try/catch

**现象**：36 个路由文件都用 `await request.json()`，无 try/catch 包裹；前端传非法 JSON 会导致 500。

**修复方案**：统一改为 `try { body = await request.json() } catch { return 400 }`。

---

### L7 · `lib/generation-queue.ts:526-533` · 任务失败退款不重试

**现象**：

```ts
await refundGenerationBalance(...).catch((refundError) => {
  console.error(`[GenerationQueue] Refund failed for generation ${job.generationId}:`, refundError);
});
```

**影响**：失败只 log，不入队重试 → 用户积分永久丢失。

**修复方案**：失败入队 "refund-retry" 任务，单独 worker 兜底。

---

### L8 · `lib/generation-queue.ts:76-87, 433-538` · 队列运行时状态在多实例下不安全

**现象**：`globalForQueue.__sanhubGenerationQueue` 是 `globalThis` 上的进程内 Map。Next.js dev 多 worker / serverless 多实例下各实例独立计数 → `channelConcurrency` 实际并发上限 = N × 配置上限。

**修复方案**：把 active / activeByChannel 移到 Redis 或 DB（用 `SELECT ... FOR UPDATE` 计数），或干脆关掉 in-memory 限流并依赖 DB 层 claim 的 lock 机制。

---

### L9 · `lib/auth.ts:109` · `process.env.NEXTAUTH_SECRET` 缺失时启动崩溃

**现象**：`secret: process.env.NEXTAUTH_SECRET` 未做缺省值检查。

**修复**：fail-fast —— 在 `lib/auth.ts` 顶部：

```ts
if (!process.env.NEXTAUTH_SECRET) {
  throw new Error('NEXTAUTH_SECRET is required');
}
```

**验证**：`unset NEXTAUTH_SECRET && npm run dev` 应当立即报错而不是后期诡异 401。

---

### L10 · `lib/media-storage.ts:184-220` · `saveMediaToFile` 用 `${id}.${ext}` 作文件名

**现象**：

```ts
const filename = `${id}.${ext}`;
const filepath = path.join(MEDIA_DIR, filename);
```

只要 `id` 是服务端生成的 UUID（按 `lib/db.ts` 的 generation id 推断应该是），就**没有路径穿越**。但当前代码没显式校验。

**修复**：加一道防御：`if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid id')`。

**验证**：构造 `id='../../etc/passwd'`，断言抛错而非写入。

---

### L11 · `lib/image-generator.ts:1303-1304` · SSE 流式解析里 `data:` 跨 chunk 边界

**现象**：`generateWithOpenAIChat` 的 SSE 分块解析里，跨 chunk 的 `data:` 行没有"先 buffer 再 split"的标准处理（已用 `buffer += decoder.decode()`），但 `data:` 行首尾跨 chunk 的 case（`data: {` 拆成 `data: {` 与 `\n}`）会在 `\n` 分割后变成 `"...data\n第一段"` 和 `"第二段"`，然后下一行被当成独立 event 解析。

**影响**：可能误识别事件边界，造成 reasoning / content 串位。需实测才能复现。

**修复**：按 SSE 规范处理：先按 `\n\n`（空行）切 event，再按 `\n:` 切行。

---

### L12 · `lib/http-retry.ts:67-73` · `drainResponse` 静默吞掉错误

**现象**：

```ts
async function drainResponse(response: ResponseLike): Promise<void> {
  try { await response.arrayBuffer(); } catch { /* ignore */ }
}
```

**影响**：drain 失败说明连接异常关闭，但代码完全不留痕。后续 retry 时上层拿不到这个状态。

**修复**：加一行 `console.warn('[http-retry] drain failed', err)` 即可。

---

### L13 · `components/ui/announcement.tsx:58` · `dangerouslySetInnerHTML` 用于管理员公告

**现象**：admin 公告支持 HTML 渲染，使用 `dangerouslySetInnerHTML`。

**影响**：仅 admin 可写，因此攻击门槛 = 拿到 admin 凭证，blast radius 受限。

**修复**：白名单标签（仅 `<br> <b> <i> <a>`） + 强制链接 `rel="noopener noreferrer"`。

---

## 跨切片建议

- **图片生成结果落库时务必读一次图片头拿真实像素**（PNG 的 IHDR / JPEG 的 SOF），不要采信上游响应 meta —— 已发现多个中转会伪造 `width/height`。建议落成 `lib/image-dimensions.ts`，在 `saveMediaWithMetrics` 保存路径调用，失败则回退为请求值。这能直接消除"预设 2400×1600、实际 3504×2336"这一类静默不一致。

- **日志策略**：`console.log('prompt ...')` / `console.error(..., errorText)` 不要原样落盘上游 body / 完整 prompt 内容。当前多数 catch 路径 OK，但有几处上游 CDN 的预签 URL 会被记进日志（L3）。

- **全局进程内可变状态**（`keyIndexMap`、`__sanhubGenerationQueue`、`emailCodeStore`、`captchaStore`、`RateLimiter.limits`）在多 worker / serverless 下都不可靠。新功能里要做类似的"全局状态"时要警惕，或者把它外置到 Redis / DB。

- **CSRF**：当前是 cookie-only 鉴权 + 浏览器同源策略保护，理论上可被同站 XSS 利用（结合 H2 的"原密码可跳过"形成完整接管链）。建议在所有 mutating POST 上加 `X-Requested-With: fetch` 检查或双重提交 cookie CSRF token。

- **`try/catch + 静态 fallback` 模式**：把 `parseJsonValue<T>(row.x, defaultT)` 这种 helper 推到所有读 DB 的位置（H8 的修复），是性价比最高的一次改造 —— 一次写好，所有未来的 schema migration 都会自动受益。

---

## 已验证 OK 的点

| 区域 | 结论 |
| --- | --- |
| Admin 鉴权 (`app/admin/layout.tsx:13-22`) | 有 `getServerSession` + role 校验，未登录 / 普通用户被拦 ✓ |
| API key 展示 (`app/admin/image-channels/page.tsx:1286-1291, 1422-1427`) | 默认 `type="password"`，`showKeys` 切换可见，admin-only ✓ |
| SSRF 防御 (`lib/safe-fetch.ts`) | 拦截 localhost / .local / .internal / 私有 IPv4/IPv6（含 CGNAT 100.64/12、IPv6 ULA）✓ |
| 鉴权数据同步 (`lib/auth.ts:73-99`) | 每次 `session` 都查 DB 拿 fresh balance，且禁用用户返回 `null` 强制登出 ✓ |
| Quality 在 UI 的一致性 (`image-generation-page.tsx`、`batch-*.tsx`、`image-quality.ts`) | 三处共用 `IMAGE_QUALITY_OPTIONS` / `resolveImageQuality`，一致性确认 ✓ |
| Quality 在 admin 的展示 (`app/admin/generations/page.tsx:132-154`) | `isQualityAwareModelName` 双重保险 + `params.quality` 非空判断 ✓ |
| `lib/safe-fetch.ts` 的 redirect 处理 | 跟随时逐跳校验 ✓ |
| DB connection 池 (`lib/db.ts`) | `await pool.execute(...)` 用 try / finally + `db.release()`，无明显泄漏 ✓ |

---

## 修复路线图

### Sprint 1（资金 + 安全，3-5 天）

| 编号 | 工作量 | 风险 |
| --- | --- | --- |
| C1 取消任务竞态 | 0.5 天 | 低（条件 UPDATE） |
| H1 支付事务 | 0.5 天 | 中（事务边界） |
| H2 密码改原密码校验 | 0.1 天 | 极低 |
| H4 SSRF 防御 | 0.5 天 | 低（复用 safe-fetch） |
| H6 轮询超时 | 0.3 天 | 低 |
| M1 限流 IP 来源 | 0.2 天 | 极低 |
| M2 验证码强制 | 0.3 天 | 低（需协调前端） |

### Sprint 2（鲁棒性，3-5 天）

| 编号 | 工作量 | 风险 |
| --- | --- | --- |
| H3 `bodyTimeout` | 0.1 天 | 极低 |
| H5 视频时长交叉校验 | 0.3 天 | 低 |
| H7 参考图递归 | 0.2 天 | 极低 |
| H8 DB JSON.parse | 0.5 天 | 低（helper 替换） |
| M3 base64 大小 | 0.5 天 | 低 |
| M4 邮件验证码冷却 | 0.3 天 | 极低 |
| M5 上游错误体 | 0.2 天 | 低 |

### Sprint 3（设计改进，可选）

| 编号 | 工作量 | 风险 |
| --- | --- | --- |
| M6/M7 chat / 兼容路径 size | 0.5 天 | 中（需端到端验证） |
| M8/M9 keyIndexMap | 0.3 天 | 低 |
| M10 DNS TOCTOU | 1 天 | 中（dispatcher 改造） |
| L1-L13 | 0.5-1 天 / 条 | 极低到低 |

### 横切（任一 sprint）

- `lib/image-dimensions.ts`：落库时读取真实像素（彻底消除"预设 vs 实际"静默差异）
- `parseJsonValue` 全面替换（防御 schema 漂移）
- 关键 mutating POST 加 CSRF token