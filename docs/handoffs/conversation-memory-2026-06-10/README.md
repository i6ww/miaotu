# SanHub Conversation Memory Handoff

## 目的

这份文档用于把当前对话中围绕 SanHub 项目的主要背景、已完成改动、线上部署决策、问题排查结论和后续注意事项整理成可交接的项目记忆。

日期：2026-06-10

本地工作区：

```text
f:\sanhub
```

GitHub 仓库：

```text
https://github.com/i6ww/sanhub.git
```

生产服务器当前 IP：

```text
<SERVER_IP>
```

生产项目路径约定：

```text
/opt/sanhub
```

## 当前仓库状态

当前主分支：

```text
main
```

本轮对话中最近已推送的提交：

```text
b95b1f8 Use port 3001 for Docker server
```

另一个已推送的相关提交：

```text
951bdb7 Move recharge page into navigation
```

当前本地工作区在写这份文档前已有额外未提交内容：

```text
M lib/db.ts
?? docs/handoffs/
```

注意：

- `lib/db.ts` 是已有本地修改，和本次“整理交接文档”请求无关，不应误还原。
- `pay.txt` 和 `pay python版.txt` 曾经是本地未跟踪支付示例文件，之前提交时明确没有纳入 Git。
- `docs/handoffs/` 当前包含交接文档目录，如果需要纳入仓库，需要后续单独提交。

## 端口与部署决策

用户明确要求 Docker 容器内部端口从 `3000` 改为 `3001`。

已完成并推送：

- `Dockerfile`
  - `EXPOSE 3001`
  - `ENV PORT=3001`
- `docker-compose.yml`
  - 默认端口映射改为 `${APP_PORT:-3001}:3001`
- `docker-entrypoint.sh`
  - 默认 `NEXTAUTH_URL` 改为 `http://localhost:3001`
- `.env.example`
  - 默认 `NEXTAUTH_URL` 改为 `http://localhost:3001`
- `README.md`
  - Docker 部署示例端口同步改为 `3001`

重要区别：

- Docker 生产容器内部监听端口现在是 `3001`。
- 本地 `npm run dev` 如果没有显式设置 `PORT`，Next.js 默认仍可能监听 `3000`。如果需要本地也监听 `3001`，应使用环境变量或修改 dev 脚本。

生产环境 `.env` 推荐：

```env
APP_PORT=3001
NEXTAUTH_URL=http://<SERVER_IP>:3001
MYSQL_POOL_SIZE=50
TRUST_PROXY=true
MEDIA_FILE_STORAGE=true
```

如果后续接域名和 HTTPS：

```env
NEXTAUTH_URL=https://www.miaotu.one
```

Nginx 反代目标应指向：

```text
http://127.0.0.1:3001
```

## Ubuntu 新服务器部署流程

安装基础环境：

```bash
sudo apt update
sudo apt install -y git curl ca-certificates openssl

curl -fsSL https://get.docker.com | sudo sh
sudo apt install -y docker-compose-plugin

sudo systemctl enable docker
sudo systemctl start docker
```

拉取项目：

```bash
cd /opt
git clone https://github.com/i6ww/sanhub.git
cd sanhub
```

生成 `.env`：

```bash
NEXTAUTH_SECRET=$(openssl rand -hex 32)
ADMIN_PASSWORD=$(openssl rand -hex 12)
MYSQL_PASSWORD=$(openssl rand -hex 16)
MYSQL_ROOT_PASSWORD=$(openssl rand -hex 16)
V1_API_KEY=$(openssl rand -hex 24)

cat > .env <<EOF
APP_PORT=3001
NEXTAUTH_URL=http://<SERVER_IP>:3001
NEXTAUTH_SECRET=$NEXTAUTH_SECRET

ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=$ADMIN_PASSWORD

MYSQL_DATABASE=sanhub
MYSQL_USER=sanhub
MYSQL_PASSWORD=$MYSQL_PASSWORD
MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD
MYSQL_POOL_SIZE=50

MEDIA_FILE_STORAGE=true
TRUST_PROXY=true

V1_API_KEY=$V1_API_KEY
EOF
```

启动：

```bash
docker compose up -d --build
docker compose logs -f sanhub
```

访问：

```text
http://<SERVER_IP>:3001
```

后续修改 `.env`：

```bash
cd /opt/sanhub
nano .env
docker compose up -d
```

