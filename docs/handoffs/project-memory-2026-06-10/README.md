# SanHub Project Memory Handoff

## Context

Date: 2026-06-10

Local workspace:

```text
f:\sanhub
```

Production server:

```text
<SERVER_IP>
```

Production project path:

```text
/opt/sanhub
```

GitHub remote:

```text
https://github.com/i6ww/sanhub.git
```

Production branch:

```text
main
```

Latest deployed commit from this workstream:

```text
7909b7c Add chat and improve media workflows
```

The user required all production updates to preserve existing users, balances, history, media, MySQL data, and site configuration.

## Current Production Runtime

Production uses Docker Compose with MySQL.

Compose services:

```text
sanhub
mysql
```

Containers observed on production:

```text
sanhub
sanhub-mysql
```

Volumes observed on production:

```text
sanhub_sanhub_data
sanhub_sanhub_mysql
```

Public app URL:

```text
http://<SERVER_IP>:3000
```

The latest deployment was tested by the user and reported as working.

Production startup log after deployment:

```text
[SanHub] Starting server...
Next.js 14.2.33
Ready in 73ms
[MySQL] Pool created: host=mysql, port=3306, user=sanhub, database=sanhub, ssl=off, connectionLimit=50
Database initialized successfully
```

## Production Backup Created During Deployment

Before deployment, a full backup was created and then moved out of the project directory.

Backup location:

```text
/opt/sanhub-backups/backups-20260609-221933
```

Backup contents:

```text
.env.backup
docker-compose.yml.backup
mysql.sql
sanhub_data.tar.gz
```

Observed sizes:

```text
mysql.sql: 1.3G
sanhub_data.tar.gz: 11M
```

Important note:

The backup was initially created under `/opt/sanhub/backups`, which caused Docker build context bloat. It was moved to `/opt/sanhub-backups`.

The production `.dockerignore` was appended with:

```text
# Backups
backups/
*.sql
*.tar.gz
```

This local `.dockerignore` change was done directly on the server after the GitHub deployment. If this rule should be permanent, add it to the repository too.

## Deployment Commands Used

Backup:

```bash
cd /opt/sanhub

BACKUP_DIR=backups/$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"

cp .env "$BACKUP_DIR/.env.backup"
cp docker-compose.yml "$BACKUP_DIR/docker-compose.yml.backup"

docker compose exec mysql sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers --databases "$MYSQL_DATABASE"' > "$BACKUP_DIR/mysql.sql"

docker run --rm \
  -v sanhub_sanhub_data:/data \
  -v "$PWD/$BACKUP_DIR":/backup \
  alpine tar czf /backup/sanhub_data.tar.gz -C /data .
```

Move backup out of project:

```bash
cd /opt/sanhub
mkdir -p /opt/sanhub-backups
mv backups /opt/sanhub-backups/backups-$(date +%Y%m%d-%H%M%S)
```

Update and deploy:

```bash
cd /opt/sanhub

git fetch origin
git status
git pull origin main

docker compose build sanhub
docker compose up -d --no-deps sanhub
docker compose ps
docker compose logs --tail=100 sanhub
```

When Docker progress UI appeared stuck, the successful diagnostic build command was:

```bash
docker compose build --progress=plain sanhub
```

Docker printed this advisory:

```text
--progress is a global compose flag, better use `docker compose --progress xx build ...`
```

The build still completed successfully.

## Important Deployment Safety Rules

Do not run:

```bash
docker compose down -v
docker volume rm sanhub_sanhub_mysql
docker volume rm sanhub_sanhub_data
rm -rf /opt/sanhub/data
rm /opt/sanhub/.env
```

Those commands can destroy production data or configuration.

Safe app-only restart:

```bash
docker compose up -d --no-deps sanhub
```

Safe status checks:

```bash
docker compose ps
docker compose logs --tail=100 sanhub
docker compose logs --tail=100 mysql
```

## Features And Fixes Implemented In Commit 7909b7c

### 1. Grok2api video ratio fix

Issue:

When the video channel was set to `grok2api`, every selected aspect ratio produced a portrait video.

Relevant local file:

```text
lib/sora.ts
```

Work done:

