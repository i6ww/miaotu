# 2026-09-16 开发改动总结

本文档整理 2026-09-16 的代码改动、线上排查与部署验证要点，便于后续部署、回归测试和问题追踪。

## 主要改动

### 生成图片结果统一返回 R2 / S3 直链（方案 A）

**问题**：图片创作生成的结果，URL 是应用自身的代理地址 `/cache/s3?key=...&bucket=...`，而视频、参考图已经是对象存储直链。表现为：分享出去的图片链接依赖应用在线、流量与带宽都压回服务器、第三方客户端拉取也走服务器中转。

**根因**：图片结果落库走 `saveMediaAsync`（`lib/media-storage.ts`），它的两个上传分支都没有传 `preferDirectS3Url`：

- 远程 URL 分支 → `uploadBufferToImageBucket`
- base64 分支 → `uploadToPicUI`

而 `uploadToS3Bucket` 中决定 URL 形态的开关正是它（`lib/picui.ts:421`）：

```ts
return options?.preferDirectS3Url
  ? buildDirectS3PublicUrl(bucket, payload.objectKey)
  : buildS3CacheUrl(bucket, payload.objectKey, options);
```

未传 → 走 `buildS3CacheUrl`，产出 `/cache/s3?key=...&bucket=...`（有 `publicBaseUrl` 时拼成 `https://<站点>/cache/s3?...`），即应用自己的代理路由。

视频（`saveVideoMediaPreferS3` → `uploadBufferToS3CompatibleBucket` 内部固定 `preferDirectS3Url: true`）与参考图（`lib/image-generator.ts`、`lib/sora.ts`）本来就是直链，本次把图片这条链路补齐一致。

**改动**：仅 `lib/media-storage.ts` 两处 options

```ts
{ preferDirectS3Url: true, requirePublicBaseUrl: true }
```

`publicBaseUrl` 不再传入 —— 直链由桶自身配置的 `publicBaseUrl` 拼接（`buildDirectS3PublicUrl`，`lib/picui.ts:386`）。

**为什么带 `requirePublicBaseUrl: true`**：`lib/picui.ts:406` 规定「`preferDirectS3Url` + `requirePublicBaseUrl` 且桶未配 `publicBaseUrl` → 返回 null」，即桶没配自定义域名时，不去拼 `endpoint/bucket/key` 这种会 403 的私有地址，而是让调用方安全回退：

- 远程 URL 分支 → 保留上游原始 URL
- base64 分支 → 落本地文件（`saveMediaToFile`）

**改动后行为**

| 场景 | 改动前 | 改动后 |
| --- | --- | --- |
| 新生成图片（桶已配 `publicBaseUrl`） | `/cache/s3?key=...` | `https://<桶 publicBaseUrl>/<objectKey>` |
| 新生成图片（桶未配 `publicBaseUrl`） | 403 半残直链 | 回退：上游原始 URL / 本地文件 |
| 历史记录 | 不变 | 不变，老 `/cache/s3?...` 仍可经代理访问 |
| 视频 / 参考图 | 直链 | 不变 |
| lsky-v2 / picui 桶 | 不受影响 | 不受影响（非 S3 桶忽略这些 options） |

**影响面**：只改 URL 生成策略，不涉及存储写入，不改数据库结构；失败是回退而不是抛错。

**提交**：`7a08591 feat(media): return direct S3/CDN URLs for generated image results`（`lib/media-storage.ts`，+6 / -2）

### 历史数据批量转直链

历史记录的 `/cache/s3?...` 不会自动变化，需要时运行迁移脚本：

```bash
node scripts/migrate-generation-result-media.mjs --dry-run  --prefer-direct-s3-url
node scripts/migrate-generation-result-media.mjs --execute  --prefer-direct-s3-url
```

脚本默认 dry-run（只预览不写库）；`--prefer-direct-s3-url` 表示重传后把结果写成直链。其他可用参数：`--limit`、`--batch-size`、`--min-bytes`、`--sleep-ms`、`--max-failures`、`--local-only`、`--public-base-url`。

## 线上排查

### 图片桶配置的存储位置（澄清）

**现象**：在服务器执行

```sql
SELECT id, provider, enabled, public_base_url FROM image_buckets;
```

报错 `ERROR 1146 (42S02): Table 'sanhub.image_buckets' doesn't exist`。

**结论**：项目**没有** `image_buckets` 表。图片桶配置以 JSON 形式存放在 `system_config` 表的两个字段中：

- `image_storage_buckets`（LONGTEXT，桶数组 JSON）
- `image_storage_default_bucket_id`（默认桶 id）

对应代码：`lib/db.ts` 中的建表语句，以及 `parseImageStorageBuckets` / `sanitizeImageBucket` / `resolveImageStorage` 等解析函数。

**正确查询**：

```bash
cd /opt/sanhub
docker compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SELECT image_storage_default_bucket_id, image_storage_buckets FROM $MYSQL_DATABASE.system_config WHERE id = 1\G"'
```

**如何判断桶是否已配公开域名**：看返回 JSON 里每个桶的 `publicBaseUrl` 字段（同时确认 `provider`、`enabled`、`bucketName`）：

- 有值（如 `https://cdn.xxx.com`）→ 本次改动立即生效为直链
- 为空 → 图片会回退成「上游原始 URL / 本地文件」，需先给桶配上公开访问域名，直链才有意义

## 部署与验证

```bash
cd /opt/sanhub
git fetch origin && git merge --ff-only origin/main
docker compose up -d --build
docker compose logs --tail=60 sanhub | grep -E 'MediaStorage|ERROR|Ready'
```

**验证要点**：生成一张图后看日志。

- 出现 `[MediaStorage] Uploaded to remote bucket: https://<直链域名>/...` → 命中直链分支
- 出现 `[MediaStorage] Remote upload failed, falling back to local file storage` → 桶未配 `publicBaseUrl` 或上传失败，需检查桶配置

## 其他记录

- 本地 dev 服务器（3000 端口）已停止，本地临时日志 `dev.log` 已清理。
- 工作区中与本次改动无关、**尚未提交**的内容：`img/admin.png`、`img/home.png`、`img/image.png`、`img/video.png` 处于已删除状态（README 可能引用，会导致 GitHub 上破图，未提交）；`api-integration-guide(36).md`、`scripts/__pycache__/` 未跟踪。
- `.env`、`*.log` 均已被 `.gitignore` 覆盖，不会误入库。

## 待办

- [ ] 确认线上默认图片桶是否配置了 `publicBaseUrl`（见上文查询语句）。
- [ ] 视需要执行历史数据迁移（`--prefer-direct-s3-url`）。
- [ ] `lib/image-generator.ts` 参考图上传只传了 `preferDirectS3Url`、未带 `requirePublicBaseUrl`，属同类隐患，考虑一并加固。
- [ ] 处理工作区遗留项：`img/*.png` 删除的取舍、`scripts/__pycache__/` 加入 `.gitignore`。