如果不确定是否需要重建：

```bash
docker compose up -d --build
```

数据库密码注意事项：

- MySQL 首次初始化后，不建议直接改 `MYSQL_PASSWORD` 或 `MYSQL_ROOT_PASSWORD`。
- 直接改可能导致应用连接不上已有 MySQL 数据卷。

## 生产数据安全规则

不要执行：

```bash
docker compose down -v
docker volume rm sanhub_sanhub_mysql
docker volume rm sanhub_sanhub_data
rm -rf /opt/sanhub/data
rm /opt/sanhub/.env
```

安全更新应用：

```bash
cd /opt/sanhub
git pull origin main
docker compose up -d --build
docker compose logs -f sanhub
```

安全仅重启应用容器：

```bash
docker compose restart sanhub
```

检查状态：

```bash
docker compose ps
docker compose logs --tail=100 sanhub
docker compose logs --tail=100 mysql
```

## 已完成的主要功能与改动

### 1. 主题切换

用户提出项目只有暗黑模式，需要增加主题切换功能。

后续出现过 hydration 错误：

```text
Hydration failed because the initial UI does not match what was rendered on the server.
In HTML, <script> cannot be a child of <html>.
```

结论：

- 这类错误通常来自在 `html` 下直接插入脚本或服务端/客户端初始主题状态不一致。
- 主题脚本应该放在合法位置，且需要避免服务端和客户端首次渲染不一致。

### 2. 工作空间入口

用户找不到工作空间按钮，要求放入菜单，并进一步要求放到“创作”下面。

涉及页面：

```text
app/(dashboard)/workspace/page.tsx
app/(dashboard)/workspace/[id]/page.tsx
components/layout/sidebar.tsx
app/(dashboard)/layout.tsx
```

后续在服务器上工作空间添加节点时出现：

```text
Cannot read properties of undefined (reading 'writeText')
crypto.randomUUID is not a function
```

结论：

- `navigator.clipboard.writeText` 在非安全上下文或浏览器限制下可能不可用。
- `crypto.randomUUID` 在部分老浏览器或非安全上下文下可能不可用。
- 如果生产使用 HTTPS，通常可以解决一部分 Web API 不可用问题。
- 更稳妥的代码层面需要添加能力检测和 fallback。

### 3. adobe2api 图生图参考图

用户多次反馈 adobe2api 渠道图生图参考图无法正确传输。

重要结论：

- 用户提供的 Python 示例表明 adobe2api 的 OpenAI 兼容接口支持 `data:image/...;base64,...` 形式的参考图。
- 请求格式为 `messages[].content[]`，其中图片项是：

```json
{
  "type": "image_url",
  "image_url": {
    "url": "data:image/png;base64,..."
  }
}
```

- 不应依赖只读 Markdown 文档判断，应以 adobe2api 项目代码和真实接口行为为准。
- 曾经有一个提交思路是 `2bc9003 Serve adobe2api reference images as URLs`，后来用户确认 base64 方案确实可用，并要求撤销该提交。
- adobe2api 项目地址后来确认应为：

```text
https://github.com/i6ww/Adobe2apinew.git
```

而不是旧的：

```text
https://github.com/i6ww/adobe2api.git
```

### 4. adobe2api 异步与并发认知

用户提到 adobe2api 自己的任务接口：

```text
POST /api/v1/generate
GET /api/v1/generate/{task_id}
```

并指出内部使用后台线程执行任务。

结论：

- 这个接口属于真正的“提交任务 + 轮询状态”异步模式。
- SanHub 早期同步等待上游生成时，如果等待超过约 `100` 秒就会提示失败，而 adobe2api 后台可能 `150` 秒才成功。
- 这说明项目需要更长超时，或更理想地改成异步任务轮询。
- “全局图片并发 20”表示同时在跑的任务数量，不是每分钟 20 个。
- 如果 adobe2api 后端号池可承受 20 条任务同时生成，SanHub 侧应通过队列或并发闸门把同时转发的任务限制在 20 左右。

### 5. 生成任务队列与并发方案

围绕 2 核 8G、200M 峰值带宽服务器，用户预估：

- 注册用户几百人。
- 同时生成图片约 100 人。
- adobe2api 后端可承受 20 条任务同时生成。

结论：