- Investigated Grok2api behavior.
- Added a Python test script for real API testing.
- Fixed project-side ratio handling.
- Restored ports from `3001` back to `3000`.

Test script:

```text
scripts/test_grok2api_video.py
```

External test endpoint used during investigation:

```text
https://<SERVER_IP>:8000
```

API key used during testing:

```text
123456
```

Do not expose this key publicly.

### 2. PicUI and Lsky image bucket compatibility

Issue:

Generated image URLs sometimes showed the server IP instead of the image bucket URL.

Investigated docs:

```text
https://img.czl.net/api-docs.md
https://img.czl.net/api-docs.html
https://img.czl.net/api/v1
https://www.boltp.com/pages/api-docs
https://imgos.cn/pages/api-docs2.html
```

Relevant files:

```text
lib/picui.ts
app/admin/site/page.tsx
app/api/admin/settings/route.ts
types/index.ts
```

Changes:

- Added `lsky-v2` provider support.
- Added `storageId` field to image bucket config.
- Added Lsky upload path using `storage_id`.
- Added PicUI fallback lookup when upload response format does not directly return a usable URL.

Known risk:

Some Lsky deployments may require a boolean public/private field. A previous runtime error was:

```text
[ImageBucket] Lsky v2 upload failed: 是否公开 必须为布尔值。
```

If this returns, check the target Lsky API docs and add the correct boolean form field.

### 3. Remote media "Save As" download proxy

Issue:

History page "Save As" failed for remote images without CORS headers:

