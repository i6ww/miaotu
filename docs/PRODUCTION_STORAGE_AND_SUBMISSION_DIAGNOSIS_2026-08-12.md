# Production Storage And Submission Diagnosis

## Background

Date: 2026-08-12

This document records a production investigation for recurring disk pressure and image submission latency concerns.

Production environment:

```text
Project directory: /opt/sanhub
Application container: sanhub
MySQL container: sanhub-mysql
Database: MySQL 8.4
Application port: 3000
MySQL volume: sanhub_sanhub_mysql
Media volume: sanhub_sanhub_data
```

The investigation was read-first and production-data-safe. Destructive volume removal and filesystem-level binlog deletion were not used.

## Initial Symptoms

- The server root filesystem was reported as close to full again.
- Image submission felt slower again.
- Similar issues had been handled before in June and August 2026.

## Initial Disk State

Filesystem usage before cleanup:

```text
/dev/vda2: 79G total, 42G used, 34G available, 56% used
```

Docker usage before cleanup:

```text
Images: 9.962GB
Containers: 12.98MB
Local Volumes: 10.64GB
Build Cache: 12.72GB
```

Important directory sizes:

```text
/var/lib/docker/volumes/sanhub_sanhub_mysql: 7.9G
/var/lib/docker/volumes/sanhub_sanhub_data: 2.1G
/opt/adobe2api/data: 3.9G
/opt/sanhub-backups: 2.9G
/opt/sanhub: 19M
```

The project directory itself was small, so Docker build context bloat under `/opt/sanhub` was not the current root cause.

## MySQL Storage Findings

MySQL data directory:

```text
/var/lib/mysql: 7.9G
/var/lib/mysql/sanhub: 285M
```

Largest files under `/var/lib/mysql` were binary logs:

```text
binlog.000281: 1.1G
binlog.000282: 1.1G
binlog.000283: 1.1G
binlog.000284: 1.1G
binlog.000285: 1.1G
binlog.000286: 1.1G
binlog.000287: 1.1G
binlog.000288: 357M initially, later continued growing
```

Business table files were not large:

```text
generation_jobs.ibd: 136M
generations.ibd: 136M
payment_orders.ibd: 10M
```

Table-size query also confirmed business data was not the main disk consumer:

```text
generations: 102.81 MB data, 25.00 MB index
generation_jobs: 43.22 MB data, 27.91 MB index, 58.00 MB free
```

Historical large fields had not regressed:

```text
total_generations: 49281
result_url_mb: 5.37
data_url_count: 0
over_1mb: 0
over_5mb: 0
over_10mb: 0
generation_jobs.payload_mb: 0.10
orphan_jobs: 2894
```

Conclusion:

- `generations.result_url` Base64 bloat did not recur.
- `generation_jobs.payload` logical table size did not recur.
- Disk pressure mainly came from MySQL binary logs.

## Backup Before Purge

A current MySQL backup was created outside the project directory:

```text
/opt/sanhub-backups/before-binlog-purge-20260812-*/mysql-current.sql.gz
```

Observed size:

```text
mysql-current.sql.gz: 28M
```

Command used:

```sh
cd /opt/sanhub

BACKUP_DIR=/opt/sanhub-backups/before-binlog-purge-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"

docker compose exec mysql sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers --databases "$MYSQL_DATABASE"' | gzip > "$BACKUP_DIR/mysql-current.sql.gz"
```

## Binlog Cleanup

Old binary logs were purged with MySQL's official command, not by deleting files from the filesystem.

At the time of purge, the active binary log was:

```text
binlog.000288
```

Command used:

```sql
PURGE BINARY LOGS TO 'binlog.000288';
```

Result:

```text
MySQL volume: 7.9G -> 901M
Docker Local Volumes: 10.64G -> 3.125G
root filesystem: 34G available -> 41G available
```

Docker build cache was also safely pruned:

```sh
docker builder prune -f
```

Result:

```text
Build cache reclaimed: 4.219G
root filesystem available: 41G -> 45G
root filesystem usage: 56% -> 41%
```

## Binlog Growth Root Cause

After cleanup, `binlog.000288` continued to grow quickly:

```text
654868692 bytes -> 668900252 bytes in 60 seconds
growth: 14031560 bytes/min
approx: 13.4 MiB/min, 800 MiB/hour, 19 GiB/day
```

MySQL binary log configuration before mitigation:

```text
log_bin: ON
binlog_row_image: FULL
binlog_expire_logs_seconds: 86400
max_binlog_size: 1073741824
```

`SHOW BINLOG EVENTS` showed very large row events on `generation_jobs`:

```text
Table_map: sanhub.generation_jobs
Write_rows: single event around 9.5MB
Update_rows: single events around 7MB to 19MB
```

It also showed repeated DDL noise:

```text
CREATE TABLE IF NOT EXISTS image_channels
CREATE TABLE IF NOT EXISTS image_models
```

Main interpretation:

- Image queue payloads still contain inline reference images.
- Recent submission metrics showed `payloadBytes` around `7MB`.
- `generation_jobs.payload` is cleared on terminal states, but with `binlog_row_image = FULL`, row-based binary logs can record full row images for large `LONGTEXT` updates.
- This made task completion and cleanup produce large binary logs even though the logical table size stayed small.

Secondary issue:

- Repeated `CREATE TABLE IF NOT EXISTS` calls add avoidable binlog noise.
- They were not the main disk consumer compared with large row events on `generation_jobs`.

## Online Mitigation