- Web 请求并发和生成任务并发需要拆开看。
- 2 核 8G 可以承载普通页面访问和中等 API 请求，但不能让 100 个生图请求全部同步压到上游。
- 推荐方案是 SanHub 内部增加任务队列：
  - 用户提交后立即创建任务。
  - 队列限制实际执行并发，例如 20。
  - 前端轮询任务状态。
  - 参数错误和余额不足不重试。
  - 网络错误、服务繁忙、上游超时可重试。

后续用户要求按该方案修改本项目，不修改 adobe2api。

### 6. 在线充值功能

用户要求增加在线充值：

- 用户可以在网站充值积分。
- 比例：`1` 人民币 = `100` 积分。
- 用户可以选择充值额度。
- 管理后台新增支付设置。
- 支付方式参考易支付文档和本地示例：

```text
pay.txt
pay python版.txt
```

后续改动：

- 用户充值页面最初在“设置 -> 积分兑换”里。
- 后来用户要求不放设置里，改为菜单栏“设置”上方。
- 已新增独立充值页面：

```text
app/(dashboard)/recharge/page.tsx
```

- 设置页移除了充值卡片：

```text
app/(dashboard)/settings/page.tsx
```

- 菜单新增在线充值入口：

```text
components/layout/sidebar.tsx
components/layout/header.tsx
```

- 易支付同步返回从 `/settings` 改到 `/recharge`：

```text
app/api/payments/return/easypay/route.ts
```

相关提交：

```text
951bdb7 Move recharge page into navigation
```

### 7. 支付回调与返回地址

用户测试充值成功后发现返回到了：

```text
https://0.0.0.0:3000/settings?payment=success&message=success
```

结论：

- 回调或同步返回地址生成时不能使用容器内部监听地址 `0.0.0.0`。
- 应使用用户实际访问 origin，或 `.env` 中的 `NEXTAUTH_URL` / 站点公网 URL。
- 后续同步返回页已改为 `/recharge`。
- 后续应继续确认支付异步 POST 回调是服务端验签并更新订单状态，而不是依赖浏览器同步跳转。

### 8. 用户充值记录、消费记录和后台统计

用户要求：

- 用户能看到自己的充值记录。
- 用户能看到自己的消费记录。
- 管理后台“数据统计”里看到用户充值记录。
- 后台统计日充值总额、周充值总额、月充值总额。

后续优化建议：

- 后台充值记录需要分页和筛选。
- 筛选维度：用户、状态、时间。
- 充值统计应以已支付时间为准，不应仅以创建时间为准。

### 9. 批量生图

用户要求新增批量生图：

- 支持一次上传多个提示词或图片。
- 支持批量生成图片。
- 位置放在菜单栏“创作”下面。
- 开始按钮样式和创作页“立即生成”保持一致。
- 每个任务可单独设置模型，也可以统一设置模型。

后续优化建议：

- 增加“保存批次”。
- 用户下次回来能看到一次批量任务整体批次，而不是散落在历史记录中。
- 对批量任务数量设置上限，防止单用户一次提交过多任务压垮队列。

已推送过的相关提交：

```text
554c459 Improve batch image generation layout
```

### 10. 生图报错提示优化

用户要求：

- 生图报错提示更通俗易懂。
- 避免技术术语。
- 明确问题原因。
- 给用户可操作建议。
- 统一报错提示样式。

设计结论：

- 前端展示应把上游错误映射成用户可理解的分类。
- 例如：
  - 余额不足：提示充值。
  - 参数错误：提示检查提示词、尺寸、参考图。
  - 服务繁忙：提示稍后再试或任务排队中。
  - 网络超时：提示系统仍可能在后台处理，建议稍后查看历史。

### 11. 注册邮箱验证码和 SMTP 配置

用户要求：

- 用户注册输入邮箱时，需要邮箱验证码。
- 当前没有邮箱验证码。
- 管理后台“网站配置”里可以配置 SMTP，例如 `smtp.gmail.com`。

已做过相关开发和本地运行验证。

用户后来问 `AUTH LOGIN` 的含义。

结论：

- `AUTH LOGIN` 是 SMTP 登录认证机制之一。
- 它表示邮件客户端向 SMTP 服务器使用用户名和密码进行登录。
- Gmail 通常需要应用专用密码或 OAuth，不应直接使用普通账号密码。

### 12. 新用户赠送积分

用户询问注册页面“新用户赠送 100 积分”是写死还是可配置。

需要后续复核点：

