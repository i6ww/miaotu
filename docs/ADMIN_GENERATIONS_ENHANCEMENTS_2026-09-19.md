# 管理后台生成记录增强（2026-09-19）

## 背景

管理后台「生成记录」页面此前只有用户 / 类型 / 提示词 / 状态 / 积分 / 时间 / 删除七列。排查线上渠道故障（如上游额度不足持续 2 小时、30 条失败）时必须登录 MySQL 查 `error_message`，排障效率低。本次按第一优先级落地三项排障增强。

## 新功能

### 1. 失败原因展示

- 失败记录行在提示词下方显示红色错误摘要（单行截断，悬停显示完整 `error_message`）；
- 数据来自 `generations.error_message`，无需人工查库即可看到失败原因。

### 2. 失败原因统计卡片

- 列表上方新增「失败原因分布」卡片，按当前筛选范围（用户 / 类型 / 时间 / 搜索）聚合全部失败记录；
- 后端按 `error_message` 精确分组（`GROUP BY ... LIMIT 300`），再在应用层归并为粗分类：

| 分类 key | 标签 | 匹配关键词（示例） |
|---|---|---|
| quota | 额度不足 | `insufficient_user_quota`、`额度不足`、`积分不足` |
| content | 内容审核 | `content_policy`、`审核`、`blocked` |
| network | 网络/超时 | `timeout`、`ECONNRESET`、`fetch failed` |
| rate_limit | 限流 | `429`、`rate limit`、`限流` |
| upstream | 上游服务错误 | `500/502/503/504`、`Upstream` |
| other / unknown | 其他 / 未知 | 兜底 |

- 每个分类徽章显示计数与占比，悬停显示该分类最典型的 2 条原始错误信息；
- 上游渠道故障（如某渠道连续报同一错误）在卡片上表现为单一分类计数激增，一眼定位。

### 3. 时间范围筛选

- 新增时间下拉：全部时间 / 今天 / 近 7 天 / 近 30 天 / 自定义（起止日期选择器）；
- 后端 `getAllGenerations` 支持 `startTime` / `endTime`（毫秒时间戳，`created_at` 范围过滤）；
- 失败统计卡片与列表共用同一时间范围。

## 接口变更（`GET /api/admin/generations`）

- 新增查询参数：`startTime`、`endTime`（可选，毫秒时间戳）；
- 响应新增字段：`failureSummary`（仅当未按非失败状态过滤时返回）：

```json
{
  "failureSummary": {
    "total": 8069,
    "categories": [
      { "key": "upstream", "label": "上游服务错误", "count": 5321, "topMessages": ["OpenAI Chat API error (500): ..."] }
    ]
  }
}
```

## 数据层变更（`lib/db-codes.ts`）

- `getAllGenerations`：新增 `startTime` / `endTime` 可选参数（WHERE 条件）；
- 新增 `getGenerationFailureSummary`：失败原因聚合（复用列表的用户 / 类型 / 时间 / 搜索过滤条件，status 固定为 `failed`）；
- 新增导出 `FAILURE_CATEGORY_LABELS`：分类中文标签映射。

## 附带修复（`lib/db.ts`）

`backfillGenerationClientRequestIds` 的两处健壮性改进（生产 MySQL 行为不变或略有改善）：

1. 唯一约束冲突判重补充 `SQLITE_CONSTRAINT_UNIQUE`（原先只认 MySQL 的 `ER_DUP_ENTRY`，导致本地 SQLite 回填中断）；
2. 回填前先查询 `(user_id, client_request_id)` 是否已被占用，占用直接跳过，避免每次启动抛约束错误刷日志；
3. 顺带修复：合并了该函数中重复打印的日志代码块。

## 性能评估（基于生产真实规模）

- 生产 `generations` 共 75,301 行（2026-09-17，月增约 2.1 万，约 10.7% 失败率）；
- 全部新增查询在当前规模均为毫秒级，**无需新增索引**；
- 触达 50 万行（预计约 1.5 年后）或页面出现秒级加载时，再考虑：
  1. 复合索引 `(status, created_at)`（优先，一行 DDL）；
  2. `generations` 反范式化增加 `channel_id` 列（治本，解决渠道筛选的全表扫描）；
  3. 失败统计卡片改为按需计算（默认不随页面加载）。

## 本地测试说明

生产数据可经 `mysqldump` 导出后导入本地 SQLite 测试（无需本地 Docker / MySQL）：

```sh
python scripts/import-mysql-dump-to-sqlite.py local-test.sql ./data/sanhub.db
```

（脚本不入库；dump 与本地库均已gitignore，注意生产数据只留本地。）
