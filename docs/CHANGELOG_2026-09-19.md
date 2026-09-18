# 2026-09-19 改动汇总

> 涉及 4 个提交：`f699dc6` → `2680d9d` → `22b1922` → `2584f28`
> 统计：14 个文件变更，约 +1055 / -77 行（不含删除的图片资源）

---

## 1. 管理后台：生成记录排障增强（`f699dc6`）

**目标**：管理员能快速定位生成失败原因，按时间维度分析故障。

- 生成记录页失败行显示 `error_message` 摘要，悬停查看全文
- 新增失败原因分布统计卡片（按 quota / content / network / rate_limit / upstream 等粗分类聚合）
- 列表与统计支持时间范围筛选（今天 / 近7天 / 近30天 / 自定义起止）
- API `/api/admin/generations` 新增 `startTime` / `endTime` 参数与 `failureSummary` 响应字段
- `lib/db-codes.ts`：`getAllGenerations` 时间过滤 + `getGenerationFailureSummary` 聚合
- `lib/db.ts`：`client_request_id` 回填兼容 SQLite 唯一约束冲突，先查后写避免启动日志刷屏（生产 MySQL 行为不变）
- `lib/db-adapter.ts`：SQLite 幂等迁移日志降噪
- 移除仓库内不再使用的截图资源（`img/*.png`，约 3.4 MB）
- 详细评估见 `docs/ADMIN_GENERATIONS_ENHANCEMENTS_2026-09-19.md`

## 2. 管理后台：充值统计包含兑换码记录（`2680d9d`）

**目标**：充值总额/笔数统计口径补全，兑换码兑换也计入。

- 充值统计页（`app/admin/stats/page.tsx`）汇总口径加入兑换码记录
- `lib/db-codes.ts`、`lib/db.ts`：新增兑换码记录查询与聚合逻辑

## 3. 用户侧：模型列表自动刷新（`22b1922`）

**目标**：解决管理员开关渠道后，用户端模型列表不更新、看不到最新渠道状态的问题。

- 浏览器标签页重新获得焦点时自动重新拉取模型列表
- 60 秒轮询兜底（聊天页、图片页、视频页均生效）
- 选中模型被下线后自动回落到可用模型，避免提交时报错

## 4. 用户侧：最近批次删除功能（`2584f28`）

**目标**：用户可清理历史生成批次，保护隐私/减少干扰。

- 批量生图页支持删除单个最近批次、一键清空全部
- 进行中（pending）的批次不可删除，防止误删任务
- API `/api/user/generation-batches` 新增 DELETE 方法（单个 / 全部）
- `lib/db.ts`：批次与关联记录级联删除
- 顺手修复：`types/index.ts` 中 `PaymentOrder.provider` 类型补充 `'redemption'`

---

## 遗留事项

- 本地 `.env.local` 中的 `NEXTAUTH_URL` 等环境配置改动不在版本库内，生产环境需在部署时单独设置
- 根目录 `api-integration-guide(36).md` 为临时下载文档，未纳入版本控制