- 检查注册逻辑中初始积分字段。
- 检查管理后台网站配置是否已有 `signupBonus`、`registerBonus`、`initialBalance`、`welcomeCredits` 等配置项。
- 如果写死，建议改成网站配置项，并给后台配置页面加输入框。

### 13. 普通验证码逻辑

用户要求找普通验证码逻辑。

需要后续复核点：

- 搜索关键词：

```bash
rg -n "captcha|verify|code|验证码|turnstile|recaptcha|hcaptcha" app components lib
```

- 重点看登录、注册、发送邮箱验证码相关 API。

## 已排查的问题结论

### 1. 402 Payment Required

用户早期生图报错：

```text
POST http://localhost:3000/api/generate/image 402 Payment Required
```

结论：

- 这是业务层返回的余额或积分不足，不是浏览器网络错误。
- 需要通过充值、赠送积分、调整模型价格或后台手动加余额解决。

### 2. 图片下载 CORS 错误

用户在历史页下载远程图片时报错：

```text
Access to fetch at 'https://free.picui.cn/...' from origin 'https://www.miaotu.one' has been blocked by CORS policy
No 'Access-Control-Allow-Origin' header is present
```

结论：

- 浏览器前端直接 `fetch` 第三方图床图片时，受 CORS 限制。
- 图片能在 `<img>` 里显示，不代表能被前端 `fetch` 后下载。
- 解决方式：
  - 后端增加下载代理接口，由服务器请求远程图片再返回给浏览器。
  - 或让图床返回正确 CORS 响应头。
  - 或生成时把图片存到自己可控的媒体存储。

### 3. 413 Content Too Large

用户生图上传参考图时报错：

```text
POST https://<SERVER_IP>/api/generate/image 413 Content Too Large
```

结论：

- 请求体太大，被 Nginx、Next.js、反代或应用请求体限制拦截。
- `client_max_body_size 50m;` 可以提升 Nginx 层限制。
- 多人同时上传参考图时，限制变大不会直接导致错误，但会增加内存、带宽和上游压力。
- 更稳妥方案：
  - 前端限制单图大小和总大小。
  - 上传前压缩参考图。
  - 后端限制 batch 数量和总 payload。
  - 队列限制同时处理任务数。

### 4. 100 秒超时但上游还在生成

用户发现：

- SanHub 等待超过约 `100` 秒后提示失败。
- adobe2api 后台还在生成。
- 可能 `150` 秒才成功。

结论：

- 同步 HTTP 等待不适合长时间生成。
- 短期可把超时调大。
- 长期应该改为异步任务：
  - 提交任务。
  - 返回任务 ID。
  - 前端轮询状态。
  - 生成成功后再扣最终状态或展示结果。

### 5. HTTPS 与浏览器安全 API

用户问工作空间错误是不是换成 HTTPS 就可以。

结论：

- HTTPS 可以解决很多浏览器安全上下文 API 不可用问题。
- 但代码仍应做能力检测：
  - `navigator.clipboard?.writeText`
  - `crypto.randomUUID`
- 应提供 fallback，避免老浏览器或特殊环境直接崩溃。

### 6. adobe2api 容器名冲突

用户部署 Adobe2apinew 时遇到：

```text
Conflict. The container name "/adobe2api" is already in use
```

结论：

- 旧容器仍占用同名容器名。
- 处理前应确认旧容器是否需要保留。
- 常见安全处理：

```bash
docker ps -a --filter "name=adobe2api"
docker stop adobe2api
docker rm adobe2api
docker compose up -d --build
```

不要删除不确定的数据卷。

## 安全与稳定性优化

### 1. `/api/v1/*` API Key 默认放行风险

用户关注：

```text
lib/v1.ts
```

问题：

- 如果 `V1_API_KEY` 和 `API_KEY` 都没有配置，旧逻辑可能默认允许访问。
- 生产环境忘记配置时，外部用户可直接调用 v1 生图/视频接口，消耗上游额度和服务器资源。

已要求修改：

- 生产环境应强制要求 `V1_API_KEY`。
- 没配置时默认拒绝访问，而不是放行。

后续部署注意：

```env
V1_API_KEY=replace-with-a-strong-random-key
```

### 2. 生产弱密码启动校验

用户要求先做：

- 生产弱密码启动校验。
- 支付 POST 回调。
- 批量任务数量上限。
- 生产备份和恢复流程。

