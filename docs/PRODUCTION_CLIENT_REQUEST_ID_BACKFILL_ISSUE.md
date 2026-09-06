# 生产环境待处理：client_request_id 回填冲突告警

> 状态：**修复代码已提交到 miaotu 仓库，但尚未部署到生产服务器**。
> 服务器下次正常发布（`git pull` + `docker compose up -d --build`）时会自动带上此修复，无需单独处理。

## 一、现象

2026-09-06 生产升级到 `4dec716` 后，`sanhub` 容器每次启动时日志出现：

```
[DB] Failed to backfill generation client_request_id values: Error:
Duplicate entry '...' for key 'generations.idx_user_client_request_id'
```

服务本身正常启动（`Database initialized successfully`，登录页 HTTP 200），仅属启动期告警，不影响运行。

## 二、根因

代码位置：`lib/db.ts::backfillGenerationClientRequestIds`，在数据库初始化时调用。

- 该函数将历史 `generations` 记录从 `params` JSON 中提取的 `clientRequestId` 回填到新列 `client_request_id`。
- 存量数据中存在同一 `(user_id, client_request_id)` 对应多条记录的情况（升级前的历史冗余写入）。
- 唯一索引 `idx_user_client_request_id` 建立后，逐行 UPDATE 执行到重复组内第 2 条时触发 `ER_DUP_ENTRY`，而原实现会**中止整批回填**。
- 结果：每次启动都在同一批记录上失败。已回填成功的行保留，剩余 13 条全部是各重复组的次要行。

## 三、影响评估

- 不致命，不影响新写入（新记录插入时即携带 `client_request_id`）。
- 存量缺口固定为 13 条，不会随运行增长。
- 若不修复，代价为：
  1. 每次容器重启都会刷一条 `Failed to backfill` 红色告警，干扰日志排查；
  2. 极端场景下（用户重试一个很老的请求，且其主记录恰好不可用时），幂等去重可能 miss，导致重复生成并重复扣费一次，概率极低。

## 四、修复内容（已提交，未部署）

`lib/db.ts::backfillGenerationClientRequestIds` 改为逐行容错：

- 单行 UPDATE 触发唯一键冲突（`code === 'ER_DUP_ENTRY'` 或 `errno === 1062`）时，跳过该行并计数，不再中止整批；
- 其他非冲突错误照常抛出；
- 结束时分别打印 `Backfilled ...` 与 `Skipped ... legacy generation row(s) ...`。

## 五、下次发布步骤

在服务器 `/opt/sanhub` 执行：

```bash
cd /opt/sanhub
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=60 sanhub
```

验证预期：

- 启动日志不再出现 `Failed to backfill generation client_request_id values`；
- 出现一条确定性提示：

```
[DB] Skipped 13 legacy generation row(s) whose client_request_id is already claimed
```

- 登录页 HTTP 200。

## 六、参考

- 升级前数据库备份：`/opt/sanhub/backups/sanhub-before-switch.sql`（2026-09-06，104MB）
- 引入该回填逻辑的版本：`4dec716`（miaotu main）