```text
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

Relevant files:

```text
lib/download.ts
app/api/download/route.ts
app/(dashboard)/history/page.tsx
app/(dashboard)/square/user/[username]/page.tsx
```

Changes:

- Added `/api/download` backend proxy.
- Client first tries direct browser fetch.
- On CORS or non-OK response, client falls back to backend proxy.
- Backend uses `fetchExternalBuffer` from `lib/safe-fetch` for SSRF protection.
- Download filename prefix changed from `sanhub-` to `miaotu-`.

Current naming examples:

```text
miaotu-${id}.png
miaotu-${id}.mp4
miaotu-${Date.now()}
```

### 4. Batch image generation limits

Relevant file:

```text
components/generator/batch-image-generation-page.tsx
```

Changes:

- Maximum batch tasks changed from `30` to `9`.
- Reference images per task support `6`.
- UI shows toast when reference image limit is exceeded.

### 5. Chat page added

Relevant files:

```text
app/(dashboard)/chat/page.tsx
components/chat/chat-page.tsx
app/api/chat/workspace/route.ts
lib/chat-completion.ts
components/layout/sidebar.tsx
components/layout/header.tsx
```

Changes:

- Added sidebar/mobile menu item under batch image generation.
- Added chat UI.
- Added local chat session history in `localStorage`.
- Added new chat action.
- Previous chat sessions are retained.
- Chat calls configured reasoning/chat models through `/api/chat/workspace`.
- Added helper for OpenAI-compatible `/v1/chat/completions` URL resolution and response parsing.

Known risks:

- If upstream returns empty content, the API may currently still treat the request as successful and deduct points.
- Balance checking and deduction are not fully atomic under concurrent chat requests.

Recommended future fix:

- Precharge balance before upstream call, then refund on upstream failure.
- Reject empty assistant content before charging or return a clear upstream error.

### 6. Admin balance additions appear in recharge records

Relevant files:

```text
lib/db.ts
types/index.ts
app/api/admin/users/[id]/route.ts
app/api/admin/users/balance/route.ts
app/admin/stats/page.tsx
```

Changes:

- Added manual payment order creation for administrator point additions.
- Recharge records display admin-added points.
- Manual orders use:

```text
provider = manual
paymentType = admin_balance
status = succeeded
paidAmountCents = 0
```

Known risk:

Balance update and manual recharge-record insertion are not transactional. If balance update succeeds but payment order insert fails, records can become inconsistent.

Recommended future fix:

- Add a database transaction wrapper for admin balance mutation plus payment order insertion.

### 7. Admin stats recharge-date filtering and scroll jump fix

Relevant file:

```text
app/admin/stats/page.tsx
```

Changes:

- Date inputs were changed from browser `date` inputs to text inputs with `YYYY-MM-DD` parsing.
- Filtering uses paid time when present:

```sql
COALESCE(NULLIF(p.paid_at, 0), p.created_at)
```

- Page no longer replaces the whole stats UI with full-page loading during filter refresh.

Issue fixed:

Typing in recharge-record filters used to jump the page to the top because the whole component was replaced by a loading state.

### 8. Delete generated image/video from create page no longer reappears

Relevant files:

```text
components/generator/image-generation-page.tsx
components/generator/video-generation-page.tsx
app/api/user/history/delete/route.ts
```

Issue:

When deleting a generated image from the create page, UI showed delete success, then the item reappeared.

Root cause:

Background refresh/polling merged stale generation results back into local state after deletion.

Changes:

- Added local deleted generation ID set.
- Recent-generation refresh ignores deleted IDs.
- Poll completion ignores deleted IDs.
- If deletion fails, ID is removed from the deleted set and item is restored.
- Single delete now returns `404` if no database row was actually deleted.

### 9. Favicon / app icon

Relevant files:

```text
app/icon.svg
app/layout.tsx
```

Changes:

- Added app icon.
- Layout now points at `/icon.svg`.

## Validation Already Performed Locally

Commands run locally before deployment:

```bash
npx tsc --noEmit
npm run lint
npm run build
```

Results:

- TypeScript passed.
- ESLint passed.
- Production build passed after clearing stale `.next` cache.

Note:

One local `npm run build` initially failed with `PageNotFoundError` for existing API routes. After deleting `.next`, the clean build passed. This was diagnosed as stale Next build cache, not missing source files.

## Validation Already Performed On Production

Production Docker build completed successfully after backups were moved out of the build context.

Successful build log included:

```text
Image sanhub-sanhub Built
```

Production app restart command:

```bash
docker compose up -d --no-deps sanhub
```

Production status:

```text
sanhub       Up
sanhub-mysql Up 4 days (healthy)
```

The user then manually tested the site and reported:

```text
测试没问题了
```

## Known Operational Notes

### Docker build context

Do not place large backup files under `/opt/sanhub`.

Bad:

```text
/opt/sanhub/backups/mysql.sql
```

Good:

```text
/opt/sanhub-backups/backups-YYYYMMDD-HHMMSS/mysql.sql
```

Reason:

Large files in project root can enter Docker build context and make `docker compose build` appear stuck.

### Docker Compose warning

Production prints:

```text
the attribute `version` is obsolete
```

This warning is harmless. It can be cleaned later by removing the top-level `version: '3.8'` from `docker-compose.yml`.

### Current local repository status

At the time this handoff was written, local workspace had:

```text
M lib/db.ts
?? docs/handoffs/
```

The `lib/db.ts` change belongs to a separate MySQL storage cleanup handoff and was not part of commit `7909b7c`.

See:

```text
docs/handoffs/mysql-storage-cleanup-2026-06-10/README.md
```

## Recommended Next Steps

1. Add backup ignores to repository `.dockerignore`.

Suggested lines:

```text
# Backups
backups/
*.sql
*.tar.gz
```

2. Fix admin balance mutation consistency.

Goal:

```text
update user balance + insert manual payment order in one database transaction
```

3. Harden chat billing.

Goal:

```text
precharge -> call upstream -> refund on failure
```

Also reject empty assistant response.

4. Confirm Lsky v2 public/private field with the actual provider docs.

If the error returns:

```text
是否公开 必须为布尔值。
```

add the provider-specific boolean field to `uploadToLskyV2Bucket`.

5. Keep production backup for several days before cleanup.

Backup path:

```text
/opt/sanhub-backups/backups-20260609-221933
```

Do not delete MySQL or media volumes.

## Quick Recovery Commands

Rollback app code to previous commit if needed:

```bash
cd /opt/sanhub
git checkout 46eda84
docker compose build sanhub
docker compose up -d --no-deps sanhub
```

Check production logs:

```bash
cd /opt/sanhub
docker compose ps
docker compose logs --tail=100 sanhub
docker compose logs --tail=100 mysql
```

Check disk and Docker usage:

```bash
df -h
docker system df
docker volume ls | grep sanhub
```

Safe build-cache cleanup:

```bash
docker builder prune -f
```

Do not use:

```bash
docker system prune --volumes
```