`binlog_row_image` was changed from `FULL` to `MINIMAL`, and binary log retention was reduced from one day to one hour:

```sql
SET PERSIST binlog_row_image = 'MINIMAL';
SET PERSIST binlog_expire_logs_seconds = 3600;
FLUSH BINARY LOGS;
```

Verification on a new MySQL session:

```text
binlog_row_image: MINIMAL
binlog_expire_logs_seconds: 3600
```

After `FLUSH BINARY LOGS`, a new active binlog was created:

```text
binlog.000289
```

Old binlog was purged:

```sql
PURGE BINARY LOGS TO 'binlog.000289';
```

Current post-purge state:

```text
binlog.000289: 21M initially, later 63M
root filesystem: 45G available, 41% used
```

The application container was restarted so its MySQL connection pool would use new sessions with `binlog_row_image = MINIMAL`:

```sh
docker compose restart sanhub
```

## Mitigation Result

After switching to `MINIMAL`, binlog growth over a 60-second observation window became:

```text
63249790 bytes -> 63254287 bytes
growth: 4497 bytes/min
approx: 4.4 KiB/min
```

Compared with the earlier growth:

```text
before: about 13.4 MiB/min
after: about 4.4 KiB/min
```

Conclusion:

- The immediate disk-growth issue was mitigated successfully.
- Keeping binlog enabled with `MINIMAL` is currently enough.
- Fully disabling binlog with `--skip-log-bin` is not necessary immediately.

## Submission Latency Findings

Recent image submission metrics showed the submission path was healthy.

For large inline-reference-image payloads:

```text
payloadBytes: about 7.0MB
inlineImageCount: 2
totalDurationMs: 264ms to 677ms
createGenerationJobMs: 139ms to 378ms
parseRequestBodyMs: 32ms to 109ms
getGenerationByClientRequestIdMs: 0ms to 6ms
```

For smaller payloads:

```text
payloadBytes: 343942
totalDurationMs: 82ms

payloadBytes: 1191956
totalDurationMs: 100ms
```

Conclusion:

- The previous `clientRequestId` lookup regression did not recur.
- The indexed lookup path is working.
- Submission latency is currently proportional to payload size, mainly request parsing and `generation_jobs` insertion.
- The current large-payload path is not catastrophic, but it is the same source of MySQL/binlog write amplification.

## Generation Latency Findings

Generation execution was slower than submission and mostly dominated by upstream and media storage:

```text
upstreamDurationMs: around 46s to 97s in sampled completed jobs
mediaStorageDurationMs: around 6s to 30s in sampled completed jobs
databaseUpdateDurationMs: around 16ms to 41ms
```

Conclusion:

- User-visible waiting after submission is mostly task execution time, not submission API latency.
- The main execution latency sources are upstream generation and media download/upload.

## Current Safe State

Current operational state after mitigation:

```text
root filesystem available: 45G
root filesystem usage: 41%
binlog_row_image: MINIMAL
binlog_expire_logs_seconds: 3600
active binlog: binlog.000289
application container restarted successfully
```

No Docker volumes were deleted.

No production tables were dropped.

No `binlog.*` files were manually removed from the filesystem.

## Follow-Up Recommendations

### 1. Keep Current MySQL Mitigation

Keep:

```text
binlog_row_image = MINIMAL
binlog_expire_logs_seconds = 3600
```

Monitor occasionally:

```sh
cd /opt/sanhub

df -h
docker system df
docker compose exec mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -e "
SHOW GLOBAL VARIABLES LIKE '\''binlog_row_image'\'';
SHOW VARIABLES LIKE '\''binlog_expire_logs_seconds'\'';
SHOW BINARY LOGS;
"'
```

### 2. Avoid Immediate `--skip-log-bin`

Disabling binlog with:

```yaml
      - --skip-log-bin
```

would further reduce disk usage, but requires a MySQL restart and removes binlog-based point-in-time recovery and replication support.

Given the successful `MINIMAL` result, keep binlog enabled for now unless disk growth recurs.

### 3. Fix Queue Payload Design

Long-term code fix:

- Do not store inline Base64 reference images in `generation_jobs.payload`.
- Persist uploaded reference images to local media storage or object storage during submission.
- Store only stable references in the queue payload.
- Let workers resolve those references before calling upstream providers.

Expected benefits:

- Lower submission latency for large reference-image requests.
- Smaller `generation_jobs` inserts and updates.
- Smaller binlog even under `FULL`.
- Smaller backups.
- Less memory pressure in queue workers.

### 4. Reduce Repeated DDL Noise

`SHOW BINLOG EVENTS` showed repeated:

```text
CREATE TABLE IF NOT EXISTS image_channels
CREATE TABLE IF NOT EXISTS image_models
```

This should be reviewed in code. The likely direction is to ensure database initialization and channel-table initialization run once per process instead of being triggered repeatedly by ordinary read/write paths.

### 5. Keep Backup Discipline

Continue storing production backups outside the project directory:

```text
/opt/sanhub-backups
```

Do not store large backups under:

```text
/opt/sanhub
```

This avoids Docker build context bloat.

## Commands To Avoid

Do not run these for this class of issue:

```sh
docker compose down -v
docker volume rm sanhub_sanhub_mysql
docker volume rm sanhub_sanhub_data
docker system prune --volumes
rm /var/lib/docker/volumes/sanhub_sanhub_mysql/_data/binlog.*
```

Use MySQL commands for binlog cleanup:

```sql
PURGE BINARY LOGS TO 'binlog.xxxxxx';
```

