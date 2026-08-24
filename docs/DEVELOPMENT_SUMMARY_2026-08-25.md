# 2026-08-25 开发改动总结

本文档整理 2026-08-25 的主要开发、调试与验证内容，便于后续部署、回归测试和问题追踪。

## 主要改动

### 创作入口调整

- 将原有“创作”入口拆分为独立菜单：
  - 图片创作：`/image`
  - 批量生图：`/batch-image`
  - 视频创作：`/video`
- 更新桌面侧边栏与移动端底部导航。
- 将“在线充值”菜单改为“充值和兑换”，移动端使用短标签“充兑”。

### Minimax H3 视频模型接入

- 新增 `minimax-h3` 视频渠道类型与后台渠道配置支持。
- 支持 Minimax H3 的视频创建、查询和内容获取流程。
- 请求格式对齐文档要求：
  - `reference_images` 使用 `{ url }` 对象数组。
  - `reference_videos` 使用 URL 字符串数组。
  - `reference_audios` 使用 URL 字符串数组。
  - 只传 `size`，不额外传 `resolution` 或 `aspect_ratio`。
- 增加 768P / 1080P、比例、时长和计费相关的模型归一化逻辑。
- 增加参考图请求日志，便于确认最终发送到上游的 payload。

### 参考音视频上传与校验

- 新增参考音视频上传接口：
  - `app/api/generate/sora/reference-media/route.ts`
- 参考视频和参考音频上传前会先做时长校验：
  - 参考视频最多 3 条，每条 2 到 15 秒。
  - 参考音频最多 3 条，每条 2 到 15 秒。
- 手动填写远程参考音视频 URL 时，会在扣费前下载并校验时长。
- 错误提示中文化，例如“参考音频时长需在 2～15 秒之间，当前检测为 31.71 秒。”
- 新增音视频时长解析工具：
  - `lib/audio-duration.ts`

### R2 / S3 兼容存储策略

- 生成视频优先上传到启用的 S3 兼容桶 / Cloudflare R2。
- 视频不再落本地文件作为兜底。
- 如果 R2 不可用或缺少 Public Base URL：
  - 不判定任务失败。
  - 不退款。
  - 保留上游返回的原始视频 URL。
- 历史记录和状态接口调整：
  - 已经是 `http://` 或 `https://` 的公开视频地址原样返回。
  - 只有 `data:`、`file:`、旧 `/v1/videos/.../content` 这类地址才使用 `/api/media/{id}` 代理。
- R2 / S3 上传对象的缓存头改为 7 天：
  - `Cache-Control: public, max-age=604800`
- `/cache/s3` 代理响应缓存也同步改为 7 天。

### 充值、兑换与积分购买链接

- 将“积分兑换”从设置页移动到“在线充值”页。
- 充值页左侧整合：
  - 当前余额
  - 积分兑换
  - 积分购买外链
- 后台“网站配置”新增可配置项：
  - `pointsPurchaseUrl`
- 前台只在链接为合法 `http(s)` URL 时显示“积分购买”按钮。
- “积分购买”按钮增强为醒目的 CTA 样式。

### 管理后台生成记录优化

- 修复管理后台“生成记录”搜索时每输入一个字都会触发整页刷新/加载状态的问题。
- 增加请求序号保护，避免旧请求覆盖新结果。

### 本地与媒体访问行为确认

- 确认 `/api/media/{id}` 对公网视频 URL 只做重定向，不会把远程视频写入本地。
- 确认删除 R2 对象后仍可播放的原因通常是 Cloudflare CDN 或浏览器缓存。
- 对已上传旧对象，若仍带一年缓存，需要 Cloudflare Purge 或重新上传/改元数据才能立即生效。

## 关键文件

- `components/layout/sidebar.tsx`
- `components/layout/header.tsx`
- `app/(dashboard)/recharge/page.tsx`
- `app/(dashboard)/settings/page.tsx`
- `app/admin/site/page.tsx`
- `app/admin/generations/page.tsx`
- `app/admin/video-channels/page.tsx`
- `app/api/generate/sora/route.ts`
- `app/api/generate/sora/reference-media/route.ts`
- `app/api/generate/status/[id]/route.ts`
- `app/api/user/history/route.ts`
- `app/api/v1/videos/route.ts`
- `app/api/v1/videos/[video_id]/route.ts`
- `app/api/v1/videos/[video_id]/content/route.ts`
- `app/cache/s3/route.ts`
- `components/generator/video-generation-page.tsx`
- `lib/audio-duration.ts`
- `lib/media-storage.ts`
- `lib/picui.ts`
- `lib/sora.ts`
- `lib/video-model-normalizer.ts`
- `lib/db.ts`
- `lib/site-config.ts`
- `types/index.ts`

## 验证情况

本地已执行并通过：

- `npx tsc --noEmit`
- `npm run lint`

另做过以下人工/命令行验证：

- 检查生成视频记录的数据库 `result_url`，确认 R2 URL 已正确写入。
- 检查历史记录接口和状态接口的 URL 转换逻辑。
- 检查 Cloudflare CDN 响应头，确认旧对象仍可能因为边缘缓存命中而可访问。
- 检查本地 `data/media`，确认指定视频没有本地副本。
- 扫描待提交内容中的常见真实密钥模式，未发现真实 API key。

## 部署与回归建议

- 部署后进入后台“网站配置”，填写“积分购买链接”并保存。
- 在用户端“充值和兑换”页面确认：
  - 充值功能正常。
  - 兑换码兑换成功后余额刷新。
  - 积分购买按钮可打开配置的外部链接。
- 新生成一个视频，确认：
  - R2 对象 `Cache-Control` 为 7 天。
  - 生成记录资源地址显示 R2/CDN 地址。
  - 未配置可用 R2 时任务保留上游原始视频 URL。
- 使用 Minimax H3 测试参考图、参考视频、参考音频请求，重点观察服务端日志中的最终 payload。