已有方向：

- `docker-entrypoint.sh` 中对生产环境秘密值做必填、长度和默认弱值校验。
- 避免生产环境继续使用 `sanhub123`、`change-this-password`、默认 MySQL 密码等。

### 3. 支付 POST 回调

原则：

- 支付成功不能只依赖浏览器同步返回。
- 必须以服务端 POST notify 为准。
- 回调必须验签。
- 订单更新需要幂等。
- 已支付订单不能重复加积分。

### 4. 生产备份和恢复

建议备份内容：

- `.env`
- `docker-compose.yml`
- MySQL dump
- 媒体数据 volume

示例：

```bash
cd /opt/sanhub

BACKUP_DIR=/opt/sanhub-backups/backup-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"

cp .env "$BACKUP_DIR/.env.backup"
cp docker-compose.yml "$BACKUP_DIR/docker-compose.yml.backup"

docker compose exec mysql sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers --databases "$MYSQL_DATABASE"' > "$BACKUP_DIR/mysql.sql"

docker run --rm \
  -v sanhub_sanhub_data:/data \
  -v "$BACKUP_DIR":/backup \
  alpine tar czf /backup/sanhub_data.tar.gz -C /data .
```

不要把大备份文件放在 `/opt/sanhub` 项目目录内，否则 Docker build context 会变大。

### 5. MySQL 存储清理

已有单独 handoff：

```text
docs/handoffs/mysql-storage-cleanup-2026-06-10/README.md
```

核心发现：

- MySQL binary logs 占用大量空间。
- `generation_jobs.payload` 因存储 base64 请求体占用较大。
- 删除历史时可能留下 orphan jobs。

需要结合该文档继续处理，不在本文件重复展开。

## 本地开发与验证记录

本地曾启动 dev server：

```text
http://localhost:3000
```

当时日志显示：

```text
Next.js 14.2.33
Local: http://localhost:3000
Environments: .env.local
Ready
```

曾跑通过：

```bash
npm run lint
npx tsc --noEmit
git diff --check
```

这些验证是在当时相关改动后执行的；当前工作区如果继续修改，应重新执行。

## Git 操作记录

已推送在线充值入口提交：

```bash
git add "app/(dashboard)/settings/page.tsx" "app/(dashboard)/recharge/page.tsx" "app/api/payments/return/easypay/route.ts" "components/layout/header.tsx" "components/layout/sidebar.tsx"
git commit -m "Move recharge page into navigation"
git push origin main
```

提交：

```text
951bdb7 Move recharge page into navigation
```

已推送 Docker 端口提交：

```bash
git add .env.example Dockerfile README.md docker-compose.yml docker-entrypoint.sh
git commit -m "Use port 3001 for Docker server"
git push origin main
```

提交：

```text
b95b1f8 Use port 3001 for Docker server
```

## 当前后续建议

优先级较高：

1. 确认生产环境已经拉到 `b95b1f8`，并重新构建 Docker 镜像。
2. 检查 `.env` 是否同步为 `APP_PORT=3001` 和正确 `NEXTAUTH_URL`。
3. 如果使用 HTTPS，Nginx 反代到 `127.0.0.1:3001`。
4. 修复或确认 `lib/db.ts` 当前本地修改归属，不要误提交无关改动。
5. 如果要提交 handoff 文档，单独提交 `docs/handoffs/conversation-memory-2026-06-10/README.md`。

中期建议：

1. 把长耗时生图改为异步任务轮询。
2. 为生成队列设置全局并发、单用户并发和批量任务上限。
3. 为第三方图片下载增加后端代理，解决 CORS 下载问题。
4. 为参考图上传增加前端压缩和后端总大小限制。
5. 对支付订单和余额变更增加事务与幂等保护。
6. 将新用户赠送积分改为后台可配置项。
7. 给工作空间中的剪贴板和 UUID 逻辑增加 fallback。

## 给下一位接手者的提醒

- 用户偏好直接落地，不喜欢只给泛泛方案。
- 涉及生产数据时必须先备份，避免删除 Docker volume。
- 不要提交本地支付示例文本，除非用户明确要求。
- 不要在文档或代码中泄露 API Key、SMTP 密码、数据库密码。
- 线上端口策略已经从 Docker 内部 `3000` 改成 `3001`，后续部署文档和 Nginx 配置要保持一致。
