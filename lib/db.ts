/* eslint-disable no-console */
import type { User, Generation, SystemConfig, SafeUser, PricingConfig, ChatModel, ChatSession, ChatMessage, CharacterCard, Workspace, WorkspaceData, WorkspaceSummary, ImageBucketConfig, ImageStorageConfig, EmailVerificationConfig, PaymentConfig, PaymentOrder, PaymentOrderListResult, PaymentOrderStatus, PaymentOrderSummary, ConsumptionRecord, GenerationBatchSummary, GenerationJob, GenerationQueueConfig } from '@/types';
import { generateId } from './utils';
import bcrypt from 'bcryptjs';
import { createDatabaseAdapter, type DatabaseAdapter } from './db-adapter';
import { cache, CacheKeys, CacheTTL, withCache } from './cache';
import { buildSafeVideoModels } from './video-model-normalizer';

// ========================================
// 数据库连接（支持 SQLite �?MySQL�?
// ========================================

let adapter: DatabaseAdapter | null = null;

function getAdapter(): DatabaseAdapter {
  if (!adapter) {
    adapter = createDatabaseAdapter();
    console.log(`[DB] 使用数据库类�? ${process.env.DB_TYPE || 'sqlite'}`);
  }
  return adapter;
}

function isMySqlDatabase(): boolean {
  return (process.env.DB_TYPE || 'sqlite').toLowerCase() === 'mysql';
}

function getLocalMediaFilenameFromResultUrl(resultUrl: string): string | null {
  const trimmed = resultUrl.trim();
  if (!trimmed.startsWith('file:')) return null;

  const rawFilename = trimmed.slice(5).trim();
  if (!rawFilename) return null;

  const normalized = rawFilename.replace(/\\/g, '/').split('/').pop() || '';
  return normalized || null;
}

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function normalizeClientRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed || !CLIENT_REQUEST_ID_PATTERN.test(trimmed)) return null;

  return trimmed;
}

function extractClientRequestIdFromParams(params: unknown): string | null {
  const parsed =
    typeof params === 'string'
      ? parseJsonValue<Record<string, unknown>>(params, {})
      : params && typeof params === 'object'
        ? (params as Record<string, unknown>)
        : {};

  return normalizeClientRequestId(parsed.clientRequestId);
}

async function backfillGenerationClientRequestIds(db: DatabaseAdapter): Promise<void> {
  try {
    const [rows] = await db.execute(
      `SELECT id, user_id, params
       FROM generations
       WHERE (client_request_id IS NULL OR client_request_id = '')
         AND params LIKE ?`,
      ['%clientRequestId%']
    );

    let updated = 0;
    let skipped = 0;
    for (const row of rows as any[]) {
      const clientRequestId = extractClientRequestIdFromParams(row.params);
      if (!clientRequestId) continue;

      // Pre-check ownership so legacy duplicates are skipped without throwing,
      // which avoids noisy constraint-error stack traces on every boot.
      const [claimed] = await db.execute(
        'SELECT id FROM generations WHERE user_id = ? AND client_request_id = ?',
        [row.user_id, clientRequestId]
      );
      if ((claimed as any[]).some((r) => r.id !== row.id)) {
        skipped += 1;
        continue;
      }

      try {
        const [result] = await db.execute(
          'UPDATE generations SET client_request_id = ? WHERE id = ? AND (client_request_id IS NULL OR client_request_id = ?)',
          [clientRequestId, row.id, '']
        );
        if (getAffectedRows(result) > 0) updated += 1;
      } catch (error) {
        const e = error as { code?: string; errno?: number };
        // MySQL raises ER_DUP_ENTRY (1062); better-sqlite3 raises
        // SQLITE_CONSTRAINT_UNIQUE. Both mean the same thing here.
        // Kept as a safety net for concurrent writes racing the pre-check.
        const isDuplicate =
          e?.code === 'ER_DUP_ENTRY' ||
          e?.errno === 1062 ||
          e?.code === 'SQLITE_CONSTRAINT_UNIQUE';
        if (!isDuplicate) throw error;
        // Duplicate (user_id, client_request_id): another legacy row already
        // claims this request id. Leave this row untouched and keep going so a
        // single conflict never aborts the whole backfill on every boot.
        skipped += 1;
      }
    }

    if (updated > 0) {
      console.log(`[DB] Backfilled generation client_request_id values: ${updated}`);
    }
    if (skipped > 0) {
      console.log(`[DB] Skipped ${skipped} legacy generation row(s) whose client_request_id is already claimed`);
    }
  } catch (error) {
    console.warn('[DB] Failed to backfill generation client_request_id values:', error);
  }
}

async function clearDuplicateGenerationClientRequestIds(db: DatabaseAdapter): Promise<void> {
  try {
    const [duplicates] = await db.execute(
      `SELECT user_id, client_request_id, COUNT(*) AS duplicate_count
       FROM generations
       WHERE client_request_id IS NOT NULL AND client_request_id <> ''
       GROUP BY user_id, client_request_id
       HAVING COUNT(*) > 1`
    );

    let cleared = 0;
    for (const duplicate of duplicates as any[]) {
      const [rows] = await db.execute(
        `SELECT id
         FROM generations
         WHERE user_id = ? AND client_request_id = ?
         ORDER BY created_at DESC, id DESC`,
        [duplicate.user_id, duplicate.client_request_id]
      );
      const staleIds = (rows as any[]).slice(1).map((row) => row.id).filter(Boolean);
      if (staleIds.length === 0) continue;

      const placeholders = staleIds.map(() => '?').join(', ');
      const [result] = await db.execute(
        `UPDATE generations SET client_request_id = NULL WHERE id IN (${placeholders})`,
        staleIds
      );
      cleared += getAffectedRows(result);
    }

    if (cleared > 0) {
      console.log(`[DB] Cleared duplicate generation client_request_id values: ${cleared}`);
    }
  } catch (error) {
    console.warn('[DB] Failed to clear duplicate generation client_request_id values:', error);
  }
}

// ========================================
// 数据库初始化
// ========================================

const CREATE_TABLES_SQL = `
-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(191) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  role ENUM('user', 'admin', 'moderator') DEFAULT 'user',
  balance INT DEFAULT 100,
  disabled TINYINT(1) DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  INDEX idx_email (email)
);

-- 生成记录表
CREATE TABLE IF NOT EXISTS generations (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  type ENUM('sora-video', 'sora-image', 'gemini-image', 'zimage-image', 'gitee-image') NOT NULL,
  prompt TEXT,
  params TEXT,
  client_request_id VARCHAR(128),
  result_url LONGTEXT,
  cost INT DEFAULT 0,
  balance_precharged TINYINT(1) DEFAULT 0,
  balance_refunded TINYINT(1) DEFAULT 0,
  status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
  error_message TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  INDEX idx_user_id (user_id),
  INDEX idx_created_at (created_at),
  INDEX idx_status (status)
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id VARCHAR(36) PRIMARY KEY,
  generation_id VARCHAR(36) UNIQUE NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  type ENUM('image') DEFAULT 'image',
  channel_id VARCHAR(36) NOT NULL,
  model_id VARCHAR(36) NOT NULL,
  payload LONGTEXT NOT NULL,
  status ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled') DEFAULT 'queued',
  attempts INT DEFAULT 0,
  max_attempts INT DEFAULT 2,
  locked_by VARCHAR(100) DEFAULT '',
  locked_until BIGINT DEFAULT 0,
  started_at BIGINT DEFAULT 0,
  finished_at BIGINT DEFAULT 0,
  error_message TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  INDEX idx_generation_jobs_status (status),
  INDEX idx_generation_jobs_channel (channel_id),
  INDEX idx_generation_jobs_generation (generation_id)
);

-- 系统配置表
CREATE TABLE IF NOT EXISTS system_config (
  id INT PRIMARY KEY DEFAULT 1,
  sora_api_key VARCHAR(500) DEFAULT '',
  sora_base_url VARCHAR(500) DEFAULT 'http://localhost:8000',
  gemini_api_key VARCHAR(500) DEFAULT '',
  gemini_base_url VARCHAR(500) DEFAULT 'https://generativelanguage.googleapis.com',
  zimage_api_key VARCHAR(500) DEFAULT '',
  zimage_base_url VARCHAR(500) DEFAULT 'https://api-inference.modelscope.cn/',
  gitee_api_key TEXT,
  gitee_free_api_key TEXT,
  gitee_base_url VARCHAR(500) DEFAULT 'https://ai.gitee.com/',
  picui_api_key VARCHAR(500) DEFAULT '',
  picui_base_url VARCHAR(500) DEFAULT 'https://picui.cn/api/v1',
  square_enabled TINYINT(1) DEFAULT 1,
  gacha_enabled TINYINT(1) DEFAULT 1,
  character_card_enabled TINYINT(1) DEFAULT 1,
  invite_enabled TINYINT(1) DEFAULT 1,
  invite_reward_enabled TINYINT(1) DEFAULT 1,
  invite_invitee_bonus INT DEFAULT 100,
  invite_inviter_bonus INT DEFAULT 50,
  image_storage_buckets LONGTEXT,
  image_storage_default_bucket_id VARCHAR(64) DEFAULT '',
  sora_backend_url VARCHAR(500) DEFAULT '',
  sora_backend_username VARCHAR(100) DEFAULT '',
  sora_backend_password VARCHAR(100) DEFAULT '',
  sora_backend_token VARCHAR(500) DEFAULT '',
  pricing_sora_video_10s INT DEFAULT 100,
  pricing_sora_video_15s INT DEFAULT 150,
  pricing_sora_video_25s INT DEFAULT 200,
  pricing_sora_image INT DEFAULT 50,
  pricing_gemini_nano INT DEFAULT 10,
  pricing_gemini_pro INT DEFAULT 30,
  pricing_zimage_image INT DEFAULT 30,
  pricing_gitee_image INT DEFAULT 30,
  pricing_chat INT DEFAULT 1,
  register_enabled TINYINT(1) DEFAULT 1,
  default_balance INT DEFAULT 100,
  email_verification_enabled TINYINT(1) DEFAULT 0,
  email_domain_whitelist_enabled TINYINT(1) DEFAULT 0,
  email_allowed_domains TEXT,
  email_alias_restriction_enabled TINYINT(1) DEFAULT 0,
  email_code_expires_minutes INT DEFAULT 10,
  smtp_host VARCHAR(200) DEFAULT '',
  smtp_port INT DEFAULT 465,
  smtp_username VARCHAR(255) DEFAULT '',
  smtp_password VARCHAR(500) DEFAULT '',
  smtp_from_email VARCHAR(255) DEFAULT '',
  smtp_secure TINYINT(1) DEFAULT 1,
  smtp_auth_login TINYINT(1) DEFAULT 1,
  payment_enabled TINYINT(1) DEFAULT 0,
  payment_server_base_url VARCHAR(500) DEFAULT '',
  payment_callback_url VARCHAR(500) DEFAULT '',
  payment_points_per_cny INT DEFAULT 100,
  payment_methods LONGTEXT,
  payment_amount_options LONGTEXT,
  payment_amount_discounts LONGTEXT,
  easypay_base_url VARCHAR(500) DEFAULT 'https://ezfpy.cn',
  easypay_merchant_id VARCHAR(100) DEFAULT '',
  easypay_api_key VARCHAR(500) DEFAULT '',
  easypay_min_amount_cny INT DEFAULT 1,
  prompt_filter_enabled TINYINT(1) DEFAULT 0,
  prompt_filter_model_id VARCHAR(36) DEFAULT '',
  prompt_filter_prompt TEXT,
  prompt_translate_enabled TINYINT(1) DEFAULT 0,
  prompt_translate_model_id VARCHAR(36) DEFAULT '',
  prompt_translate_prompt TEXT,
  prompt_blocklist_enabled TINYINT(1) DEFAULT 0,
  prompt_blocklist_words TEXT,
  rate_limit_image_max_requests INT DEFAULT 30,
  rate_limit_image_window_seconds INT DEFAULT 60,
  rate_limit_video_max_requests INT DEFAULT 30,
  rate_limit_video_window_seconds INT DEFAULT 60,
  generation_queue_enabled TINYINT(1) DEFAULT 1,
  generation_queue_image_concurrency INT DEFAULT 16,
  generation_queue_channel_concurrency INT DEFAULT 16,
  generation_queue_lock_timeout_seconds INT DEFAULT 900,
  generation_queue_max_attempts INT DEFAULT 2,
  site_points_purchase_url VARCHAR(500) DEFAULT ''
);

-- 聊天模型表
CREATE TABLE IF NOT EXISTS payment_orders (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  out_trade_no VARCHAR(64) UNIQUE NOT NULL,
  provider_trade_no VARCHAR(100) DEFAULT '',
  provider VARCHAR(32) DEFAULT 'easypay',
  payment_type VARCHAR(32) NOT NULL,
  amount_cents INT NOT NULL,
  paid_amount_cents INT NOT NULL,
  points INT NOT NULL,
  status ENUM('pending', 'succeeded', 'failed') DEFAULT 'pending',
  raw_notify LONGTEXT,
  created_at BIGINT NOT NULL,
  paid_at BIGINT DEFAULT 0,
  updated_at BIGINT NOT NULL,
  INDEX idx_payment_user_id (user_id),
  INDEX idx_payment_status (status),
  INDEX idx_payment_out_trade_no (out_trade_no)
);

CREATE TABLE IF NOT EXISTS chat_models (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  api_url VARCHAR(500) NOT NULL,
  api_key VARCHAR(500) NOT NULL,
  model_id VARCHAR(100) NOT NULL,
  supports_vision TINYINT(1) DEFAULT 0,
  max_tokens INT DEFAULT 128000,
  enabled TINYINT(1) DEFAULT 1,
  cost_per_message INT DEFAULT 1,
  created_at BIGINT NOT NULL,
  INDEX idx_enabled (enabled)
);

-- 聊天会话表
CREATE TABLE IF NOT EXISTS chat_sessions (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  title VARCHAR(200) DEFAULT '新对话',
  model_id VARCHAR(36) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  INDEX idx_user_id (user_id),
  INDEX idx_updated_at (updated_at)
);

-- 聊天消息表
CREATE TABLE IF NOT EXISTS chat_messages (
  id VARCHAR(36) PRIMARY KEY,
  session_id VARCHAR(36) NOT NULL,
  role ENUM('user', 'assistant', 'system') NOT NULL,
  content LONGTEXT NOT NULL,
  images TEXT,
  token_count INT DEFAULT 0,
  created_at BIGINT NOT NULL,
  INDEX idx_session_id (session_id),
  INDEX idx_created_at (created_at)
);

-- 角色卡表
CREATE TABLE IF NOT EXISTS character_cards (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  character_name VARCHAR(200) DEFAULT '',
  avatar_url LONGTEXT,
  source_video_url TEXT,
  status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
  error_message TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  INDEX idx_user_id (user_id),
  INDEX idx_created_at (created_at)
);

-- workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  name VARCHAR(200) NOT NULL,
  data LONGTEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  INDEX idx_user_id (user_id),
  INDEX idx_updated_at (updated_at),
  INDEX idx_name (name)
);
`;

let initialized = false;
let initializationPromise: Promise<void> | null = null;

export async function initializeDatabase(): Promise<void> {
  if (initialized) return;

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = initializeDatabaseInternal().finally(() => {
    initializationPromise = null;
  });

  return initializationPromise;
}

async function initializeDatabaseInternal(): Promise<void> {
  if (initialized) return;

  const db = getAdapter();

  // 渠道表始终尝试创建（幂等操作，确保新表被创建）
  await initializeImageChannelsTablesInternal(db);
  await initializeVideoChannelsTablesInternal(db);

  const statements = CREATE_TABLES_SQL.split(';').filter((s) => s.trim());

  for (const statement of statements) {
    if (statement.trim()) {
      await db.execute(statement);
    }
  }

  const dbType = process.env.DB_TYPE || 'sqlite';

  // 迁移：确保 avatar_url 列是 LONGTEXT（仅 MySQL 需要，SQLite 不支持 MODIFY COLUMN）
  if (dbType === 'mysql') {
    try {
      await db.execute(`
        ALTER TABLE character_cards MODIFY COLUMN avatar_url LONGTEXT
      `);
    } catch (e) {
      // 忽略错误（列可能已经是正确类型或表不存在）
    }
  }

  // 初始化系统配置（如果不存在）
  await db.execute(`
    ${dbType === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE'} INTO system_config (id, sora_api_key, sora_base_url, gemini_api_key, gemini_base_url)
    VALUES (1, ?, ?, ?, ?)
  `, [
    process.env.SORA_API_KEY || '',
    process.env.SORA_BASE_URL || 'http://localhost:8000',
    process.env.GEMINI_API_KEY || '',
    process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
  ]);

  // 初始化管理员账号
  await initializeAdmin();

  // 添加 disabled 字段（如果不存在�?
  try {
    await db.execute('ALTER TABLE users ADD COLUMN disabled BOOLEAN DEFAULT FALSE');
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加 generations 表的新字段（如果不存在）
  try {
    if (dbType === 'mysql') {
      await db.execute("ALTER TABLE generations ADD COLUMN status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending'");
    } else {
      // SQLite: ENUM 转为 TEXT
      await db.execute("ALTER TABLE generations ADD COLUMN status TEXT DEFAULT 'pending'");
    }
  } catch {
    // 字段已存在，忽略错误
  }

  try {
    await db.execute('ALTER TABLE generations ADD COLUMN error_message TEXT');
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加余额预扣/退款标记字段（如果不存在）
  try {
    await db.execute('ALTER TABLE generations ADD COLUMN balance_precharged TINYINT(1) DEFAULT 0');
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute('ALTER TABLE generations ADD COLUMN balance_refunded TINYINT(1) DEFAULT 0');
  } catch {
    // 字段已存在，忽略错误
  }

  // 确保 generations.params 列存在（用于存储 permalink / revised_prompt 等扩展信息）
  try {
    if (dbType === 'mysql') {
      await db.execute('ALTER TABLE generations ADD COLUMN params TEXT');
    } else {
      await db.execute('ALTER TABLE generations ADD COLUMN params TEXT');
    }
  } catch {
    // 字段已存在，忽略错误
  }

  try {
    if (dbType === 'mysql') {
      await db.execute('ALTER TABLE generations ADD COLUMN client_request_id VARCHAR(128)');
    } else {
      await db.execute('ALTER TABLE generations ADD COLUMN client_request_id TEXT');
    }
  } catch {
    // Column already exists.
  }

  try {
    if (dbType === 'mysql') {
      await db.execute('ALTER TABLE generations ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0');
    } else {
      // SQLite: 不支持 NOT NULL 和 DEFAULT 同时使用在 ALTER TABLE 中
      await db.execute('ALTER TABLE generations ADD COLUMN updated_at INTEGER DEFAULT 0');
    }
  } catch {
    // 字段已存在，忽略错误
  }

  // 为已存在的记录设置默认值
  try {
    await db.execute("UPDATE generations SET status = 'completed' WHERE status IS NULL OR status = ''");
    await db.execute('UPDATE generations SET updated_at = created_at WHERE updated_at = 0 OR updated_at IS NULL');
    await db.execute("UPDATE generations SET params = '{}' WHERE params IS NULL OR params = ''");
  } catch {
    // 忽略错误
  }

  // 添加 Z-Image 配置字段（如果不存在）
  await backfillGenerationClientRequestIds(db);
  try {
    await db.execute("UPDATE generations SET client_request_id = NULL WHERE client_request_id = ''");
  } catch {
    // Ignore cleanup failures; index creation will surface real conflicts.
  }
  await clearDuplicateGenerationClientRequestIds(db);
  try {
    await db.execute(
      'CREATE UNIQUE INDEX idx_user_client_request_id ON generations (user_id, client_request_id)'
    );
  } catch {
    // Index already exists.
  }

  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN zimage_api_key VARCHAR(500) DEFAULT ''");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN zimage_base_url VARCHAR(500) DEFAULT 'https://api-inference.modelscope.cn/'");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute('ALTER TABLE system_config ADD COLUMN pricing_zimage_image INT DEFAULT 30');
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加 Gitee 配置字段（如果不存在）
  try {
    await db.execute('ALTER TABLE system_config ADD COLUMN gitee_api_key TEXT');
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute('ALTER TABLE system_config ADD COLUMN gitee_free_api_key TEXT');
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN gitee_base_url VARCHAR(500) DEFAULT 'https://ai.gitee.com/'");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute('ALTER TABLE system_config ADD COLUMN pricing_gitee_image INT DEFAULT 30');
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加 25s 视频定价字段
  try {
    await db.execute('ALTER TABLE system_config ADD COLUMN pricing_sora_video_25s INT DEFAULT 200');
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加 SORA 后台配置字段
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN sora_backend_url VARCHAR(500) DEFAULT ''");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN sora_backend_username VARCHAR(100) DEFAULT ''");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN sora_backend_password VARCHAR(100) DEFAULT ''");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN sora_backend_token VARCHAR(500) DEFAULT ''");
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加公告配置字段
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN announcement_title VARCHAR(200) DEFAULT ''");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN announcement_content TEXT");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN announcement_enabled TINYINT(1) DEFAULT 0");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN announcement_updated_at BIGINT DEFAULT 0");
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加 PicUI 图床配置字段（如果不存在）
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN picui_api_key VARCHAR(500) DEFAULT ''");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN picui_base_url VARCHAR(500) DEFAULT 'https://picui.cn/api/v1'");
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加功能开关与邀请码配置字段
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN square_enabled TINYINT(1) DEFAULT 1");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN gacha_enabled TINYINT(1) DEFAULT 1");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN character_card_enabled TINYINT(1) DEFAULT 1");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN invite_enabled TINYINT(1) DEFAULT 1");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN invite_reward_enabled TINYINT(1) DEFAULT 1");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN invite_invitee_bonus INT DEFAULT 100");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN invite_inviter_bonus INT DEFAULT 50");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN image_storage_buckets LONGTEXT");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN image_storage_default_bucket_id VARCHAR(64) DEFAULT ''");
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加渠道启用配置字段（如果不存在）
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN channel_sora_enabled TINYINT(1) DEFAULT 1");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN channel_gemini_enabled TINYINT(1) DEFAULT 1");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN channel_zimage_enabled TINYINT(1) DEFAULT 1");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN channel_gitee_enabled TINYINT(1) DEFAULT 1");
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加每日请求限制配置字段
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN daily_limit_image INT DEFAULT 0");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN daily_limit_video INT DEFAULT 0");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN daily_limit_character_card INT DEFAULT 0");
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加网站配置字段
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN site_name VARCHAR(100) DEFAULT 'SANHUB'");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN site_tagline VARCHAR(200) DEFAULT 'Let Imagination Come Alive'");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN site_description TEXT");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN site_sub_description TEXT");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN contact_email VARCHAR(200) DEFAULT 'support@sanhub.com'");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN site_copyright VARCHAR(200) DEFAULT 'Copyright © 2025 SANHUB'");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN site_powered_by VARCHAR(200) DEFAULT 'Powered by OpenAI Sora & Google Gemini'");
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加模型禁用配置字段
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN site_points_purchase_url VARCHAR(500) DEFAULT ''");
  } catch {
    // ignore existing column
  }

  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN disabled_image_models TEXT");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN disabled_video_models TEXT");
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加视频加速配置字段
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN video_proxy_enabled TINYINT(1) DEFAULT 0");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN video_proxy_base_url VARCHAR(500) DEFAULT ''");
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加提示词处理配置字段
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN prompt_filter_enabled TINYINT(1) DEFAULT 0");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN prompt_filter_model_id VARCHAR(36) DEFAULT ''");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN prompt_filter_prompt TEXT");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN prompt_translate_enabled TINYINT(1) DEFAULT 0");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN prompt_translate_model_id VARCHAR(36) DEFAULT ''");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN prompt_translate_prompt TEXT");
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加提示词敏感词拦截配置字段
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN prompt_blocklist_enabled TINYINT(1) DEFAULT 0");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN prompt_blocklist_words TEXT");
  } catch {
    // 字段已存在，忽略错误
  }

  // 添加生成限流配置字段
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN rate_limit_image_max_requests INT DEFAULT 30");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN rate_limit_image_window_seconds INT DEFAULT 60");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN rate_limit_video_max_requests INT DEFAULT 30");
  } catch {
    // 字段已存在，忽略错误
  }
  try {
    await db.execute("ALTER TABLE system_config ADD COLUMN rate_limit_video_window_seconds INT DEFAULT 60");
  } catch {
    // 字段已存在，忽略错误
  }

  const emailConfigColumns = [
    "email_verification_enabled TINYINT(1) DEFAULT 0",
    "email_domain_whitelist_enabled TINYINT(1) DEFAULT 0",
    "email_allowed_domains TEXT",
    "email_alias_restriction_enabled TINYINT(1) DEFAULT 0",
    "email_code_expires_minutes INT DEFAULT 10",
    "smtp_host VARCHAR(200) DEFAULT ''",
    "smtp_port INT DEFAULT 465",
    "smtp_username VARCHAR(255) DEFAULT ''",
    "smtp_password VARCHAR(500) DEFAULT ''",
    "smtp_from_email VARCHAR(255) DEFAULT ''",
    "smtp_secure TINYINT(1) DEFAULT 1",
    "smtp_auth_login TINYINT(1) DEFAULT 1",
  ];

  for (const columnDefinition of emailConfigColumns) {
    try {
      await db.execute(`ALTER TABLE system_config ADD COLUMN ${columnDefinition}`);
    } catch {
      // Column already exists.
    }
  }

  const paymentConfigColumns = [
    "payment_enabled TINYINT(1) DEFAULT 0",
    "payment_server_base_url VARCHAR(500) DEFAULT ''",
    "payment_callback_url VARCHAR(500) DEFAULT ''",
    "payment_points_per_cny INT DEFAULT 100",
    "payment_methods LONGTEXT",
    "payment_amount_options LONGTEXT",
    "payment_amount_discounts LONGTEXT",
    "easypay_base_url VARCHAR(500) DEFAULT 'https://ezfpy.cn'",
    "easypay_merchant_id VARCHAR(100) DEFAULT ''",
    "easypay_api_key VARCHAR(500) DEFAULT ''",
    "easypay_min_amount_cny INT DEFAULT 1",
  ];

  for (const columnDefinition of paymentConfigColumns) {
    try {
      await db.execute(`ALTER TABLE system_config ADD COLUMN ${columnDefinition}`);
    } catch {
      // Column already exists.
    }
  }

  const generationQueueConfigColumns = [
    "generation_queue_enabled TINYINT(1) DEFAULT 1",
    "generation_queue_image_concurrency INT DEFAULT 16",
    "generation_queue_channel_concurrency INT DEFAULT 16",
    "generation_queue_lock_timeout_seconds INT DEFAULT 900",
    "generation_queue_max_attempts INT DEFAULT 2",
  ];

  for (const columnDefinition of generationQueueConfigColumns) {
    try {
      await db.execute(`ALTER TABLE system_config ADD COLUMN ${columnDefinition}`);
    } catch {
      // Column already exists.
    }
  }

  // 更新 generations 表的 type 字段以支持 gitee-image（MySQL 需要修改 ENUM）
  if (dbType === 'mysql') {
    try {
      await db.execute("ALTER TABLE generations MODIFY COLUMN type ENUM('sora-video', 'sora-image', 'gemini-image', 'zimage-image', 'gitee-image') NOT NULL");
    } catch {
      // 忽略错误
    }
  }

  // 更新 generations 表的 status 字段以支持 cancelled（MySQL 需要修改 ENUM）
  if (dbType === 'mysql') {
    try {
      await db.execute("ALTER TABLE generations MODIFY COLUMN status ENUM('pending', 'processing', 'completed', 'failed', 'cancelled') DEFAULT 'pending'");
    } catch {
      // 忽略错误
    }
  }

  // 更新 users 表的 role 字段以支持 moderator（MySQL 需要修改 ENUM）
  if (dbType === 'mysql') {
    try {
      await db.execute("ALTER TABLE users MODIFY COLUMN role ENUM('user', 'admin', 'moderator') DEFAULT 'user'");
    } catch {
      // 忽略错误
    }
  }

  initialized = true;
  console.log('Database initialized successfully');
}

// ========================================
// 用户操作
// ========================================

export async function createUser(
  email: string,
  password: string,
  name: string,
  role: 'user' | 'admin' = 'user',
  balance?: number
): Promise<User> {
  await initializeDatabase();
  const db = getAdapter();

  // 检查邮箱是否已存在
  const [existing] = await db.execute(
    'SELECT id FROM users WHERE email = ?',
    [email]
  );
  if ((existing as unknown[]).length > 0) {
    throw new Error('该邮箱已被注册');
  }

  const config = await getSystemConfig();
  const hashedPassword = await bcrypt.hash(password, 10);
  const now = Date.now();

  const user: User = {
    id: generateId(),
    email,
    password: hashedPassword,
    name,
    role,
    balance: balance ?? config.defaultBalance,
    disabled: false,
    createdAt: now,
    updatedAt: now,
  };

  await db.execute(
    `INSERT INTO users (id, email, password, name, role, balance, disabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [user.id, user.email, user.password, user.name, user.role, user.balance, user.disabled, user.createdAt, user.updatedAt]
  );

  return user;
}

export async function getUserById(id: string): Promise<User | null> {
  await initializeDatabase();
  const db = getAdapter();

  const [rows] = await db.execute(
    'SELECT * FROM users WHERE id = ?',
    [id]
  );

  const users = rows as any[];
  if (users.length === 0) return null;

  const row = users[0];
  return {
    id: row.id,
    email: row.email,
    password: row.password,
    name: row.name,
    role: row.role,
    balance: row.balance,
    disabled: Boolean(row.disabled),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function getUserByEmail(email: string): Promise<User | null> {
  await initializeDatabase();
  const db = getAdapter();

  const [rows] = await db.execute(
    'SELECT * FROM users WHERE email = ?',
    [email]
  );

  const users = rows as any[];
  if (users.length === 0) return null;

  const row = users[0];
  return {
    id: row.id,
    email: row.email,
    password: row.password,
    name: row.name,
    role: row.role,
    balance: row.balance,
    disabled: Boolean(row.disabled),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function verifyPassword(
  email: string,
  password: string
): Promise<User | null> {
  const user = await getUserByEmail(email);
  if (!user) return null;

  // Disabled users cannot login - throw explicit error
  if (user.disabled) {
    throw new Error('账号已被禁用，请联系管理员');
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return null;

  return user;
}

export async function updateUser(
  id: string,
  updates: Partial<Omit<User, 'id' | 'email' | 'createdAt'>>
): Promise<User | null> {
  await initializeDatabase();
  const db = getAdapter();

  const user = await getUserById(id);
  if (!user) return null;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.password !== undefined) {
    fields.push('password = ?');
    values.push(await bcrypt.hash(updates.password, 10));
  }
  if (updates.role !== undefined) {
    fields.push('role = ?');
    values.push(updates.role);
  }
  if (updates.balance !== undefined) {
    fields.push('balance = ?');
    values.push(updates.balance);
  }
  if (updates.disabled !== undefined) {
    fields.push('disabled = ?');
    values.push(updates.disabled);
  }

  if (fields.length === 0) return user;

  fields.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  await db.execute(
    `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
    values
  );

  return getUserById(id);
}

export type BalanceUpdateMode = 'strict' | 'clamp';

export async function updateUserBalance(
  id: string,
  delta: number,
  mode: BalanceUpdateMode = 'strict'
): Promise<number> {
  await initializeDatabase();
  const db = getAdapter();

  const safeDelta = Number(delta);
  if (!Number.isFinite(safeDelta)) {
    throw new Error('Invalid balance delta');
  }

  const now = Date.now();
  if (mode === 'clamp') {
    const [result] = await db.execute(
      'UPDATE users SET balance = CASE WHEN balance + ? < 0 THEN 0 ELSE balance + ? END, updated_at = ? WHERE id = ?',
      [safeDelta, safeDelta, now, id]
    );
    if (!(result as any).affectedRows) {
      throw new Error('User not found');
    }
    const user = await getUserById(id);
    if (!user) throw new Error('User not found');
    return user.balance;
  }

  const [result] = await db.execute(
    'UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ? AND balance + ? >= 0',
    [safeDelta, now, id, safeDelta]
  );

  if (!(result as any).affectedRows) {
    const user = await getUserById(id);
    if (!user) throw new Error('User not found');
    throw new Error('Insufficient balance');
  }

  const user = await getUserById(id);
  if (!user) throw new Error('User not found');
  return user.balance;
}

function mapPaymentOrder(row: any): PaymentOrder {
  return {
    id: row.id,
    userId: row.user_id,
    outTradeNo: row.out_trade_no,
    providerTradeNo: row.provider_trade_no || undefined,
    provider: row.provider || 'easypay',
    paymentType: row.payment_type,
    amountCents: Number(row.amount_cents) || 0,
    paidAmountCents: Number(row.paid_amount_cents) || 0,
    points: Number(row.points) || 0,
    status: row.status || 'pending',
    rawNotify: row.raw_notify || undefined,
    createdAt: Number(row.created_at) || 0,
    paidAt: Number(row.paid_at) || undefined,
    updatedAt: Number(row.updated_at) || 0,
  };
}

function getAffectedRows(result: unknown): number {
  if (Array.isArray(result)) {
    return Number((result[0] as any)?.affectedRows) || 0;
  }
  return Number((result as any)?.affectedRows) || 0;
}

export async function createPaymentOrder(input: {
  userId: string;
  paymentType: string;
  amountCents: number;
  paidAmountCents: number;
  points: number;
}): Promise<PaymentOrder> {
  await initializeDatabase();
  const db = getAdapter();
  const now = Date.now();
  const outTradeNo = `SH${now}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const order: PaymentOrder = {
    id: generateId(),
    userId: input.userId,
    outTradeNo,
    provider: 'easypay',
    paymentType: input.paymentType,
    amountCents: input.amountCents,
    paidAmountCents: input.paidAmountCents,
    points: input.points,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };

  await db.execute(
    `INSERT INTO payment_orders (id, user_id, out_trade_no, provider, payment_type, amount_cents, paid_amount_cents, points, status, created_at, paid_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.id,
      order.userId,
      order.outTradeNo,
      order.provider,
      order.paymentType,
      order.amountCents,
      order.paidAmountCents,
      order.points,
      order.status,
      order.createdAt,
      0,
      order.updatedAt,
    ]
  );

  return order;
}

export async function createManualBalancePaymentOrder(input: {
  userId: string;
  points: number;
  operatorId: string;
  reason?: string;
}): Promise<PaymentOrder> {
  await initializeDatabase();
  const db = getAdapter();
  const now = Date.now();
  const safePoints = Math.floor(Number(input.points));
  if (!input.userId || !input.operatorId || !Number.isFinite(safePoints) || safePoints <= 0) {
    throw new Error('Invalid manual balance payment order');
  }

  const order: PaymentOrder = {
    id: generateId(),
    userId: input.userId,
    outTradeNo: `ADMIN${now}${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    provider: 'manual',
    providerTradeNo: input.operatorId,
    paymentType: 'admin_balance',
    amountCents: 0,
    paidAmountCents: 0,
    points: safePoints,
    status: 'succeeded',
    rawNotify: JSON.stringify({
      type: 'admin_balance',
      operatorId: input.operatorId,
      reason: input.reason || '',
    }),
    createdAt: now,
    paidAt: now,
    updatedAt: now,
  };

  await db.execute(
    `INSERT INTO payment_orders (id, user_id, out_trade_no, provider, provider_trade_no, payment_type, amount_cents, paid_amount_cents, points, status, raw_notify, created_at, paid_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.id,
      order.userId,
      order.outTradeNo,
      order.provider,
      order.providerTradeNo,
      order.paymentType,
      order.amountCents,
      order.paidAmountCents,
      order.points,
      order.status,
      order.rawNotify,
      order.createdAt,
      order.paidAt,
      order.updatedAt,
    ]
  );

  return order;
}

export async function createRedemptionPaymentOrder(input: {
  userId: string;
  points: number;
  code: string;
  codeId: string;
  paidAt?: number;
}): Promise<PaymentOrder> {
  await initializeDatabase();
  const db = getAdapter();
  const now = Date.now();
  const safePoints = Math.floor(Number(input.points));
  if (!input.userId || !input.code || !Number.isFinite(safePoints) || safePoints <= 0) {
    throw new Error('Invalid redemption payment order');
  }

  const order: PaymentOrder = {
    id: generateId(),
    userId: input.userId,
    outTradeNo: `REDEEM${now}${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    provider: 'redemption',
    providerTradeNo: input.code,
    paymentType: 'redemption_code',
    amountCents: 0,
    paidAmountCents: 0,
    points: safePoints,
    status: 'succeeded',
    rawNotify: JSON.stringify({
      type: 'redemption_code',
      code: input.code,
      codeId: input.codeId,
    }),
    createdAt: now,
    paidAt: input.paidAt ?? now,
    updatedAt: now,
  };

  await db.execute(
    `INSERT INTO payment_orders (id, user_id, out_trade_no, provider, provider_trade_no, payment_type, amount_cents, paid_amount_cents, points, status, raw_notify, created_at, paid_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.id,
      order.userId,
      order.outTradeNo,
      order.provider,
      order.providerTradeNo,
      order.paymentType,
      order.amountCents,
      order.paidAmountCents,
      order.points,
      order.status,
      order.rawNotify,
      order.createdAt,
      order.paidAt,
      order.updatedAt,
    ]
  );

  return order;
}

export async function getPaymentOrderByOutTradeNo(
  outTradeNo: string
): Promise<PaymentOrder | null> {
  await initializeDatabase();
  const db = getAdapter();
  const [rows] = await db.execute(
    'SELECT * FROM payment_orders WHERE out_trade_no = ?',
    [outTradeNo]
  );
  const orders = rows as any[];
  return orders[0] ? mapPaymentOrder(orders[0]) : null;
}

export async function getUserPaymentOrders(
  userId: string,
  limit = 20,
  offset = 0
): Promise<PaymentOrder[]> {
  await initializeDatabase();
  const db = getAdapter();
  const safeLimit = Math.max(Number(limit) || 20, 1);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const [rows] = await db.execute(
    `SELECT * FROM payment_orders
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [userId]
  );

  return (rows as any[]).map(mapPaymentOrder);
}

export async function getRecentPaymentOrders(
  limit = 50,
  offset = 0
): Promise<PaymentOrderSummary[]> {
  await initializeDatabase();
  const db = getAdapter();
  const safeLimit = Math.max(Number(limit) || 50, 1);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const [rows] = await db.execute(
    `SELECT p.*, u.email as user_email, u.name as user_name
     FROM payment_orders p
     LEFT JOIN users u ON p.user_id = u.id
     ORDER BY p.created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`
  );

  return (rows as any[]).map((row) => ({
    ...mapPaymentOrder(row),
    userEmail: row.user_email || undefined,
    userName: row.user_name || undefined,
  }));
}

export async function getPaymentOrdersForAdmin(options: {
  limit?: number;
  offset?: number;
  search?: string;
  status?: PaymentOrderStatus | 'all';
  startTime?: number;
  endTime?: number;
} = {}): Promise<PaymentOrderListResult> {
  await initializeDatabase();
  const db = getAdapter();
  const safeLimit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
  const safeOffset = Math.max(Number(options.offset) || 0, 0);
  const whereClauses: string[] = [];
  const values: unknown[] = [];

  if (options.status && options.status !== 'all') {
    whereClauses.push('p.status = ?');
    values.push(options.status);
  }

  if (options.search) {
    const keyword = `%${options.search.trim()}%`;
    whereClauses.push('(p.out_trade_no LIKE ? OR p.provider_trade_no LIKE ? OR u.email LIKE ? OR u.name LIKE ?)');
    values.push(keyword, keyword, keyword, keyword);
  }

  if (options.startTime) {
    whereClauses.push('COALESCE(NULLIF(p.paid_at, 0), p.created_at) >= ?');
    values.push(options.startTime);
  }

  if (options.endTime) {
    whereClauses.push('COALESCE(NULLIF(p.paid_at, 0), p.created_at) <= ?');
    values.push(options.endTime);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const [countRows] = await db.execute(
    `SELECT COUNT(1) as count
     FROM payment_orders p
     LEFT JOIN users u ON p.user_id = u.id
     ${whereSql}`,
    values
  );

  const [rows] = await db.execute(
    `SELECT p.*, u.email as user_email, u.name as user_name
     FROM payment_orders p
     LEFT JOIN users u ON p.user_id = u.id
     ${whereSql}
     ORDER BY p.created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    values
  );

  return {
    orders: (rows as any[]).map((row) => ({
      ...mapPaymentOrder(row),
      userEmail: row.user_email || undefined,
      userName: row.user_name || undefined,
    })),
    total: Number((countRows as any[])[0]?.count || 0),
  };
}

export async function completePaymentOrder(input: {
  outTradeNo: string;
  providerTradeNo?: string;
  rawNotify: string;
}): Promise<{ order: PaymentOrder; credited: boolean }> {
  await initializeDatabase();
  const db = getAdapter();
  const order = await getPaymentOrderByOutTradeNo(input.outTradeNo);
  if (!order) {
    throw new Error('Payment order not found');
  }

  const now = Date.now();
  const [result] = await db.execute(
    `UPDATE payment_orders
     SET status = 'succeeded', provider_trade_no = ?, raw_notify = ?, paid_at = ?, updated_at = ?
     WHERE out_trade_no = ? AND status = 'pending'`,
    [
      input.providerTradeNo || '',
      input.rawNotify,
      now,
      now,
      input.outTradeNo,
    ]
  );

  const credited = getAffectedRows(result) > 0;
  if (credited) {
    await updateUserBalance(order.userId, order.points, 'strict');
  }

  const updatedOrder = await getPaymentOrderByOutTradeNo(input.outTradeNo);
  return { order: updatedOrder || order, credited };
}

export async function getAllUsers(options: {
  limit?: number;
  offset?: number;
  search?: string;
} = {}): Promise<SafeUser[]> {
  await initializeDatabase();
  const db = getAdapter();
  const limit = Math.max(Number(options.limit) || 200, 1);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const search = options.search?.trim();

  let sql = 'SELECT id, email, name, role, balance, disabled, created_at FROM users';
  const params: unknown[] = [];

  if (search) {
    sql += ' WHERE email LIKE ? OR name LIKE ?';
    const term = `%${search}%`;
    params.push(term, term);
  }

  sql += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

  const [rows] = await db.execute(sql, params);

  return (rows as any[]).map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    balance: row.balance,
    disabled: Boolean(row.disabled),
    createdAt: Number(row.created_at),
  }));
}

export async function getUsersCount(search?: string): Promise<number> {
  await initializeDatabase();
  const db = getAdapter();
  const term = search?.trim();

  let sql = 'SELECT COUNT(1) as count FROM users';
  const params: unknown[] = [];

  if (term) {
    sql += ' WHERE email LIKE ? OR name LIKE ?';
    const like = `%${term}%`;
    params.push(like, like);
  }

  const [rows] = await db.execute(sql, params);
  const row = (rows as any[])[0];
  return Number(row?.count || 0);
}

export async function deleteUser(id: string): Promise<boolean> {
  await initializeDatabase();
  const db = getAdapter();

  const [result] = await db.execute('DELETE FROM users WHERE id = ?', [id]);
  return (result as any).affectedRows > 0;
}

// ========================================
// 生成记录操作
// ========================================

export async function saveGeneration(
  generation: Omit<Generation, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Generation> {
  await initializeDatabase();
  const db = getAdapter();

  const now = Date.now();
  const gen: Generation = {
    ...generation,
    id: generateId(),
    createdAt: now,
    updatedAt: now,
    clientRequestId:
      normalizeClientRequestId(generation.clientRequestId) ||
      extractClientRequestIdFromParams(generation.params) ||
      undefined,
    balancePrecharged: generation.balancePrecharged ?? false,
    balanceRefunded: generation.balanceRefunded ?? false,
  };

  await db.execute(
    `INSERT INTO generations (id, user_id, type, prompt, params, client_request_id, result_url, cost, balance_precharged, balance_refunded, status, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      gen.id,
      gen.userId,
      gen.type,
      gen.prompt,
      JSON.stringify(gen.params),
      gen.clientRequestId || null,
      gen.resultUrl,
      gen.cost,
      gen.balancePrecharged ? 1 : 0,
      gen.balanceRefunded ? 1 : 0,
      gen.status,
      gen.errorMessage || null,
      gen.createdAt,
      gen.updatedAt,
    ]
  );

  return gen;
}

function mapGenerationRow(row: any): Generation {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    prompt: row.prompt,
    params: parseJsonValue<Generation['params']>(row.params, {}),
    clientRequestId: row.client_request_id || undefined,
    resultUrl: row.result_url,
    cost: Number(row.cost) || 0,
    status: row.status || 'completed',
    balancePrecharged: Boolean(row.balance_precharged),
    balanceRefunded: Boolean(row.balance_refunded),
    errorMessage: row.error_message || undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at || row.created_at),
  };
}

export async function getGenerationByClientRequestId(
  userId: string,
  clientRequestId: string
): Promise<Generation | null> {
  await initializeDatabase();
  const db = getAdapter();

  const normalizedClientRequestId = normalizeClientRequestId(clientRequestId);
  if (!normalizedClientRequestId) return null;

  const [rows] = await db.execute(
    `SELECT * FROM generations
     WHERE user_id = ? AND client_request_id = ?
     ORDER BY created_at DESC LIMIT 1`,
    [userId, normalizedClientRequestId]
  );

  return (rows as any[])[0] ? mapGenerationRow((rows as any[])[0]) : null;
}

export async function updateGeneration(
  id: string,
  updates: Partial<Pick<Generation, 'status' | 'resultUrl' | 'errorMessage' | 'params' | 'balancePrecharged' | 'balanceRefunded'>>
): Promise<Generation | null> {
  await initializeDatabase();
  const db = getAdapter();

  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.resultUrl !== undefined) {
    fields.push('result_url = ?');
    values.push(updates.resultUrl);
  }
  if (updates.params !== undefined) {
    fields.push('params = ?');
    values.push(JSON.stringify(updates.params));
    const nextClientRequestId = extractClientRequestIdFromParams(updates.params);
    if (nextClientRequestId) {
      fields.push('client_request_id = ?');
      values.push(nextClientRequestId);
    }
  }
  if (updates.balancePrecharged !== undefined) {
    fields.push('balance_precharged = ?');
    values.push(updates.balancePrecharged ? 1 : 0);
  }
  if (updates.balanceRefunded !== undefined) {
    fields.push('balance_refunded = ?');
    values.push(updates.balanceRefunded ? 1 : 0);
  }
  if (updates.errorMessage !== undefined) {
    fields.push('error_message = ?');
    values.push(updates.errorMessage);
  }

  values.push(id);
  await db.execute(
    `UPDATE generations SET ${fields.join(', ')} WHERE id = ?`,
    values
  );

  return getGeneration(id);
}

export async function updateGenerationIfLockedByJob(
  id: string,
  jobId: string,
  workerId: string,
  updates: Partial<Pick<Generation, 'status' | 'resultUrl' | 'errorMessage' | 'params' | 'balancePrecharged' | 'balanceRefunded'>>
): Promise<Generation | null> {
  await initializeDatabase();
  const db = getAdapter();

  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.resultUrl !== undefined) {
    fields.push('result_url = ?');
    values.push(updates.resultUrl);
  }
  if (updates.params !== undefined) {
    fields.push('params = ?');
    values.push(JSON.stringify(updates.params));
    const nextClientRequestId = extractClientRequestIdFromParams(updates.params);
    if (nextClientRequestId) {
      fields.push('client_request_id = ?');
      values.push(nextClientRequestId);
    }
  }
  if (updates.balancePrecharged !== undefined) {
    fields.push('balance_precharged = ?');
    values.push(updates.balancePrecharged ? 1 : 0);
  }
  if (updates.balanceRefunded !== undefined) {
    fields.push('balance_refunded = ?');
    values.push(updates.balanceRefunded ? 1 : 0);
  }
  if (updates.errorMessage !== undefined) {
    fields.push('error_message = ?');
    values.push(updates.errorMessage);
  }

  const now = Date.now();
  values.push(id, jobId, workerId, now);
  const [result] = await db.execute(
    `UPDATE generations
     SET ${fields.join(', ')}
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM generation_jobs
         WHERE id = ?
           AND generation_id = generations.id
           AND status = 'running'
           AND locked_by = ?
           AND locked_until >= ?
       )`,
    values
  );

  if (getAffectedRows(result) <= 0) {
    return null;
  }

  return getGeneration(id);
}

export async function refundGenerationBalance(
  generationId: string,
  userId: string,
  cost: number
): Promise<boolean> {
  await initializeDatabase();
  const db = getAdapter();

  const safeCost = Number(cost);
  const now = Date.now();

  const [markResult] = await db.execute(
    'UPDATE generations SET balance_refunded = 1, updated_at = ? WHERE id = ? AND user_id = ? AND balance_precharged = 1 AND balance_refunded = 0',
    [now, generationId, userId]
  );

  if (!(markResult as any).affectedRows) {
    return false;
  }

  if (!Number.isFinite(safeCost) || safeCost <= 0) {
    return true;
  }

  try {
    await updateUserBalance(userId, safeCost, 'strict');
    return true;
  } catch (error) {
    await db.execute(
      'UPDATE generations SET balance_refunded = 0, updated_at = ? WHERE id = ? AND user_id = ?',
      [Date.now(), generationId, userId]
    ).catch(() => {});
    throw error;
  }
}

function mapGenerationJob(row: any): GenerationJob {
  return {
    id: row.id,
    generationId: row.generation_id,
    userId: row.user_id,
    type: row.type || 'image',
    channelId: row.channel_id,
    modelId: row.model_id,
    payload: parseJsonValue<Record<string, unknown>>(row.payload, {}),
    status: row.status || 'queued',
    attempts: Number(row.attempts) || 0,
    maxAttempts: Number(row.max_attempts) || 1,
    lockedBy: row.locked_by || undefined,
    lockedUntil: Number(row.locked_until) || undefined,
    startedAt: Number(row.started_at) || undefined,
    finishedAt: Number(row.finished_at) || undefined,
    errorMessage: row.error_message || undefined,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export async function createGenerationJob(input: {
  generationId: string;
  userId: string;
  type: 'image';
  channelId: string;
  modelId: string;
  payload: Record<string, unknown>;
  maxAttempts: number;
}): Promise<GenerationJob> {
  await initializeDatabase();
  const db = getAdapter();
  const now = Date.now();
  const job: GenerationJob = {
    id: generateId(),
    generationId: input.generationId,
    userId: input.userId,
    type: input.type,
    channelId: input.channelId,
    modelId: input.modelId,
    payload: input.payload,
    status: 'queued',
    attempts: 0,
    maxAttempts: Math.max(1, Number(input.maxAttempts) || 1),
    createdAt: now,
    updatedAt: now,
  };

  await db.execute(
    `INSERT INTO generation_jobs (id, generation_id, user_id, type, channel_id, model_id, payload, status, attempts, max_attempts, locked_by, locked_until, started_at, finished_at, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      job.id,
      job.generationId,
      job.userId,
      job.type,
      job.channelId,
      job.modelId,
      JSON.stringify(job.payload),
      job.status,
      job.attempts,
      job.maxAttempts,
      '',
      0,
      0,
      0,
      null,
      job.createdAt,
      job.updatedAt,
    ]
  );

  return job;
}

export async function claimGenerationJobs(
  workerId: string,
  limit: number,
  lockTimeoutMs: number
): Promise<GenerationJob[]> {
  await initializeDatabase();
  const db = getAdapter();
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const now = Date.now();
  const lockedUntil = now + Math.max(30_000, Number(lockTimeoutMs) || 30_000);
  const [rows] = await db.execute(
    `SELECT * FROM generation_jobs
     WHERE attempts < max_attempts
       AND (status = 'queued' OR (status = 'running' AND locked_until < ?))
     ORDER BY created_at ASC
     LIMIT ${safeLimit}`,
    [now]
  );

  const claimed: GenerationJob[] = [];
  for (const row of rows as any[]) {
    const [result] = await db.execute(
      `UPDATE generation_jobs
       SET status = 'running', attempts = attempts + 1, locked_by = ?, locked_until = ?, started_at = ?, updated_at = ?, error_message = NULL
       WHERE id = ?
         AND attempts < max_attempts
         AND (status = 'queued' OR (status = 'running' AND locked_until < ?))`,
      [workerId, lockedUntil, now, now, row.id, now]
    );

    if (getAffectedRows(result) > 0) {
      claimed.push(mapGenerationJob({
        ...row,
        status: 'running',
        attempts: Number(row.attempts || 0) + 1,
        locked_by: workerId,
        locked_until: lockedUntil,
        started_at: now,
        updated_at: now,
        error_message: null,
      }));
    }
  }

  return claimed;
}

export async function completeGenerationJob(
  jobId: string,
  workerId: string,
  generationId: string,
  updates: Partial<Pick<Generation, 'resultUrl' | 'params'>>
): Promise<boolean> {
  await initializeDatabase();
  const db = getAdapter();
  const now = Date.now();

  if (!isMySqlDatabase()) {
    const generation = await updateGenerationIfLockedByJob(generationId, jobId, workerId, {
      status: 'completed',
      resultUrl: updates.resultUrl,
      params: updates.params,
      errorMessage: '',
    });
    if (!generation) return false;

    const [result] = await db.execute(
      `UPDATE generation_jobs
       SET status = 'succeeded', payload = '{}', locked_by = '', locked_until = 0, finished_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND locked_by = ?`,
      [now, now, jobId, workerId]
    );
    return getAffectedRows(result) > 0;
  }

  const fields: string[] = ['g.updated_at = ?', 'g.status = ?'];
  const values: unknown[] = [now, 'completed'];

  if (updates.resultUrl !== undefined) {
    fields.push('g.result_url = ?');
    values.push(updates.resultUrl);
  }
  if (updates.params !== undefined) {
    fields.push('g.params = ?');
    values.push(JSON.stringify(updates.params));
    const nextClientRequestId = extractClientRequestIdFromParams(updates.params);
    if (nextClientRequestId) {
      fields.push('g.client_request_id = ?');
      values.push(nextClientRequestId);
    }
  }

  fields.push(
    'g.error_message = NULL',
    "j.status = 'succeeded'",
    "j.payload = '{}'",
    "j.locked_by = ''",
    "j.error_message = NULL",
    'j.locked_until = 0',
    'j.finished_at = ?',
    'j.updated_at = ?'
  );
  values.push(now, now, jobId, workerId, now, generationId);

  const [result] = await db.execute(
    `UPDATE generations g
     JOIN generation_jobs j ON j.generation_id = g.id
     SET ${fields.join(', ')}
     WHERE j.id = ?
       AND j.status = 'running'
       AND j.locked_by = ?
       AND j.locked_until >= ?
       AND g.id = ?`,
    values
  );
  return getAffectedRows(result) > 0;
}

export async function failGenerationJob(
  jobId: string,
  workerId: string,
  generationId: string,
  errorMessage: string,
  retry: boolean,
  updates: Partial<Pick<Generation, 'params'>> = {}
): Promise<boolean> {
  await initializeDatabase();
  const db = getAdapter();
  const now = Date.now();

  if (!isMySqlDatabase()) {
    const generation = await updateGenerationIfLockedByJob(generationId, jobId, workerId, {
      status: retry ? 'pending' : 'failed',
      errorMessage,
      params: updates.params,
    });
    if (!generation) return false;

    if (retry) {
      const [result] = await db.execute(
        `UPDATE generation_jobs
         SET status = 'queued', locked_by = '', locked_until = 0, updated_at = ?, error_message = ?
         WHERE id = ? AND status = 'running' AND locked_by = ?`,
        [now, errorMessage, jobId, workerId]
      );
      return getAffectedRows(result) > 0;
    }

    const [result] = await db.execute(
      `UPDATE generation_jobs
       SET status = 'failed', payload = '{}', locked_by = '', locked_until = 0, finished_at = ?, updated_at = ?, error_message = ?
       WHERE id = ? AND status = 'running' AND locked_by = ?`,
      [now, now, errorMessage, jobId, workerId]
    );
    return getAffectedRows(result) > 0;
  }

  const fields: string[] = ['g.updated_at = ?', 'g.error_message = ?'];
  const values: unknown[] = [now, errorMessage];
  if (updates.params !== undefined) {
    fields.push('g.params = ?');
    values.push(JSON.stringify(updates.params));
  }

  if (retry) {
    fields.push('g.status = ?');
    values.push('pending');
  } else {
    fields.push('g.status = ?');
    values.push('failed');
    fields.push(
      "j.status = 'failed'",
      "j.payload = '{}'",
      "j.locked_by = ''",
      'j.locked_until = 0',
      'j.finished_at = ?'
    );
    values.push(now);
  }

  if (retry) {
    fields.push(
      "j.status = 'queued'",
      "j.locked_by = ''",
      'j.locked_until = 0',
      'j.updated_at = ?',
      'j.error_message = ?'
    );
    values.push(now, errorMessage);
  } else {
    fields.push('j.updated_at = ?', 'j.error_message = ?');
    values.push(now, errorMessage);
  }

  values.push(jobId, workerId, now, generationId);
  const [result] = await db.execute(
    `UPDATE generations g
     JOIN generation_jobs j ON j.generation_id = g.id
     SET ${fields.join(', ')}
     WHERE j.id = ?
       AND j.status = 'running'
       AND j.locked_by = ?
       AND j.locked_until >= ?
       AND g.id = ?`,
    values
  );
  return getAffectedRows(result) > 0;
}

export async function releaseGenerationJob(jobId: string, workerId: string, errorMessage: string): Promise<boolean> {
  await initializeDatabase();
  const db = getAdapter();
  const now = Date.now();
  const [result] = await db.execute(
    `UPDATE generation_jobs
     SET status = 'queued', attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END, locked_by = '', locked_until = 0, updated_at = ?, error_message = ?
     WHERE id = ? AND status = 'running' AND locked_by = ?`,
    [now, errorMessage, jobId, workerId]
  );
  return getAffectedRows(result) > 0;
}

export async function renewGenerationJobLock(
  jobId: string,
  workerId: string,
  lockTimeoutMs: number
): Promise<boolean> {
  await initializeDatabase();
  const db = getAdapter();
  const now = Date.now();
  const lockedUntil = now + Math.max(30_000, Number(lockTimeoutMs) || 30_000);
  const [result] = await db.execute(
    `UPDATE generation_jobs
     SET locked_until = ?, updated_at = ?
     WHERE id = ? AND status = 'running' AND locked_by = ?`,
    [lockedUntil, now, jobId, workerId]
  );
  return getAffectedRows(result) > 0;
}

export async function sweepExpiredGenerationJobs(limit: number): Promise<GenerationJob[]> {
  await initializeDatabase();
  const db = getAdapter();
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const now = Date.now();
  const [rows] = await db.execute(
    `SELECT * FROM generation_jobs
     WHERE status = 'running'
       AND locked_until < ?
       AND attempts >= max_attempts
     ORDER BY locked_until ASC, created_at ASC
     LIMIT ${safeLimit}`,
    [now]
  );

  const expired: GenerationJob[] = [];
  for (const row of rows as any[]) {
    const [result] = await db.execute(
      `UPDATE generation_jobs
       SET status = 'failed', payload = '{}', locked_by = '', locked_until = 0, finished_at = ?, updated_at = ?, error_message = ?
       WHERE id = ? AND status = 'running' AND locked_until < ? AND attempts >= max_attempts`,
      [now, now, 'Generation job expired after reaching max attempts', row.id, now]
    );

    if (getAffectedRows(result) > 0) {
      expired.push(mapGenerationJob({
        ...row,
        status: 'failed',
        locked_by: '',
        locked_until: 0,
        finished_at: now,
        updated_at: now,
        error_message: 'Generation job expired after reaching max attempts',
      }));
    }
  }

  return expired;
}

export type UserGenerationKindFilter = 'all' | 'video' | 'image';
export type UserGenerationStatusFilter =
  | 'all'
  | 'active'
  | 'terminal'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface GetUserGenerationsOptions {
  kind?: UserGenerationKindFilter;
  status?: UserGenerationStatusFilter;
}

export async function getUserGenerations(
  userId: string,
  limit = 50,
  offset = 0,
  options: GetUserGenerationsOptions = {}
): Promise<Generation[]> {
  await initializeDatabase();
  const db = getAdapter();
  const safeLimit = Math.max(Number(limit) || 50, 1);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const whereClauses = ['user_id = ?'];
  const values: any[] = [userId];

  if (options.kind === 'video') {
    whereClauses.push('type LIKE ?');
    values.push('%video%');
  } else if (options.kind === 'image') {
    whereClauses.push('type NOT LIKE ?');
    whereClauses.push('type <> ?');
    values.push('%video%', 'character-card');
  }

  switch (options.status) {
    case 'active':
      whereClauses.push("status IN ('pending', 'processing')");
      break;
    case 'terminal':
      whereClauses.push("(status IN ('completed', 'failed', 'cancelled') OR status IS NULL)");
      break;
    case 'completed':
      whereClauses.push("(status = 'completed' OR status IS NULL)");
      break;
    case 'pending':
    case 'processing':
    case 'failed':
    case 'cancelled':
      whereClauses.push('status = ?');
      values.push(options.status);
      break;
    case 'all':
    default:
      break;
  }

  const [rows] = await db.execute(
    `SELECT * FROM generations WHERE ${whereClauses.join(' AND ')} ORDER BY created_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    values
  );

  return (rows as any[]).map(mapGenerationRow);
}

export async function getUserGenerationBatches(
  userId: string,
  limit = 20
): Promise<GenerationBatchSummary[]> {
  await initializeDatabase();
  const db = getAdapter();
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const [rows] = await db.execute(
    `SELECT id, prompt, params, result_url, cost, status, created_at, updated_at
     FROM generations
     WHERE user_id = ? AND params LIKE ?
     ORDER BY created_at DESC
     LIMIT 500`,
    [userId, '%"batchId"%']
  );

  const batches = new Map<string, GenerationBatchSummary>();
  for (const row of rows as any[]) {
    const generation = mapGenerationRow({ ...row, user_id: userId, type: 'gemini-image' });
    const batchId = generation.params.batchId;
    if (!batchId) continue;

    const batchName = generation.params.batchName || `Batch ${batchId.slice(0, 8)}`;
    const current = batches.get(batchId) || {
      batchId,
      batchName,
      total: 0,
      completed: 0,
      failed: 0,
      active: 0,
      totalCost: 0,
      createdAt: generation.createdAt,
      updatedAt: generation.updatedAt,
      samplePrompt: generation.prompt || undefined,
      sampleResultUrl: generation.resultUrl || undefined,
    };

    current.total += 1;
    current.totalCost += generation.cost || 0;
    current.createdAt = Math.min(current.createdAt, generation.createdAt);
    current.updatedAt = Math.max(current.updatedAt, generation.updatedAt);
    if (!current.samplePrompt && generation.prompt) current.samplePrompt = generation.prompt;
    if (!current.sampleResultUrl && generation.resultUrl) current.sampleResultUrl = generation.resultUrl;

    if (generation.status === 'completed') {
      current.completed += 1;
    } else if (generation.status === 'failed' || generation.status === 'cancelled') {
      current.failed += 1;
    } else {
      current.active += 1;
    }

    batches.set(batchId, current);
  }

  return Array.from(batches.values())
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, safeLimit);
}

export async function getUserConsumptionRecords(
  userId: string,
  limit = 20,
  offset = 0
): Promise<ConsumptionRecord[]> {
  await initializeDatabase();
  const db = getAdapter();
  const safeLimit = Math.max(Number(limit) || 20, 1);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const [rows] = await db.execute(
    `SELECT id, type, prompt, cost, balance_refunded, status, created_at, updated_at
     FROM generations
     WHERE user_id = ? AND cost > 0 AND balance_precharged = 1
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [userId]
  );

  return (rows as any[]).map((row) => {
    const cost = Number(row.cost) || 0;
    const refunded = Boolean(row.balance_refunded);
    return {
      id: row.id,
      generationId: row.id,
      type: row.type,
      prompt: row.prompt || '',
      cost,
      netCost: refunded ? 0 : cost,
      refunded,
      status: row.status || 'completed',
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at || row.created_at),
    };
  });
}

// Get in-progress user generations.
export async function getPendingGenerations(userId: string, limit = 50): Promise<Generation[]> {
  await initializeDatabase();
  const db = getAdapter();
  const safeLimit = Math.max(Number(limit) || 50, 1);

  const [rows] = await db.execute(
    `SELECT * FROM generations WHERE user_id = ? AND status IN ('pending', 'processing') ORDER BY created_at DESC LIMIT ${safeLimit}`,
    [userId]
  );

  return (rows as any[]).map((row) => ({
    id: row.id,
    userId: row.user_id,
    type: row.type,
    prompt: row.prompt,
    params: typeof row.params === 'string' ? JSON.parse(row.params) : row.params,
    resultUrl: row.result_url,
    cost: row.cost,
    status: row.status,
    balancePrecharged: Boolean(row.balance_precharged),
    balanceRefunded: Boolean(row.balance_refunded),
    errorMessage: row.error_message || undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at || row.created_at),
  }));
}

export async function getPendingGenerationsCount(): Promise<number> {
  await initializeDatabase();
  const db = getAdapter();

  const [rows] = await db.execute(
    `SELECT COUNT(1) as count FROM generations WHERE status IN ('pending', 'processing')`
  );

  return Number((rows as any[])[0]?.count || 0);
}

export async function getUserIdsWithRecentSoraVideos(sinceMs: number): Promise<string[]> {
  await initializeDatabase();
  const db = getAdapter();

  const [rows] = await db.execute(
    `SELECT DISTINCT user_id FROM generations
     WHERE type = 'sora-video'
     AND (created_at >= ? OR status IN ('pending', 'processing'))`,
    [sinceMs]
  );

  return (rows as any[]).map((row) => String(row.user_id));
}

export async function getRecentSoraVideoGenerationsByUser(
  userId: string,
  limit = 20
): Promise<Generation[]> {
  await initializeDatabase();
  const db = getAdapter();
  const safeLimit = Math.max(Number(limit) || 20, 1);

  const [rows] = await db.execute(
    `SELECT * FROM generations
     WHERE user_id = ? AND type = 'sora-video'
     ORDER BY created_at DESC LIMIT ${safeLimit}`,
    [userId]
  );

  return (rows as any[]).map((row) => ({
    id: row.id,
    userId: row.user_id,
    type: row.type,
    prompt: row.prompt,
    params: typeof row.params === 'string' ? JSON.parse(row.params) : row.params,
    resultUrl: row.result_url,
    cost: row.cost,
    status: row.status || 'completed',
    balancePrecharged: Boolean(row.balance_precharged),
    balanceRefunded: Boolean(row.balance_refunded),
    errorMessage: row.error_message || undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at || row.created_at),
  }));
}

export async function getRecentSoraVideoGenerations(limit = 20): Promise<Generation[]> {
  await initializeDatabase();
  const db = getAdapter();
  const safeLimit = Math.max(Number(limit) || 20, 1);

  const [rows] = await db.execute(
    `SELECT * FROM generations
     WHERE type = 'sora-video'
     ORDER BY created_at DESC LIMIT ${safeLimit}`
  );

  return (rows as any[]).map((row) => ({
    id: row.id,
    userId: row.user_id,
    type: row.type,
    prompt: row.prompt,
    params: typeof row.params === 'string' ? JSON.parse(row.params) : row.params,
    resultUrl: row.result_url,
    cost: row.cost,
    status: row.status || 'completed',
    balancePrecharged: Boolean(row.balance_precharged),
    balanceRefunded: Boolean(row.balance_refunded),
    errorMessage: row.error_message || undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at || row.created_at),
  }));
}

export async function getGeneration(id: string): Promise<Generation | null> {
  await initializeDatabase();
  const db = getAdapter();

  const [rows] = await db.execute('SELECT * FROM generations WHERE id = ?', [id]);
  const gens = rows as any[];
  if (gens.length === 0) return null;

  const row = gens[0];
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    prompt: row.prompt,
    params: typeof row.params === 'string' ? JSON.parse(row.params) : row.params,
    resultUrl: row.result_url,
    cost: row.cost,
    status: row.status || 'completed',
    balancePrecharged: Boolean(row.balance_precharged),
    balanceRefunded: Boolean(row.balance_refunded),
    errorMessage: row.error_message || undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at || row.created_at),
  };
}

// 删除单个生成记录
export async function getReferencedLocalMediaFilenames(): Promise<Set<string>> {
  await initializeDatabase();
  const db = getAdapter();

  const [rows] = await db.execute(
    "SELECT result_url FROM generations WHERE result_url LIKE 'file:%'"
  );
  const filenames = new Set<string>();

  for (const row of rows as Array<{ result_url?: unknown }>) {
    if (typeof row.result_url !== 'string') continue;
    const filename = getLocalMediaFilenameFromResultUrl(row.result_url);
    if (filename) {
      filenames.add(filename);
    }
  }

  return filenames;
}

export async function deleteGeneration(id: string, userId: string): Promise<boolean> {
  await initializeDatabase();
  const db = getAdapter();

  await db.execute(
    'DELETE FROM generation_jobs WHERE generation_id = ? AND user_id = ?',
    [id, userId]
  );

  const [result] = await db.execute(
    'DELETE FROM generations WHERE id = ? AND user_id = ?',
    [id, userId]
  );

  return (result as any).affectedRows > 0;
}

// 批量删除生成记录
export async function deleteGenerations(ids: string[], userId: string): Promise<number> {
  if (ids.length === 0) return 0;
  
  await initializeDatabase();
  const db = getAdapter();

  const placeholders = ids.map(() => '?').join(',');
  await db.execute(
    `DELETE FROM generation_jobs WHERE generation_id IN (${placeholders}) AND user_id = ?`,
    [...ids, userId]
  );

  const [result] = await db.execute(
    `DELETE FROM generations WHERE id IN (${placeholders}) AND user_id = ?`,
    [...ids, userId]
  );

  return (result as any).affectedRows || 0;
}

// 清空用户所有已完成的生成记录
export async function deleteAllUserGenerations(userId: string): Promise<number> {
  await initializeDatabase();
  const db = getAdapter();

  // 只删除已完成或失败的，保留进行中的任务
  await db.execute(
    `DELETE FROM generation_jobs
     WHERE user_id = ?
       AND generation_id IN (
         SELECT id FROM generations
         WHERE user_id = ? AND status NOT IN ('pending', 'processing')
       )`,
    [userId, userId]
  );

  const [result] = await db.execute(
    `DELETE FROM generations WHERE user_id = ? AND status NOT IN ('pending', 'processing')`,
    [userId]
  );

  return (result as any).affectedRows || 0;
}

// 清空用户所有失败的生成记录
export async function deleteAllFailedGenerations(userId: string): Promise<number> {
  await initializeDatabase();
  const db = getAdapter();

  await db.execute(
    `DELETE FROM generation_jobs
     WHERE user_id = ?
       AND generation_id IN (
         SELECT id FROM generations
         WHERE user_id = ? AND status IN ('failed', 'cancelled')
       )`,
    [userId, userId]
  );

  const [result] = await db.execute(
    `DELETE FROM generations WHERE user_id = ? AND status IN ('failed', 'cancelled')`,
    [userId]
  );

  return (result as any).affectedRows || 0;
}

// Escape LIKE wildcards inside a batchId before embedding it in a params pattern
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Delete all generation records of one batch (active tasks are kept)
export async function deleteGenerationBatch(batchId: string, userId: string): Promise<number> {
  await initializeDatabase();
  const db = getAdapter();
  const paramsPattern = `%"batchId":"${escapeLikePattern(batchId)}"%`;

  await db.execute(
    `DELETE FROM generation_jobs
     WHERE user_id = ?
       AND generation_id IN (
         SELECT id FROM generations
         WHERE user_id = ? AND params LIKE ? AND status NOT IN ('pending', 'processing')
       )`,
    [userId, userId, paramsPattern]
  );

  const [result] = await db.execute(
    `DELETE FROM generations
     WHERE user_id = ? AND params LIKE ? AND status NOT IN ('pending', 'processing')`,
    [userId, paramsPattern]
  );

  return (result as any).affectedRows || 0;
}

// Delete all batch generation records (active tasks are kept)
export async function deleteAllGenerationBatches(userId: string): Promise<number> {
  await initializeDatabase();
  const db = getAdapter();

  await db.execute(
    `DELETE FROM generation_jobs
     WHERE user_id = ?
       AND generation_id IN (
         SELECT id FROM generations
         WHERE user_id = ? AND params LIKE ? AND status NOT IN ('pending', 'processing')
       )`,
    [userId, userId, '%"batchId"%']
  );

  const [result] = await db.execute(
    `DELETE FROM generations
     WHERE user_id = ? AND params LIKE ? AND status NOT IN ('pending', 'processing')`,
    [userId, '%"batchId"%']
  );

  return (result as any).affectedRows || 0;
}

// 获取用户今日使用量统计
export interface DailyUsageStats {
  imageCount: number;
  videoCount: number;
  characterCardCount: number;
}

export async function getUserDailyUsage(userId: string): Promise<DailyUsageStats> {
  await initializeDatabase();
  const db = getAdapter();

  // 获取今天 0 点的时间戳
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  // 统计今日图像生成数量（包括 pending/processing/completed）
  const [imageRows] = await db.execute(
    `SELECT COUNT(1) as count FROM generations 
     WHERE user_id = ? AND created_at >= ? 
     AND type IN ('sora-image', 'gemini-image', 'zimage-image', 'gitee-image')
     AND status != 'cancelled'`,
    [userId, todayStart]
  );
  const imageCount = Number((imageRows as any[])[0]?.count || 0);

  // 统计今日视频生成数量
  const [videoRows] = await db.execute(
    `SELECT COUNT(1) as count FROM generations 
     WHERE user_id = ? AND created_at >= ? 
     AND type = 'sora-video'
     AND status != 'cancelled'`,
    [userId, todayStart]
  );
  const videoCount = Number((videoRows as any[])[0]?.count || 0);

  // 统计今日角色卡生成数量
  const [cardRows] = await db.execute(
    `SELECT COUNT(1) as count FROM character_cards 
     WHERE user_id = ? AND created_at >= ?
     AND status != 'cancelled'`,
    [userId, todayStart]
  );
  const characterCardCount = Number((cardRows as any[])[0]?.count || 0);

  return { imageCount, videoCount, characterCardCount };
}

const LEGACY_IMAGE_BUCKET_ID = 'legacy-picui-default';

function normalizeImageBucketProvider(value: unknown): ImageBucketConfig['provider'] {
  if (value === 's3-compatible') return 's3-compatible';
  if (value === 'lsky-v2') return 'lsky-v2';
  return 'picui';
}

function sanitizeImageBucket(
  value: unknown,
  index: number
): ImageBucketConfig | null {
  if (!value || typeof value !== 'object') return null;

  const bucket = value as Record<string, unknown>;
  const provider = normalizeImageBucketProvider(bucket.provider);
  const id =
    typeof bucket.id === 'string' && bucket.id.trim()
      ? bucket.id.trim()
      : `bucket-${index + 1}`;

  return {
    id,
    name:
      typeof bucket.name === 'string' && bucket.name.trim()
        ? bucket.name.trim()
        : `Bucket ${index + 1}`,
    provider,
    baseUrl: typeof bucket.baseUrl === 'string' ? bucket.baseUrl.trim() : '',
    apiKey: typeof bucket.apiKey === 'string' ? bucket.apiKey.trim() : '',
    secretKey:
      typeof bucket.secretKey === 'string' ? bucket.secretKey.trim() : undefined,
    bucketName:
      typeof bucket.bucketName === 'string' ? bucket.bucketName.trim() : undefined,
    storageId:
      typeof bucket.storageId === 'string' ? bucket.storageId.trim() : undefined,
    region: typeof bucket.region === 'string' ? bucket.region.trim() : undefined,
    publicBaseUrl:
      typeof bucket.publicBaseUrl === 'string'
        ? bucket.publicBaseUrl.trim()
        : undefined,
    pathPrefix:
      typeof bucket.pathPrefix === 'string' ? bucket.pathPrefix.trim() : undefined,
    forcePathStyle: bucket.forcePathStyle !== false,
    enabled: bucket.enabled !== false,
  };
}

function parseImageStorageBuckets(raw: unknown): ImageBucketConfig[] {
  if (!raw) return [];

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((value, index) => sanitizeImageBucket(value, index))
    .filter((bucket): bucket is ImageBucketConfig => Boolean(bucket));
}

function buildLegacyPicuiBucket(
  baseUrl: string,
  apiKey: string
): ImageBucketConfig | null {
  if (!baseUrl && !apiKey) return null;

  return {
    id: LEGACY_IMAGE_BUCKET_ID,
    name: 'Legacy PicUI',
    provider: 'picui',
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
    enabled: true,
    forcePathStyle: true,
  };
}

function resolveImageStorageConfig(row?: Record<string, unknown>): ImageStorageConfig {
  const buckets = parseImageStorageBuckets(row?.image_storage_buckets);
  const defaultBucketId =
    typeof row?.image_storage_default_bucket_id === 'string'
      ? row.image_storage_default_bucket_id.trim()
      : '';

  if (buckets.length > 0) {
    return {
      defaultBucketId:
        defaultBucketId ||
        buckets.find((bucket) => bucket.enabled)?.id ||
        buckets[0]?.id,
      buckets,
    };
  }

  const legacyBucket = buildLegacyPicuiBucket(
    typeof row?.picui_base_url === 'string' ? row.picui_base_url : '',
    typeof row?.picui_api_key === 'string' ? row.picui_api_key : ''
  );

  return {
    defaultBucketId: legacyBucket?.id,
    buckets: legacyBucket ? [legacyBucket] : [],
  };
}

function defaultEmailVerificationConfig(): EmailVerificationConfig {
  return {
    enabled: false,
    domainWhitelistEnabled: false,
    allowedDomains: '',
    aliasRestrictionEnabled: false,
    codeExpiresMinutes: 10,
    smtp: {
      host: '',
      port: 465,
      username: '',
      password: '',
      fromEmail: '',
      secure: true,
      authLogin: true,
    },
  };
}

function resolveEmailVerificationConfig(
  row?: Record<string, unknown>
): EmailVerificationConfig {
  const defaults = defaultEmailVerificationConfig();
  if (!row) return defaults;

  return {
    enabled: Boolean(row.email_verification_enabled),
    domainWhitelistEnabled: Boolean(row.email_domain_whitelist_enabled),
    allowedDomains:
      typeof row.email_allowed_domains === 'string' ? row.email_allowed_domains : '',
    aliasRestrictionEnabled: Boolean(row.email_alias_restriction_enabled),
    codeExpiresMinutes: Math.max(
      1,
      Number(row.email_code_expires_minutes) || defaults.codeExpiresMinutes
    ),
    smtp: {
      host: typeof row.smtp_host === 'string' ? row.smtp_host : '',
      port: Math.max(1, Number(row.smtp_port) || defaults.smtp.port),
      username: typeof row.smtp_username === 'string' ? row.smtp_username : '',
      password: typeof row.smtp_password === 'string' ? row.smtp_password : '',
      fromEmail: typeof row.smtp_from_email === 'string' ? row.smtp_from_email : '',
      secure: row.smtp_secure !== 0,
      authLogin: row.smtp_auth_login !== 0,
    },
  };
}

function defaultGenerationQueueConfig(): GenerationQueueConfig {
  return {
    enabled: true,
    imageConcurrency: 16,
    channelConcurrency: 16,
    lockTimeoutSeconds: 900,
    maxAttempts: 2,
  };
}

function resolveGenerationQueueConfig(
  row?: Record<string, unknown>
): GenerationQueueConfig {
  const defaults = defaultGenerationQueueConfig();
  if (!row) return defaults;

  return {
    enabled: row.generation_queue_enabled !== 0,
    imageConcurrency: Math.max(
      1,
      Number(row.generation_queue_image_concurrency) || defaults.imageConcurrency
    ),
    channelConcurrency: Math.max(
      1,
      Number(row.generation_queue_channel_concurrency) || defaults.channelConcurrency
    ),
    lockTimeoutSeconds: Math.max(
      30,
      Number(row.generation_queue_lock_timeout_seconds) || defaults.lockTimeoutSeconds
    ),
    maxAttempts: Math.max(
      1,
      Number(row.generation_queue_max_attempts) || defaults.maxAttempts
    ),
  };
}

function defaultPaymentConfig(): PaymentConfig {
  return {
    enabled: false,
    serverBaseUrl: '',
    callbackUrl: '',
    pointsPerCny: 100,
    methods: [
      {
        color: 'rgba(var(--semi-blue-5), 1)',
        name: '支付宝',
        type: 'alipay',
      },
    ],
    amountOptions: [10, 20, 50, 100, 200, 500],
    amountDiscounts: {
      '50': 0.96,
      '100': 0.92,
      '200': 0.9,
      '500': 0.85,
    },
    easyPay: {
      baseUrl: 'https://ezfpy.cn',
      merchantId: '',
      apiKey: '',
      minAmountCny: 1,
    },
  };
}

function parseJsonValue<T>(raw: unknown, fallback: T): T {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw as T;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function resolvePaymentConfig(row?: Record<string, unknown>): PaymentConfig {
  const defaults = defaultPaymentConfig();
  if (!row) return defaults;

  return {
    enabled: Boolean(row.payment_enabled),
    serverBaseUrl:
      typeof row.payment_server_base_url === 'string'
        ? row.payment_server_base_url
        : '',
    callbackUrl:
      typeof row.payment_callback_url === 'string' ? row.payment_callback_url : '',
    pointsPerCny: Math.max(
      1,
      Number(row.payment_points_per_cny) || defaults.pointsPerCny
    ),
    methods: parseJsonValue(row.payment_methods, defaults.methods),
    amountOptions: parseJsonValue(row.payment_amount_options, defaults.amountOptions),
    amountDiscounts: parseJsonValue(
      row.payment_amount_discounts,
      defaults.amountDiscounts
    ),
    easyPay: {
      baseUrl:
        typeof row.easypay_base_url === 'string'
          ? row.easypay_base_url
          : defaults.easyPay.baseUrl,
      merchantId:
        typeof row.easypay_merchant_id === 'string' ? row.easypay_merchant_id : '',
      apiKey: typeof row.easypay_api_key === 'string' ? row.easypay_api_key : '',
      minAmountCny: Math.max(
        1,
        Number(row.easypay_min_amount_cny) || defaults.easyPay.minAmountCny
      ),
    },
  };
}

// ========================================
// 系统配置操作
// ========================================

export async function getSystemConfig(): Promise<SystemConfig> {
  await initializeDatabase();
  return withCache(CacheKeys.SYSTEM_CONFIG, CacheTTL.SYSTEM_CONFIG, async () => {
    const db = getAdapter();

    const [rows] = await db.execute('SELECT * FROM system_config WHERE id = 1');
    const configs = rows as any[];

    if (configs.length === 0) {
      // 返回默认配置
      return {
        soraApiKey: process.env.SORA_API_KEY || '',
        soraBaseUrl: process.env.SORA_BASE_URL || 'http://localhost:8000',
        soraBackendUrl: '',
        soraBackendUsername: '',
        soraBackendPassword: '',
        soraBackendToken: '',
        geminiApiKey: process.env.GEMINI_API_KEY || '',
        geminiBaseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
      zimageApiKey: process.env.ZIMAGE_API_KEY || '',
      zimageBaseUrl: process.env.ZIMAGE_BASE_URL || 'https://api-inference.modelscope.cn/',
        giteeFreeApiKey: process.env.GITEE_FREE_API_KEY || '',
        giteeApiKey: process.env.GITEE_API_KEY || '',
        giteeBaseUrl: process.env.GITEE_BASE_URL || 'https://ai.gitee.com/',
        picuiApiKey: process.env.PICUI_API_KEY || '',
        picuiBaseUrl: process.env.PICUI_BASE_URL || 'https://picui.cn/api/v1',
        imageStorage: {
          defaultBucketId:
            process.env.PICUI_API_KEY || process.env.PICUI_BASE_URL
              ? LEGACY_IMAGE_BUCKET_ID
              : undefined,
          buckets:
            process.env.PICUI_API_KEY || process.env.PICUI_BASE_URL
              ? [
                  {
                    id: LEGACY_IMAGE_BUCKET_ID,
                    name: 'Legacy PicUI',
                    provider: 'picui',
                    baseUrl:
                      process.env.PICUI_BASE_URL || 'https://picui.cn/api/v1',
                    apiKey: process.env.PICUI_API_KEY || '',
                    enabled: true,
                    forcePathStyle: true,
                  },
                ]
              : [],
        },
        pricing: {
          soraVideo10s: 100,
          soraVideo15s: 150,
          soraVideo25s: 200,
          soraImage: 50,
          geminiNano: 10,
          geminiPro: 30,
          zimageImage: 30,
          giteeImage: 30,
        },
        registerEnabled: true,
        defaultBalance: 100,
        featureFlags: {
          squareEnabled: true,
          gachaEnabled: true,
          characterCardEnabled: true,
        },
        inviteSettings: {
          enabled: true,
          rewardEnabled: true,
          inviteeBonusPoints: 100,
          inviterBonusPoints: 50,
        },
        emailVerification: defaultEmailVerificationConfig(),
        payment: defaultPaymentConfig(),
        generationQueue: defaultGenerationQueueConfig(),
        announcement: {
          title: '',
          content: '',
          enabled: false,
          updatedAt: 0,
        },
        channelEnabled: {
          sora: true,
          gemini: true,
          zimage: true,
          gitee: true,
        },
        dailyLimit: {
          imageLimit: 0,
          videoLimit: 0,
          characterCardLimit: 0,
        },
        siteConfig: {
          siteName: 'SANHUB',
          siteTagline: 'Let Imagination Come Alive',
          siteDescription: '「SANHUB」是专为 AI 创作打造的一站式平台',
          siteSubDescription: '我们融合了 Sora 视频生成、Gemini 图像创作与多模型 AI 对话。在这里，技术壁垒已然消融，你唯一的使命就是释放纯粹的想象。',
          contactEmail: 'support@sanhub.com',
          copyright: 'Copyright © 2025 SANHUB',
          poweredBy: 'Powered by OpenAI Sora & Google Gemini',
          pointsPurchaseUrl: '',
        },
        disabledModels: {
          imageModels: [],
          videoModels: [],
        },
        videoProxyEnabled: false,
        videoProxyBaseUrl: '',
        promptProcessing: {
          filterEnabled: false,
          filterModelId: '',
          filterPrompt: 'You are a safety prompt filter for video generation. Rewrite the user prompt into a safe version while preserving creative intent as much as possible. Return only the rewritten prompt text.',
          translateEnabled: false,
          translateModelId: '',
          translatePrompt: 'Translate the user prompt into clear, natural English for video generation. Preserve details, style, and constraints. Return only the translated prompt text.',
          blocklistEnabled: false,
          blocklistWords: '',
        },
        rateLimit: {
          imageMaxRequests: 30,
          imageWindowSeconds: 60,
          videoMaxRequests: 30,
          videoWindowSeconds: 60,
        },
      };
    }

    const row = configs[0];
    const imageStorage = resolveImageStorageConfig(row);
    return {
      soraApiKey: row.sora_api_key || '',
      soraBaseUrl: row.sora_base_url || 'http://localhost:8000',
      soraBackendUrl: row.sora_backend_url || '',
      soraBackendUsername: row.sora_backend_username || '',
      soraBackendPassword: row.sora_backend_password || '',
      soraBackendToken: row.sora_backend_token || '',
      geminiApiKey: row.gemini_api_key || '',
    geminiBaseUrl: row.gemini_base_url || 'https://generativelanguage.googleapis.com',
    zimageApiKey: row.zimage_api_key || '',
    zimageBaseUrl: row.zimage_base_url || 'https://api-inference.modelscope.cn/',
    giteeFreeApiKey: row.gitee_free_api_key || '',
    giteeApiKey: row.gitee_api_key || '',
    giteeBaseUrl: row.gitee_base_url || 'https://ai.gitee.com/',
      picuiApiKey: row.picui_api_key || '',
      picuiBaseUrl: row.picui_base_url || 'https://picui.cn/api/v1',
      imageStorage,
      pricing: {
        soraVideo10s: row.pricing_sora_video_10s || 100,
        soraVideo15s: row.pricing_sora_video_15s || 150,
        soraVideo25s: row.pricing_sora_video_25s || 200,
        soraImage: row.pricing_sora_image || 50,
        geminiNano: row.pricing_gemini_nano || 10,
        geminiPro: row.pricing_gemini_pro || 30,
        zimageImage: row.pricing_zimage_image || 30,
        giteeImage: row.pricing_gitee_image || 30,
      },
      registerEnabled: Boolean(row.register_enabled),
      defaultBalance: row.default_balance || 100,
      featureFlags: {
        squareEnabled: row.square_enabled !== 0,
        gachaEnabled: row.gacha_enabled !== 0,
        characterCardEnabled: row.character_card_enabled !== 0,
      },
      inviteSettings: {
        enabled: row.invite_enabled !== 0,
        rewardEnabled: row.invite_reward_enabled !== 0,
        inviteeBonusPoints: Number(row.invite_invitee_bonus) || 100,
        inviterBonusPoints: Number(row.invite_inviter_bonus) || 50,
      },
      emailVerification: resolveEmailVerificationConfig(row),
      payment: resolvePaymentConfig(row),
      generationQueue: resolveGenerationQueueConfig(row),
      announcement: {
        title: row.announcement_title || '',
        content: row.announcement_content || '',
        enabled: Boolean(row.announcement_enabled),
        updatedAt: Number(row.announcement_updated_at) || 0,
      },
      channelEnabled: {
        sora: row.channel_sora_enabled !== 0,
        gemini: row.channel_gemini_enabled !== 0,
        zimage: row.channel_zimage_enabled !== 0,
        gitee: row.channel_gitee_enabled !== 0,
      },
      dailyLimit: {
        imageLimit: row.daily_limit_image || 0,
        videoLimit: row.daily_limit_video || 0,
        characterCardLimit: row.daily_limit_character_card || 0,
      },
      siteConfig: {
        siteName: row.site_name || 'SANHUB',
        siteTagline: row.site_tagline || 'Let Imagination Come Alive',
        siteDescription: row.site_description || '「SANHUB」是专为 AI 创作打造的一站式平台',
        siteSubDescription: row.site_sub_description || '我们融合了 Sora 视频生成、Gemini 图像创作与多模型 AI 对话。在这里，技术壁垒已然消融，你唯一的使命就是释放纯粹的想象。',
        contactEmail: row.contact_email || 'support@sanhub.com',
        copyright: row.site_copyright || 'Copyright © 2025 SANHUB',
        poweredBy: row.site_powered_by || 'Powered by OpenAI Sora & Google Gemini',
        pointsPurchaseUrl: row.site_points_purchase_url || '',
      },
      disabledModels: {
        imageModels: row.disabled_image_models ? JSON.parse(row.disabled_image_models) : [],
        videoModels: row.disabled_video_models ? JSON.parse(row.disabled_video_models) : [],
      },
      videoProxyEnabled: Boolean(row.video_proxy_enabled),
      videoProxyBaseUrl: row.video_proxy_base_url || '',
      promptProcessing: {
        filterEnabled: Boolean(row.prompt_filter_enabled),
        filterModelId: row.prompt_filter_model_id || '',
        filterPrompt: row.prompt_filter_prompt || 'You are a safety prompt filter for video generation. Rewrite the user prompt into a safe version while preserving creative intent as much as possible. Return only the rewritten prompt text.',
        translateEnabled: Boolean(row.prompt_translate_enabled),
        translateModelId: row.prompt_translate_model_id || '',
        translatePrompt: row.prompt_translate_prompt || 'Translate the user prompt into clear, natural English for video generation. Preserve details, style, and constraints. Return only the translated prompt text.',
        blocklistEnabled: Boolean(row.prompt_blocklist_enabled),
        blocklistWords: row.prompt_blocklist_words || '',
      },
      rateLimit: {
        imageMaxRequests: Number(row.rate_limit_image_max_requests) || 30,
        imageWindowSeconds: Number(row.rate_limit_image_window_seconds) || 60,
        videoMaxRequests: Number(row.rate_limit_video_max_requests) || 30,
        videoWindowSeconds: Number(row.rate_limit_video_window_seconds) || 60,
      },
    };
  });
}

export async function updateSystemConfig(
  updates: Partial<SystemConfig>
): Promise<SystemConfig> {
  await initializeDatabase();
  const db = getAdapter();

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.soraApiKey !== undefined) {
    fields.push('sora_api_key = ?');
    values.push(updates.soraApiKey);
  }
  if (updates.soraBaseUrl !== undefined) {
    fields.push('sora_base_url = ?');
    values.push(updates.soraBaseUrl);
  }
  if (updates.soraBackendUrl !== undefined) {
    fields.push('sora_backend_url = ?');
    values.push(updates.soraBackendUrl);
  }
  if (updates.soraBackendUsername !== undefined) {
    fields.push('sora_backend_username = ?');
    values.push(updates.soraBackendUsername);
  }
  if (updates.soraBackendPassword !== undefined) {
    fields.push('sora_backend_password = ?');
    values.push(updates.soraBackendPassword);
  }
  if (updates.soraBackendToken !== undefined) {
    fields.push('sora_backend_token = ?');
    values.push(updates.soraBackendToken);
  }
  if (updates.geminiApiKey !== undefined) {
    fields.push('gemini_api_key = ?');
    values.push(updates.geminiApiKey);
  }
  if (updates.geminiBaseUrl !== undefined) {
    fields.push('gemini_base_url = ?');
    values.push(updates.geminiBaseUrl);
  }
  if (updates.zimageApiKey !== undefined) {
    fields.push('zimage_api_key = ?');
    values.push(updates.zimageApiKey);
  }
  if (updates.zimageBaseUrl !== undefined) {
    fields.push('zimage_base_url = ?');
    values.push(updates.zimageBaseUrl);
  }
  if (updates.giteeApiKey !== undefined) {
    fields.push('gitee_api_key = ?');
    values.push(updates.giteeApiKey);
  }
  if (updates.giteeFreeApiKey !== undefined) {
    fields.push('gitee_free_api_key = ?');
    values.push(updates.giteeFreeApiKey);
  }
  if (updates.giteeBaseUrl !== undefined) {
    fields.push('gitee_base_url = ?');
    values.push(updates.giteeBaseUrl);
  }
  if (updates.picuiApiKey !== undefined) {
    fields.push('picui_api_key = ?');
    values.push(updates.picuiApiKey);
  }
  if (updates.picuiBaseUrl !== undefined) {
    fields.push('picui_base_url = ?');
    values.push(updates.picuiBaseUrl);
  }
  if (updates.pricing) {
    const p = updates.pricing as Partial<PricingConfig>;
    if (p.soraVideo10s !== undefined) {
      fields.push('pricing_sora_video_10s = ?');
      values.push(p.soraVideo10s);
    }
    if (p.soraVideo15s !== undefined) {
      fields.push('pricing_sora_video_15s = ?');
      values.push(p.soraVideo15s);
    }
    if (p.soraVideo25s !== undefined) {
      fields.push('pricing_sora_video_25s = ?');
      values.push(p.soraVideo25s);
    }
    if (p.soraImage !== undefined) {
      fields.push('pricing_sora_image = ?');
      values.push(p.soraImage);
    }
    if (p.geminiNano !== undefined) {
      fields.push('pricing_gemini_nano = ?');
      values.push(p.geminiNano);
    }
    if (p.geminiPro !== undefined) {
      fields.push('pricing_gemini_pro = ?');
      values.push(p.geminiPro);
    }
    if (p.zimageImage !== undefined) {
      fields.push('pricing_zimage_image = ?');
      values.push(p.zimageImage);
    }
    if (p.giteeImage !== undefined) {
      fields.push('pricing_gitee_image = ?');
      values.push(p.giteeImage);
    }
  }
  if (updates.registerEnabled !== undefined) {
    fields.push('register_enabled = ?');
    values.push(updates.registerEnabled);
  }
  if (updates.defaultBalance !== undefined) {
    fields.push('default_balance = ?');
    values.push(updates.defaultBalance);
  }
  if (updates.featureFlags) {
    const featureFlags = updates.featureFlags;
    if (featureFlags.squareEnabled !== undefined) {
      fields.push('square_enabled = ?');
      values.push(featureFlags.squareEnabled ? 1 : 0);
    }
    if (featureFlags.gachaEnabled !== undefined) {
      fields.push('gacha_enabled = ?');
      values.push(featureFlags.gachaEnabled ? 1 : 0);
    }
    if (featureFlags.characterCardEnabled !== undefined) {
      fields.push('character_card_enabled = ?');
      values.push(featureFlags.characterCardEnabled ? 1 : 0);
    }
  }
  if (updates.inviteSettings) {
    const inviteSettings = updates.inviteSettings;
    if (inviteSettings.enabled !== undefined) {
      fields.push('invite_enabled = ?');
      values.push(inviteSettings.enabled ? 1 : 0);
    }
    if (inviteSettings.rewardEnabled !== undefined) {
      fields.push('invite_reward_enabled = ?');
      values.push(inviteSettings.rewardEnabled ? 1 : 0);
    }
    if (inviteSettings.inviteeBonusPoints !== undefined) {
      fields.push('invite_invitee_bonus = ?');
      values.push(inviteSettings.inviteeBonusPoints);
    }
    if (inviteSettings.inviterBonusPoints !== undefined) {
      fields.push('invite_inviter_bonus = ?');
      values.push(inviteSettings.inviterBonusPoints);
    }
  }
  if (updates.emailVerification) {
    const emailVerification = updates.emailVerification;
    if (emailVerification.enabled !== undefined) {
      fields.push('email_verification_enabled = ?');
      values.push(emailVerification.enabled ? 1 : 0);
    }
    if (emailVerification.domainWhitelistEnabled !== undefined) {
      fields.push('email_domain_whitelist_enabled = ?');
      values.push(emailVerification.domainWhitelistEnabled ? 1 : 0);
    }
    if (emailVerification.allowedDomains !== undefined) {
      fields.push('email_allowed_domains = ?');
      values.push(emailVerification.allowedDomains);
    }
    if (emailVerification.aliasRestrictionEnabled !== undefined) {
      fields.push('email_alias_restriction_enabled = ?');
      values.push(emailVerification.aliasRestrictionEnabled ? 1 : 0);
    }
    if (emailVerification.codeExpiresMinutes !== undefined) {
      fields.push('email_code_expires_minutes = ?');
      values.push(emailVerification.codeExpiresMinutes);
    }
    if (emailVerification.smtp) {
      const smtp = emailVerification.smtp;
      if (smtp.host !== undefined) {
        fields.push('smtp_host = ?');
        values.push(smtp.host);
      }
      if (smtp.port !== undefined) {
        fields.push('smtp_port = ?');
        values.push(smtp.port);
      }
      if (smtp.username !== undefined) {
        fields.push('smtp_username = ?');
        values.push(smtp.username);
      }
      if (smtp.password !== undefined) {
        fields.push('smtp_password = ?');
        values.push(smtp.password);
      }
      if (smtp.fromEmail !== undefined) {
        fields.push('smtp_from_email = ?');
        values.push(smtp.fromEmail);
      }
      if (smtp.secure !== undefined) {
        fields.push('smtp_secure = ?');
        values.push(smtp.secure ? 1 : 0);
      }
      if (smtp.authLogin !== undefined) {
        fields.push('smtp_auth_login = ?');
        values.push(smtp.authLogin ? 1 : 0);
      }
    }
  }
  if (updates.payment) {
    const payment = updates.payment;
    if (payment.enabled !== undefined) {
      fields.push('payment_enabled = ?');
      values.push(payment.enabled ? 1 : 0);
    }
    if (payment.serverBaseUrl !== undefined) {
      fields.push('payment_server_base_url = ?');
      values.push(payment.serverBaseUrl);
    }
    if (payment.callbackUrl !== undefined) {
      fields.push('payment_callback_url = ?');
      values.push(payment.callbackUrl);
    }
    if (payment.pointsPerCny !== undefined) {
      fields.push('payment_points_per_cny = ?');
      values.push(payment.pointsPerCny);
    }
    if (payment.methods !== undefined) {
      fields.push('payment_methods = ?');
      values.push(JSON.stringify(payment.methods));
    }
    if (payment.amountOptions !== undefined) {
      fields.push('payment_amount_options = ?');
      values.push(JSON.stringify(payment.amountOptions));
    }
    if (payment.amountDiscounts !== undefined) {
      fields.push('payment_amount_discounts = ?');
      values.push(JSON.stringify(payment.amountDiscounts));
    }
    if (payment.easyPay) {
      const easyPay = payment.easyPay;
      if (easyPay.baseUrl !== undefined) {
        fields.push('easypay_base_url = ?');
        values.push(easyPay.baseUrl);
      }
      if (easyPay.merchantId !== undefined) {
        fields.push('easypay_merchant_id = ?');
        values.push(easyPay.merchantId);
      }
      if (easyPay.apiKey !== undefined) {
        fields.push('easypay_api_key = ?');
        values.push(easyPay.apiKey);
      }
      if (easyPay.minAmountCny !== undefined) {
        fields.push('easypay_min_amount_cny = ?');
        values.push(easyPay.minAmountCny);
      }
    }
  }
  if (updates.generationQueue) {
    const queue = updates.generationQueue;
    if (queue.enabled !== undefined) {
      fields.push('generation_queue_enabled = ?');
      values.push(queue.enabled ? 1 : 0);
    }
    if (queue.imageConcurrency !== undefined) {
      fields.push('generation_queue_image_concurrency = ?');
      values.push(queue.imageConcurrency);
    }
    if (queue.channelConcurrency !== undefined) {
      fields.push('generation_queue_channel_concurrency = ?');
      values.push(queue.channelConcurrency);
    }
    if (queue.lockTimeoutSeconds !== undefined) {
      fields.push('generation_queue_lock_timeout_seconds = ?');
      values.push(queue.lockTimeoutSeconds);
    }
    if (queue.maxAttempts !== undefined) {
      fields.push('generation_queue_max_attempts = ?');
      values.push(queue.maxAttempts);
    }
  }
  if (updates.imageStorage) {
    const imageStorage = updates.imageStorage;
    const buckets = (imageStorage.buckets || []).map((bucket, index) =>
      sanitizeImageBucket(bucket, index)
    ).filter((bucket): bucket is ImageBucketConfig => Boolean(bucket));

    const defaultBucketId =
      typeof imageStorage.defaultBucketId === 'string'
        ? imageStorage.defaultBucketId
        : '';
    const defaultBucket =
      buckets.find((bucket) => bucket.id === defaultBucketId) ||
      buckets.find((bucket) => bucket.enabled);

    fields.push('image_storage_buckets = ?');
    values.push(JSON.stringify(buckets));
    fields.push('image_storage_default_bucket_id = ?');
    values.push(defaultBucket?.id || '');

    if (defaultBucket?.provider === 'picui') {
      fields.push('picui_base_url = ?');
      values.push(defaultBucket.baseUrl);
      fields.push('picui_api_key = ?');
      values.push(defaultBucket.apiKey);
    } else {
      fields.push('picui_base_url = ?');
      values.push('');
      fields.push('picui_api_key = ?');
      values.push('');
    }
  }
  // 公告配置
  if (updates.announcement) {
    const a = updates.announcement;
    if (a.title !== undefined) {
      fields.push('announcement_title = ?');
      values.push(a.title);
    }
    if (a.content !== undefined) {
      fields.push('announcement_content = ?');
      values.push(a.content);
    }
    if (a.enabled !== undefined) {
      fields.push('announcement_enabled = ?');
      values.push(a.enabled);
    }
    fields.push('announcement_updated_at = ?');
    values.push(Date.now());
  }
  // 渠道启用配置
  if (updates.channelEnabled) {
    const c = updates.channelEnabled;
    if (c.sora !== undefined) {
      fields.push('channel_sora_enabled = ?');
      values.push(c.sora ? 1 : 0);
    }
    if (c.gemini !== undefined) {
      fields.push('channel_gemini_enabled = ?');
      values.push(c.gemini ? 1 : 0);
    }
    if (c.zimage !== undefined) {
      fields.push('channel_zimage_enabled = ?');
      values.push(c.zimage ? 1 : 0);
    }
    if (c.gitee !== undefined) {
      fields.push('channel_gitee_enabled = ?');
      values.push(c.gitee ? 1 : 0);
    }
  }
  // 每日请求限制配置
  if (updates.dailyLimit) {
    const d = updates.dailyLimit;
    if (d.imageLimit !== undefined) {
      fields.push('daily_limit_image = ?');
      values.push(d.imageLimit);
    }
    if (d.videoLimit !== undefined) {
      fields.push('daily_limit_video = ?');
      values.push(d.videoLimit);
    }
    if (d.characterCardLimit !== undefined) {
      fields.push('daily_limit_character_card = ?');
      values.push(d.characterCardLimit);
    }
  }
  // 网站配置
  if (updates.siteConfig) {
    const s = updates.siteConfig;
    if (s.siteName !== undefined) {
      fields.push('site_name = ?');
      values.push(s.siteName);
    }
    if (s.siteTagline !== undefined) {
      fields.push('site_tagline = ?');
      values.push(s.siteTagline);
    }
    if (s.siteDescription !== undefined) {
      fields.push('site_description = ?');
      values.push(s.siteDescription);
    }
    if (s.siteSubDescription !== undefined) {
      fields.push('site_sub_description = ?');
      values.push(s.siteSubDescription);
    }
    if (s.contactEmail !== undefined) {
      fields.push('contact_email = ?');
      values.push(s.contactEmail);
    }
    if (s.copyright !== undefined) {
      fields.push('site_copyright = ?');
      values.push(s.copyright);
    }
    if (s.poweredBy !== undefined) {
      fields.push('site_powered_by = ?');
      values.push(s.poweredBy);
    }
    if (s.pointsPurchaseUrl !== undefined) {
      fields.push('site_points_purchase_url = ?');
      values.push(s.pointsPurchaseUrl);
    }
  }
  // 模型禁用配置
  if (updates.disabledModels) {
    const d = updates.disabledModels;
    if (d.imageModels !== undefined) {
      fields.push('disabled_image_models = ?');
      values.push(JSON.stringify(d.imageModels));
    }
    if (d.videoModels !== undefined) {
      fields.push('disabled_video_models = ?');
      values.push(JSON.stringify(d.videoModels));
    }
  }
  // 视频加速配置
  if (updates.videoProxyEnabled !== undefined) {
    fields.push('video_proxy_enabled = ?');
    values.push(updates.videoProxyEnabled ? 1 : 0);
  }
  if (updates.videoProxyBaseUrl !== undefined) {
    fields.push('video_proxy_base_url = ?');
    values.push(updates.videoProxyBaseUrl);
  }

  // 提示词处理配置
  if (updates.promptProcessing) {
    const p = updates.promptProcessing;
    if (p.filterEnabled !== undefined) {
      fields.push('prompt_filter_enabled = ?');
      values.push(p.filterEnabled ? 1 : 0);
    }
    if (p.filterModelId !== undefined) {
      fields.push('prompt_filter_model_id = ?');
      values.push(p.filterModelId);
    }
    if (p.filterPrompt !== undefined) {
      fields.push('prompt_filter_prompt = ?');
      values.push(p.filterPrompt);
    }
    if (p.translateEnabled !== undefined) {
      fields.push('prompt_translate_enabled = ?');
      values.push(p.translateEnabled ? 1 : 0);
    }
    if (p.translateModelId !== undefined) {
      fields.push('prompt_translate_model_id = ?');
      values.push(p.translateModelId);
    }
    if (p.translatePrompt !== undefined) {
      fields.push('prompt_translate_prompt = ?');
      values.push(p.translatePrompt);
    }

    if (p.blocklistEnabled !== undefined) {
      fields.push('prompt_blocklist_enabled = ?');
      values.push(p.blocklistEnabled ? 1 : 0);
    }

    if (p.blocklistWords !== undefined) {
      fields.push('prompt_blocklist_words = ?');
      values.push(p.blocklistWords);
    }
  }

  // 生成限流配置
  if (updates.rateLimit) {
    const r = updates.rateLimit;
    if (r.imageMaxRequests !== undefined) {
      fields.push('rate_limit_image_max_requests = ?');
      values.push(r.imageMaxRequests);
    }
    if (r.imageWindowSeconds !== undefined) {
      fields.push('rate_limit_image_window_seconds = ?');
      values.push(r.imageWindowSeconds);
    }
    if (r.videoMaxRequests !== undefined) {
      fields.push('rate_limit_video_max_requests = ?');
      values.push(r.videoMaxRequests);
    }
    if (r.videoWindowSeconds !== undefined) {
      fields.push('rate_limit_video_window_seconds = ?');
      values.push(r.videoWindowSeconds);
    }
  }

  if (fields.length > 0) {
    await db.execute(
      `UPDATE system_config SET ${fields.join(', ')} WHERE id = 1`,
      values
    );
    cache.delete(CacheKeys.SYSTEM_CONFIG);
  }

  return getSystemConfig();
}

// ========================================
// 初始化管理员
// ========================================

async function initializeAdmin(): Promise<void> {
  const db = getAdapter();
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@sanhub.local';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const dbType = process.env.DB_TYPE || 'sqlite';
  const hashedPassword = await bcrypt.hash(adminPassword, 10);
  const now = Date.now();

  await db.execute(
    `${dbType === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE'} INTO users (id, email, password, name, role, balance, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [generateId(), adminEmail, hashedPassword, 'Admin', 'admin', 999999, now, now]
  );
}

// ========================================
// 聊天模型操作
// ========================================

export async function getChatModels(enabledOnly = false): Promise<ChatModel[]> {
  await initializeDatabase();
  const db = getAdapter();

  const sql = enabledOnly
    ? 'SELECT * FROM chat_models WHERE enabled = TRUE ORDER BY created_at ASC'
    : 'SELECT * FROM chat_models ORDER BY created_at ASC';

  const [rows] = await db.execute(sql);

  return (rows as any[]).map((row) => ({
    id: row.id,
    name: row.name,
    apiUrl: row.api_url,
    apiKey: row.api_key,
    modelId: row.model_id,
    supportsVision: Boolean(row.supports_vision),
    maxTokens: row.max_tokens,
    enabled: Boolean(row.enabled),
    costPerMessage: row.cost_per_message,
    createdAt: Number(row.created_at),
  }));
}

export async function getChatModel(id: string): Promise<ChatModel | null> {
  await initializeDatabase();
  const db = getAdapter();

  const [rows] = await db.execute('SELECT * FROM chat_models WHERE id = ?', [id]);
  const models = rows as any[];
  if (models.length === 0) return null;

  const row = models[0];
  return {
    id: row.id,
    name: row.name,
    apiUrl: row.api_url,
    apiKey: row.api_key,
    modelId: row.model_id,
    supportsVision: Boolean(row.supports_vision),
    maxTokens: row.max_tokens,
    enabled: Boolean(row.enabled),
    costPerMessage: row.cost_per_message,
    createdAt: Number(row.created_at),
  };
}

export async function createChatModel(model: Omit<ChatModel, 'id' | 'createdAt'>): Promise<ChatModel> {
  await initializeDatabase();
  const db = getAdapter();

  const id = generateId();
  const now = Date.now();

  await db.execute(
    `INSERT INTO chat_models (id, name, api_url, api_key, model_id, supports_vision, max_tokens, enabled, cost_per_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, model.name, model.apiUrl, model.apiKey, model.modelId, model.supportsVision, model.maxTokens, model.enabled, model.costPerMessage, now]
  );

  return { ...model, id, createdAt: now };
}

export async function updateChatModel(id: string, updates: Partial<Omit<ChatModel, 'id' | 'createdAt'>>): Promise<ChatModel | null> {
  await initializeDatabase();
  const db = getAdapter();

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.apiUrl !== undefined) { fields.push('api_url = ?'); values.push(updates.apiUrl); }
  if (updates.apiKey !== undefined) { fields.push('api_key = ?'); values.push(updates.apiKey); }
  if (updates.modelId !== undefined) { fields.push('model_id = ?'); values.push(updates.modelId); }
  if (updates.supportsVision !== undefined) { fields.push('supports_vision = ?'); values.push(updates.supportsVision); }
  if (updates.maxTokens !== undefined) { fields.push('max_tokens = ?'); values.push(updates.maxTokens); }
  if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled); }
  if (updates.costPerMessage !== undefined) { fields.push('cost_per_message = ?'); values.push(updates.costPerMessage); }

  if (fields.length === 0) return getChatModel(id);

  values.push(id);
  await db.execute(`UPDATE chat_models SET ${fields.join(', ')} WHERE id = ?`, values);

  return getChatModel(id);
}

export async function deleteChatModel(id: string): Promise<boolean> {
  await initializeDatabase();
  const db = getAdapter();

  const [result] = await db.execute('DELETE FROM chat_models WHERE id = ?', [id]);
  return (result as any).affectedRows > 0;
}

// ========================================
// 聊天会话操作
// ========================================

export async function createChatSession(userId: string, modelId: string, title = '新对话'): Promise<ChatSession> {
  await initializeDatabase();
  const db = getAdapter();

  const id = generateId();
  const now = Date.now();

  await db.execute(
    `INSERT INTO chat_sessions (id, user_id, title, model_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, title, modelId, now, now]
  );

  return { id, userId, title, modelId, createdAt: now, updatedAt: now };
}

export async function getUserChatSessions(userId: string, limit = 50): Promise<ChatSession[]> {
  await initializeDatabase();
  const db = getAdapter();
  const safeLimit = Math.max(Number(limit) || 50, 1);

  const [rows] = await db.execute(
    `SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ${safeLimit}`,
    [userId]
  );

  return (rows as any[]).map((row) => ({
    id: row.id,
    userId: row.user_id,
    title: row.title,
    modelId: row.model_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

export async function getChatSession(id: string): Promise<ChatSession | null> {
  await initializeDatabase();
  const db = getAdapter();

  const [rows] = await db.execute('SELECT * FROM chat_sessions WHERE id = ?', [id]);
  const sessions = rows as any[];
  if (sessions.length === 0) return null;

  const row = sessions[0];
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    modelId: row.model_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function updateChatSession(id: string, updates: { title?: string; modelId?: string }): Promise<ChatSession | null> {
  await initializeDatabase();
  const db = getAdapter();

  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];

  if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
  if (updates.modelId !== undefined) { fields.push('model_id = ?'); values.push(updates.modelId); }

  values.push(id);
  await db.execute(`UPDATE chat_sessions SET ${fields.join(', ')} WHERE id = ?`, values);

  return getChatSession(id);
}

export async function deleteChatSession(id: string): Promise<boolean> {
  await initializeDatabase();
  const db = getAdapter();

  const [result] = await db.execute('DELETE FROM chat_sessions WHERE id = ?', [id]);
  return (result as any).affectedRows > 0;
}

// ========================================
// 聊天消息操作
// ========================================

export async function saveChatMessage(message: Omit<ChatMessage, 'id' | 'createdAt'>): Promise<ChatMessage> {
  await initializeDatabase();
  const db = getAdapter();

  const id = generateId();
  const now = Date.now();

  await db.execute(
    `INSERT INTO chat_messages (id, session_id, role, content, images, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, message.sessionId, message.role, message.content, JSON.stringify(message.images || []), message.tokenCount, now]
  );

  // 更新会话时间
  await db.execute('UPDATE chat_sessions SET updated_at = ? WHERE id = ?', [now, message.sessionId]);

  return { ...message, id, createdAt: now };
}

export async function getSessionMessages(sessionId: string, limit = 100): Promise<ChatMessage[]> {
  await initializeDatabase();
  const db = getAdapter();
  const safeLimit = Math.max(Number(limit) || 100, 1);

  const [rows] = await db.execute(
    `SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ${safeLimit}`,
    [sessionId]
  );

  return (rows as any[]).map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    images: typeof row.images === 'string' ? JSON.parse(row.images) : (row.images || []),
    tokenCount: row.token_count,
    createdAt: Number(row.created_at),
  }));
}

// 获取会话消息用于上下文（自动截断�?maxTokens 的一半）
export async function getSessionContext(sessionId: string, maxTokens = 128000): Promise<ChatMessage[]> {
  const messages = await getSessionMessages(sessionId, 200);
  
  // 截断�?maxTokens 的一半（64k for 128k context�?
  const targetTokens = Math.floor(maxTokens / 2);
  let totalTokens = 0;
  const result: ChatMessage[] = [];

  // 从最新消息开始，保留最近的对话
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (totalTokens + msg.tokenCount > targetTokens && result.length > 0) {
      break;
    }
    result.push(msg);
    totalTokens += msg.tokenCount;
  }

  return result.reverse();
}

export async function deleteSessionMessages(sessionId: string): Promise<boolean> {
  await initializeDatabase();
  const db = getAdapter();

  const [result] = await db.execute('DELETE FROM chat_messages WHERE session_id = ?', [sessionId]);
  return (result as any).affectedRows > 0;
}

// ========================================
// 角色卡操作
// ========================================

export async function saveCharacterCard(
  card: Omit<CharacterCard, 'id' | 'createdAt' | 'updatedAt'>
): Promise<CharacterCard> {
  await initializeDatabase();
  const db = getAdapter();

  const now = Date.now();
  const newCard: CharacterCard = {
    ...card,
    id: generateId(),
    createdAt: now,
    updatedAt: now,
  };

  await db.execute(
    `INSERT INTO character_cards (id, user_id, character_name, avatar_url, source_video_url, status, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newCard.id,
      newCard.userId,
      newCard.characterName,
      newCard.avatarUrl,
      newCard.sourceVideoUrl || null,
      newCard.status,
      newCard.errorMessage || null,
      newCard.createdAt,
      newCard.updatedAt,
    ]
  );

  return newCard;
}

export async function updateCharacterCard(
  id: string,
  updates: Partial<Pick<CharacterCard, 'characterName' | 'avatarUrl' | 'status' | 'errorMessage'>>
): Promise<CharacterCard | null> {
  await initializeDatabase();
  const db = getAdapter();

  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];

  if (updates.characterName !== undefined) {
    fields.push('character_name = ?');
    values.push(updates.characterName);
  }
  if (updates.avatarUrl !== undefined) {
    fields.push('avatar_url = ?');
    values.push(updates.avatarUrl);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.errorMessage !== undefined) {
    fields.push('error_message = ?');
    values.push(updates.errorMessage);
  }

  values.push(id);
  await db.execute(
    `UPDATE character_cards SET ${fields.join(', ')} WHERE id = ?`,
    values
  );

  return getCharacterCard(id);
}

export async function getCharacterCard(id: string): Promise<CharacterCard | null> {
  await initializeDatabase();
  const db = getAdapter();

  const [rows] = await db.execute('SELECT * FROM character_cards WHERE id = ?', [id]);
  const cards = rows as any[];
  if (cards.length === 0) return null;

  const row = cards[0];
  return {
    id: row.id,
    userId: row.user_id,
    characterName: row.character_name || '',
    avatarUrl: row.avatar_url || '',
    sourceVideoUrl: row.source_video_url || undefined,
    status: row.status || 'pending',
    errorMessage: row.error_message || undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at || row.created_at),
  };
}

export async function getUserCharacterCards(
  userId: string,
  limit = 50,
  offset = 0
): Promise<CharacterCard[]> {
  await initializeDatabase();
  const db = getAdapter();
  const safeLimit = Math.max(Number(limit) || 50, 1);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const [rows] = await db.execute(
    `SELECT * FROM character_cards WHERE user_id = ? ORDER BY created_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [userId]
  );

  return (rows as any[]).map((row) => ({
    id: row.id,
    userId: row.user_id,
    characterName: row.character_name || '',
    avatarUrl: row.avatar_url || '',
    sourceVideoUrl: row.source_video_url || undefined,
    status: row.status || 'pending',
    errorMessage: row.error_message || undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at || row.created_at),
  }));
}

export async function getPendingCharacterCards(userId: string, limit = 50): Promise<CharacterCard[]> {
  await initializeDatabase();
  const db = getAdapter();
  const safeLimit = Math.max(Number(limit) || 50, 1);

  const [rows] = await db.execute(
    `SELECT * FROM character_cards WHERE user_id = ? AND status IN ('pending', 'processing') ORDER BY created_at DESC LIMIT ${safeLimit}`,
    [userId]
  );

  return (rows as any[]).map((row) => ({
    id: row.id,
    userId: row.user_id,
    characterName: row.character_name || '',
    avatarUrl: row.avatar_url || '',
    sourceVideoUrl: row.source_video_url || undefined,
    status: row.status,
    errorMessage: row.error_message || undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at || row.created_at),
  }));
}

export async function deleteCharacterCard(id: string, userId: string): Promise<boolean> {
  await initializeDatabase();
  const db = getAdapter();

  const [result] = await db.execute(
    'DELETE FROM character_cards WHERE id = ? AND user_id = ?',
    [id, userId]
  );

  return (result as any).affectedRows > 0;
}

// ========================================
// Workspace operations
// ========================================

function parseWorkspaceData(raw: unknown): WorkspaceData {
  if (!raw) {
    return { nodes: [], edges: [] };
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as WorkspaceData;
      return {
        nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      };
    } catch {
      return { nodes: [], edges: [] };
    }
  }
  if (typeof raw === 'object' && raw !== null) {
    const data = raw as WorkspaceData;
    return {
      nodes: Array.isArray(data.nodes) ? data.nodes : [],
      edges: Array.isArray(data.edges) ? data.edges : [],
    };
  }
  return { nodes: [], edges: [] };
}

export async function createWorkspace(
  userId: string,
  name: string,
  data: WorkspaceData = { nodes: [], edges: [] }
): Promise<Workspace> {
  await initializeDatabase();
  const db = getAdapter();
  const id = generateId();
  const now = Date.now();
  const safeData = parseWorkspaceData(data);

  await db.execute(
    `INSERT INTO workspaces (id, user_id, name, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, name, JSON.stringify(safeData), now, now]
  );

  return {
    id,
    userId,
    name,
    data: safeData,
    createdAt: now,
    updatedAt: now,
  };
}

export async function getWorkspaceSummaries(
  userId: string,
  options: { search?: string; sort?: 'updated' | 'created'; order?: 'asc' | 'desc'; limit?: number; offset?: number } = {}
): Promise<WorkspaceSummary[]> {
  await initializeDatabase();
  const db = getAdapter();
  const limit = Math.max(Number(options.limit) || 200, 1);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const search = options.search?.trim();
  const sort = options.sort === 'created' ? 'created_at' : 'updated_at';
  const order = options.order === 'asc' ? 'ASC' : 'DESC';

  let sql = 'SELECT id, name, created_at, updated_at FROM workspaces WHERE user_id = ?';
  const params: unknown[] = [userId];

  if (search) {
    sql += ' AND name LIKE ?';
    params.push(`%${search}%`);
  }

  sql += ` ORDER BY ${sort} ${order} LIMIT ${limit} OFFSET ${offset}`;

  const [rows] = await db.execute(sql, params);

  return (rows as any[]).map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

export async function getWorkspaceById(userId: string, id: string): Promise<Workspace | null> {
  await initializeDatabase();
  const db = getAdapter();

  const [rows] = await db.execute(
    'SELECT * FROM workspaces WHERE id = ? AND user_id = ?',
    [id, userId]
  );
  const workspaces = rows as any[];
  if (workspaces.length === 0) return null;

  const row = workspaces[0];
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    data: parseWorkspaceData(row.data),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function updateWorkspace(
  userId: string,
  id: string,
  updates: { name?: string; data?: WorkspaceData }
): Promise<Workspace | null> {
  await initializeDatabase();
  const db = getAdapter();

  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.data !== undefined) {
    const safeData = parseWorkspaceData(updates.data);
    fields.push('data = ?');
    values.push(JSON.stringify(safeData));
  }

  if (fields.length === 1) {
    return getWorkspaceById(userId, id);
  }

  values.push(id, userId);

  await db.execute(
    `UPDATE workspaces SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
    values
  );

  return getWorkspaceById(userId, id);
}

export async function deleteWorkspace(userId: string, id: string): Promise<boolean> {
  await initializeDatabase();
  const db = getAdapter();

  const [result] = await db.execute(
    'DELETE FROM workspaces WHERE id = ? AND user_id = ?',
    [id, userId]
  );

  return (result as any).affectedRows > 0;
}


// ========================================
// 图像渠道操作
// ========================================

import type {
  ImageChannel,
  ImageModel,
  SafeImageChannel,
  SafeImageModel,
  ChannelType,
  ImageModelFeatures,
  VideoChannelType,
} from '@/types';

// 创建图像渠道表（在 initializeDatabase 中调用）
const CREATE_IMAGE_CHANNELS_SQL = `
CREATE TABLE IF NOT EXISTS image_channels (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(50) NOT NULL,
  base_url VARCHAR(500) DEFAULT '',
  api_key TEXT,
  enabled TINYINT(1) DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  INDEX idx_enabled (enabled),
  INDEX idx_type (type)
);

CREATE TABLE IF NOT EXISTS image_models (
  id VARCHAR(36) PRIMARY KEY,
  channel_id VARCHAR(36) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) DEFAULT '',
  api_model VARCHAR(200) NOT NULL,
  base_url VARCHAR(500) DEFAULT '',
  api_key TEXT,
  features TEXT NOT NULL,
  aspect_ratios TEXT NOT NULL,
  resolutions TEXT NOT NULL,
  image_sizes TEXT,
  default_aspect_ratio VARCHAR(20) DEFAULT '1:1',
  default_image_size VARCHAR(20),
  requires_reference_image TINYINT(1) DEFAULT 0,
  allow_empty_prompt TINYINT(1) DEFAULT 0,
  highlight TINYINT(1) DEFAULT 0,
  enabled TINYINT(1) DEFAULT 1,
  cost_per_generation INT DEFAULT 10,
  sort_order INT DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  INDEX idx_channel_id (channel_id),
  INDEX idx_enabled (enabled),
  INDEX idx_sort_order (sort_order)
);
`;

// 内部初始化函数（供 initializeDatabase 调用，避免循环依赖）
async function initializeImageChannelsTablesInternal(db: DatabaseAdapter): Promise<void> {
  const statements = CREATE_IMAGE_CHANNELS_SQL.split(';').filter((s) => s.trim());
  for (const statement of statements) {
    if (statement.trim()) {
      try {
        await db.execute(statement);
      } catch (e: any) {
        // 仅忽略"表已存在"错误，其他错误需要打印
        if (e?.code !== 'ER_TABLE_EXISTS_ERROR' && e?.errno !== 1050) {
          console.error('[DB] Failed to create image channels table:', e?.message || e);
        }
      }
    }
  }
}

// 初始化图像渠道和模型表
export async function initializeImageChannelsTables(): Promise<void> {
  await initializeDatabase();
  const db = getAdapter();
  await initializeImageChannelsTablesInternal(db);
}

// 获取所有图像渠道
export async function getImageChannels(enabledOnly = false): Promise<ImageChannel[]> {
  await initializeDatabase();
  await initializeImageChannelsTables();
  const db = getAdapter();

  const sql = enabledOnly
    ? 'SELECT * FROM image_channels WHERE enabled = 1 ORDER BY created_at ASC'
    : 'SELECT * FROM image_channels ORDER BY created_at ASC';

  const [rows] = await db.execute(sql);

  return (rows as any[]).map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type as ChannelType,
    baseUrl: row.base_url || '',
    apiKey: row.api_key || '',
    enabled: Boolean(row.enabled),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

// 获取单个图像渠道
export async function getImageChannel(id: string): Promise<ImageChannel | null> {
  await initializeDatabase();
  await initializeImageChannelsTables();
  const db = getAdapter();

  const [rows] = await db.execute('SELECT * FROM image_channels WHERE id = ?', [id]);
  const channels = rows as any[];
  if (channels.length === 0) return null;

  const row = channels[0];
  return {
    id: row.id,
    name: row.name,
    type: row.type as ChannelType,
    baseUrl: row.base_url || '',
    apiKey: row.api_key || '',
    enabled: Boolean(row.enabled),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// 创建图像渠道
export async function createImageChannel(
  channel: Omit<ImageChannel, 'id' | 'createdAt' | 'updatedAt'>
): Promise<ImageChannel> {
  await initializeDatabase();
  await initializeImageChannelsTables();
  const db = getAdapter();

  const id = generateId();
  const now = Date.now();

  await db.execute(
    `INSERT INTO image_channels (id, name, type, base_url, api_key, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, channel.name, channel.type, channel.baseUrl, channel.apiKey, channel.enabled ? 1 : 0, now, now]
  );

  return { ...channel, id, createdAt: now, updatedAt: now };
}

// 更新图像渠道
export async function updateImageChannel(
  id: string,
  updates: Partial<Omit<ImageChannel, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<ImageChannel | null> {
  await initializeDatabase();
  await initializeImageChannelsTables();
  const db = getAdapter();

  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.type !== undefined) { fields.push('type = ?'); values.push(updates.type); }
  if (updates.baseUrl !== undefined) { fields.push('base_url = ?'); values.push(updates.baseUrl); }
  if (updates.apiKey !== undefined) { fields.push('api_key = ?'); values.push(updates.apiKey); }
  if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }

  values.push(id);
  await db.execute(`UPDATE image_channels SET ${fields.join(', ')} WHERE id = ?`, values);

  return getImageChannel(id);
}

// 删除图像渠道
export async function deleteImageChannel(id: string): Promise<boolean> {
  await initializeDatabase();
  await initializeImageChannelsTables();
  const db = getAdapter();

  // 先删除该渠道下的所有模型
  await db.execute('DELETE FROM image_models WHERE channel_id = ?', [id]);
  
  const [result] = await db.execute('DELETE FROM image_channels WHERE id = ?', [id]);
  return (result as any).affectedRows > 0;
}

// 获取安全的渠道列表（不含敏感信息）
export async function getSafeImageChannels(enabledOnly = false): Promise<SafeImageChannel[]> {
  const channels = await getImageChannels(enabledOnly);
  return channels.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    enabled: c.enabled,
  }));
}

// ========================================
// 图像模型操作
// ========================================

function parseFeatures(raw: unknown): ImageModelFeatures {
  const defaults: ImageModelFeatures = {
    textToImage: true,
    imageToImage: false,
    upscale: false,
    matting: false,
    multipleImages: false,
    imageSize: false,
  };
  if (!raw) return defaults;
  if (typeof raw === 'string') {
    try {
      return { ...defaults, ...JSON.parse(raw) };
    } catch {
      return defaults;
    }
  }
  if (typeof raw === 'object') {
    return { ...defaults, ...(raw as ImageModelFeatures) };
  }
  return defaults;
}

function parseStringArray(raw: unknown): string[] {
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) return raw;
  return [];
}

function parseResolutions(raw: unknown): Record<string, string | Record<string, string>> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object') return raw as Record<string, string | Record<string, string>>;
  return {};
}

// 获取所有图像模型
export async function getImageModels(enabledOnly = false): Promise<ImageModel[]> {
  await initializeDatabase();
  await initializeImageChannelsTables();
  const db = getAdapter();

  const sql = enabledOnly
    ? 'SELECT * FROM image_models WHERE enabled = 1 ORDER BY sort_order ASC, created_at ASC'
    : 'SELECT * FROM image_models ORDER BY sort_order ASC, created_at ASC';

  const [rows] = await db.execute(sql);

  return (rows as any[]).map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    description: row.description || '',
    apiModel: row.api_model,
    baseUrl: row.base_url || undefined,
    apiKey: row.api_key || undefined,
    features: parseFeatures(row.features),
    aspectRatios: parseStringArray(row.aspect_ratios),
    resolutions: parseResolutions(row.resolutions),
    imageSizes: row.image_sizes ? parseStringArray(row.image_sizes) : undefined,
    defaultAspectRatio: row.default_aspect_ratio || '1:1',
    defaultImageSize: row.default_image_size || undefined,
    requiresReferenceImage: Boolean(row.requires_reference_image),
    allowEmptyPrompt: Boolean(row.allow_empty_prompt),
    highlight: Boolean(row.highlight),
    enabled: Boolean(row.enabled),
    costPerGeneration: row.cost_per_generation || 10,
    sortOrder: row.sort_order || 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

// 获取渠道下的模型
export async function getImageModelsByChannel(channelId: string, enabledOnly = false): Promise<ImageModel[]> {
  await initializeDatabase();
  await initializeImageChannelsTables();
  const db = getAdapter();

  const sql = enabledOnly
    ? 'SELECT * FROM image_models WHERE channel_id = ? AND enabled = 1 ORDER BY sort_order ASC, created_at ASC'
    : 'SELECT * FROM image_models WHERE channel_id = ? ORDER BY sort_order ASC, created_at ASC';

  const [rows] = await db.execute(sql, [channelId]);

  return (rows as any[]).map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    description: row.description || '',
    apiModel: row.api_model,
    baseUrl: row.base_url || undefined,
    apiKey: row.api_key || undefined,
    features: parseFeatures(row.features),
    aspectRatios: parseStringArray(row.aspect_ratios),
    resolutions: parseResolutions(row.resolutions),
    imageSizes: row.image_sizes ? parseStringArray(row.image_sizes) : undefined,
    defaultAspectRatio: row.default_aspect_ratio || '1:1',
    defaultImageSize: row.default_image_size || undefined,
    requiresReferenceImage: Boolean(row.requires_reference_image),
    allowEmptyPrompt: Boolean(row.allow_empty_prompt),
    highlight: Boolean(row.highlight),
    enabled: Boolean(row.enabled),
    costPerGeneration: row.cost_per_generation || 10,
    sortOrder: row.sort_order || 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

// 获取单个图像模型
export async function getImageModel(id: string): Promise<ImageModel | null> {
  await initializeDatabase();
  await initializeImageChannelsTables();
  const db = getAdapter();

  const [rows] = await db.execute('SELECT * FROM image_models WHERE id = ?', [id]);
  const models = rows as any[];
  if (models.length === 0) return null;

  const row = models[0];
  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    description: row.description || '',
    apiModel: row.api_model,
    baseUrl: row.base_url || undefined,
    apiKey: row.api_key || undefined,
    features: parseFeatures(row.features),
    aspectRatios: parseStringArray(row.aspect_ratios),
    resolutions: parseResolutions(row.resolutions),
    imageSizes: row.image_sizes ? parseStringArray(row.image_sizes) : undefined,
    defaultAspectRatio: row.default_aspect_ratio || '1:1',
    defaultImageSize: row.default_image_size || undefined,
    requiresReferenceImage: Boolean(row.requires_reference_image),
    allowEmptyPrompt: Boolean(row.allow_empty_prompt),
    highlight: Boolean(row.highlight),
    enabled: Boolean(row.enabled),
    costPerGeneration: row.cost_per_generation || 10,
    sortOrder: row.sort_order || 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// 创建图像模型
export async function createImageModel(
  model: Omit<ImageModel, 'id' | 'createdAt' | 'updatedAt'>
): Promise<ImageModel> {
  await initializeDatabase();
  await initializeImageChannelsTables();
  const db = getAdapter();

  const id = generateId();
  const now = Date.now();

  await db.execute(
    `INSERT INTO image_models (
      id, channel_id, name, description, api_model, base_url, api_key,
      features, aspect_ratios, resolutions, image_sizes,
      default_aspect_ratio, default_image_size,
      requires_reference_image, allow_empty_prompt, highlight,
      enabled, cost_per_generation, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      model.channelId,
      model.name,
      model.description,
      model.apiModel,
      model.baseUrl || '',
      model.apiKey || '',
      JSON.stringify(model.features),
      JSON.stringify(model.aspectRatios),
      JSON.stringify(model.resolutions),
      model.imageSizes ? JSON.stringify(model.imageSizes) : null,
      model.defaultAspectRatio,
      model.defaultImageSize || null,
      model.requiresReferenceImage ? 1 : 0,
      model.allowEmptyPrompt ? 1 : 0,
      model.highlight ? 1 : 0,
      model.enabled ? 1 : 0,
      model.costPerGeneration,
      model.sortOrder,
      now,
      now,
    ]
  );

  return { ...model, id, createdAt: now, updatedAt: now };
}

// 更新图像模型
export async function updateImageModel(
  id: string,
  updates: Partial<Omit<ImageModel, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<ImageModel | null> {
  await initializeDatabase();
  await initializeImageChannelsTables();
  const db = getAdapter();

  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];

  if (updates.channelId !== undefined) { fields.push('channel_id = ?'); values.push(updates.channelId); }
  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.apiModel !== undefined) { fields.push('api_model = ?'); values.push(updates.apiModel); }
  if (updates.baseUrl !== undefined) { fields.push('base_url = ?'); values.push(updates.baseUrl); }
  if (updates.apiKey !== undefined) { fields.push('api_key = ?'); values.push(updates.apiKey); }
  if (updates.features !== undefined) { fields.push('features = ?'); values.push(JSON.stringify(updates.features)); }
  if (updates.aspectRatios !== undefined) { fields.push('aspect_ratios = ?'); values.push(JSON.stringify(updates.aspectRatios)); }
  if (updates.resolutions !== undefined) { fields.push('resolutions = ?'); values.push(JSON.stringify(updates.resolutions)); }
  if (updates.imageSizes !== undefined) { fields.push('image_sizes = ?'); values.push(updates.imageSizes ? JSON.stringify(updates.imageSizes) : null); }
  if (updates.defaultAspectRatio !== undefined) { fields.push('default_aspect_ratio = ?'); values.push(updates.defaultAspectRatio); }
  if (updates.defaultImageSize !== undefined) { fields.push('default_image_size = ?'); values.push(updates.defaultImageSize); }
  if (updates.requiresReferenceImage !== undefined) { fields.push('requires_reference_image = ?'); values.push(updates.requiresReferenceImage ? 1 : 0); }
  if (updates.allowEmptyPrompt !== undefined) { fields.push('allow_empty_prompt = ?'); values.push(updates.allowEmptyPrompt ? 1 : 0); }
  if (updates.highlight !== undefined) { fields.push('highlight = ?'); values.push(updates.highlight ? 1 : 0); }
  if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
  if (updates.costPerGeneration !== undefined) { fields.push('cost_per_generation = ?'); values.push(updates.costPerGeneration); }
  if (updates.sortOrder !== undefined) { fields.push('sort_order = ?'); values.push(updates.sortOrder); }

  values.push(id);
  await db.execute(`UPDATE image_models SET ${fields.join(', ')} WHERE id = ?`, values);

  return getImageModel(id);
}

// 删除图像模型
export async function deleteImageModel(id: string): Promise<boolean> {
  await initializeDatabase();
  await initializeImageChannelsTables();
  const db = getAdapter();

  const [result] = await db.execute('DELETE FROM image_models WHERE id = ?', [id]);
  return (result as any).affectedRows > 0;
}

// 获取安全的模型列表（不含敏感信息，带渠道类型）
export async function getSafeImageModels(enabledOnly = false): Promise<SafeImageModel[]> {
  const models = await getImageModels(enabledOnly);
  const channels = await getImageChannels();
  const channelMap = new Map(channels.map((c) => [c.id, c]));

  return models
    .filter((m) => {
      const channel = channelMap.get(m.channelId);
      return channel && (!enabledOnly || channel.enabled);
    })
    .map((m) => {
      const channel = channelMap.get(m.channelId)!;
      return {
        id: m.id,
        channelId: m.channelId,
        channelType: channel.type,
        apiModel: m.apiModel,
        name: m.name,
        description: m.description,
        features: m.features,
        aspectRatios: m.aspectRatios,
        resolutions: m.resolutions,
        imageSizes: m.imageSizes,
        defaultAspectRatio: m.defaultAspectRatio,
        defaultImageSize: m.defaultImageSize,
        requiresReferenceImage: m.requiresReferenceImage,
        allowEmptyPrompt: m.allowEmptyPrompt,
        highlight: m.highlight,
        enabled: m.enabled,
        costPerGeneration: m.costPerGeneration,
      };
    });
}

// 获取模型的完整配置（包含渠道信息，用于生成时）
export async function getImageModelWithChannel(modelId: string): Promise<{
  model: ImageModel;
  channel: ImageChannel;
  effectiveBaseUrl: string;
  effectiveApiKey: string;
} | null> {
  const model = await getImageModel(modelId);
  if (!model) return null;

  const channel = await getImageChannel(model.channelId);
  if (!channel) return null;

  return {
    model,
    channel,
    effectiveBaseUrl: model.baseUrl || channel.baseUrl,
    effectiveApiKey: model.apiKey || channel.apiKey,
  };
}

// 检查是否有任何图像渠道/模型配置
export async function hasImageChannelsConfigured(): Promise<boolean> {
  await initializeDatabase();
  await initializeImageChannelsTables();
  const db = getAdapter();

  const [rows] = await db.execute('SELECT COUNT(1) as count FROM image_channels');
  const count = Number((rows as any[])[0]?.count || 0);
  return count > 0;
}

// ========================================
// 视频渠道操作
// ========================================

import type {
  VideoChannel,
  VideoModel,
  SafeVideoChannel,
  SafeVideoModel,
  VideoModelFeatures,
  VideoDuration,
  VideoConfigObject,
} from '@/types';

// 创建视频渠道表
const CREATE_VIDEO_CHANNELS_SQL = `
CREATE TABLE IF NOT EXISTS video_channels (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(50) NOT NULL,
  base_url VARCHAR(500) DEFAULT '',
  api_key TEXT,
  enabled TINYINT(1) DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  INDEX idx_enabled (enabled)
);

CREATE TABLE IF NOT EXISTS video_models (
  id VARCHAR(36) PRIMARY KEY,
  channel_id VARCHAR(36) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) DEFAULT '',
  api_model VARCHAR(200) NOT NULL,
  base_url VARCHAR(500) DEFAULT '',
  api_key TEXT,
  features TEXT NOT NULL,
  aspect_ratios TEXT NOT NULL,
  durations TEXT NOT NULL,
  default_aspect_ratio VARCHAR(20) DEFAULT 'landscape',
  default_duration VARCHAR(20) DEFAULT '8s',
  video_config_object TEXT,
  highlight TINYINT(1) DEFAULT 0,
  enabled TINYINT(1) DEFAULT 1,
  sort_order INT DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  INDEX idx_channel_id (channel_id),
  INDEX idx_enabled (enabled)
);
`;

// 内部初始化函数（供 initializeDatabase 调用，避免循环依赖）
async function initializeVideoChannelsTablesInternal(db: DatabaseAdapter): Promise<void> {
  const statements = CREATE_VIDEO_CHANNELS_SQL.split(';').filter((s) => s.trim());
  for (const statement of statements) {
    if (statement.trim()) {
      try {
        await db.execute(statement);
      } catch (e: any) {
        // 仅忽略"表已存在"错误，其他错误需要打印
        if (e?.code !== 'ER_TABLE_EXISTS_ERROR' && e?.errno !== 1050) {
          console.error('[DB] Failed to create video channels table:', e?.message || e);
        }
      }
    }
  }

  try {
    await db.execute('ALTER TABLE video_models ADD COLUMN video_config_object TEXT');
  } catch {
    // ignore duplicate/missing-table errors
  }
}

// 初始化视频渠道表
export async function initializeVideoChannelsTables(): Promise<void> {
  await initializeDatabase();
  const db = getAdapter();
  await initializeVideoChannelsTablesInternal(db);
}

// 获取所有视频渠道
export async function getVideoChannels(enabledOnly = false): Promise<VideoChannel[]> {
  await initializeDatabase();
  await initializeVideoChannelsTables();
  const db = getAdapter();

  const sql = enabledOnly
    ? 'SELECT * FROM video_channels WHERE enabled = 1 ORDER BY created_at ASC'
    : 'SELECT * FROM video_channels ORDER BY created_at ASC';

  const [rows] = await db.execute(sql);

  return (rows as any[]).map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type as VideoChannelType,
    baseUrl: row.base_url || '',
    apiKey: row.api_key || '',
    enabled: Boolean(row.enabled),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

// 获取单个视频渠道
export async function getVideoChannel(id: string): Promise<VideoChannel | null> {
  await initializeDatabase();
  await initializeVideoChannelsTables();
  const db = getAdapter();

  const [rows] = await db.execute('SELECT * FROM video_channels WHERE id = ?', [id]);
  const channels = rows as any[];
  if (channels.length === 0) return null;

  const row = channels[0];
  return {
    id: row.id,
    name: row.name,
    type: row.type as VideoChannelType,
    baseUrl: row.base_url || '',
    apiKey: row.api_key || '',
    enabled: Boolean(row.enabled),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// 创建视频渠道
export async function createVideoChannel(
  channel: Omit<VideoChannel, 'id' | 'createdAt' | 'updatedAt'>
): Promise<VideoChannel> {
  await initializeDatabase();
  await initializeVideoChannelsTables();
  const db = getAdapter();

  const id = generateId();
  const now = Date.now();

  await db.execute(
    `INSERT INTO video_channels (id, name, type, base_url, api_key, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, channel.name, channel.type, channel.baseUrl, channel.apiKey, channel.enabled ? 1 : 0, now, now]
  );

  return { ...channel, id, createdAt: now, updatedAt: now };
}

// 更新视频渠道
export async function updateVideoChannel(
  id: string,
  updates: Partial<Omit<VideoChannel, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<VideoChannel | null> {
  await initializeDatabase();
  await initializeVideoChannelsTables();
  const db = getAdapter();

  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.type !== undefined) { fields.push('type = ?'); values.push(updates.type); }
  if (updates.baseUrl !== undefined) { fields.push('base_url = ?'); values.push(updates.baseUrl); }
  if (updates.apiKey !== undefined) { fields.push('api_key = ?'); values.push(updates.apiKey); }
  if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }

  values.push(id);
  await db.execute(`UPDATE video_channels SET ${fields.join(', ')} WHERE id = ?`, values);

  return getVideoChannel(id);
}

// 删除视频渠道
export async function deleteVideoChannel(id: string): Promise<boolean> {
  await initializeDatabase();
  await initializeVideoChannelsTables();
  const db = getAdapter();

  await db.execute('DELETE FROM video_models WHERE channel_id = ?', [id]);
  const [result] = await db.execute('DELETE FROM video_channels WHERE id = ?', [id]);
  return (result as any).affectedRows > 0;
}

// 获取安全的视频渠道列表
export async function getSafeVideoChannels(enabledOnly = false): Promise<SafeVideoChannel[]> {
  const channels = await getVideoChannels(enabledOnly);
  return channels.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    enabled: c.enabled,
  }));
}

// ========================================
// 视频模型操作
// ========================================

function parseVideoFeatures(raw: unknown): VideoModelFeatures {
  const defaults: VideoModelFeatures = {
    textToVideo: true,
    imageToVideo: false,
    videoToVideo: false,
    supportStyles: false,
  };
  if (!raw) return defaults;
  if (typeof raw === 'string') {
    try {
      return { ...defaults, ...JSON.parse(raw) };
    } catch {
      return defaults;
    }
  }
  if (typeof raw === 'object') {
    return { ...defaults, ...(raw as VideoModelFeatures) };
  }
  return defaults;
}

function parseAspectRatios(raw: unknown): Array<{ value: string; label: string }> {
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) return raw;
  return [];
}

function parseDurations(raw: unknown): VideoDuration[] {
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) return raw;
  return [];
}

function parseVideoConfigObject(raw: unknown): VideoConfigObject | undefined {
  if (!raw) return undefined;
  let parsed: unknown = raw;

  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  if (!parsed || typeof parsed !== 'object') return undefined;
  const candidate = parsed as Record<string, unknown>;
  const output: VideoConfigObject = {};

  if (typeof candidate.aspect_ratio === 'string' && candidate.aspect_ratio.trim()) {
    output.aspect_ratio = candidate.aspect_ratio.trim() as VideoConfigObject['aspect_ratio'];
  }
  if (typeof candidate.video_length === 'number' && Number.isFinite(candidate.video_length)) {
    output.video_length = Math.floor(candidate.video_length);
  }
  if (typeof candidate.resolution === 'string' && candidate.resolution.trim()) {
    output.resolution = candidate.resolution.trim().toUpperCase() as VideoConfigObject['resolution'];
  }
  if (typeof candidate.preset === 'string' && candidate.preset.trim()) {
    output.preset = candidate.preset.trim().toLowerCase() as VideoConfigObject['preset'];
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

// 获取所有视频模型
export async function getVideoModels(enabledOnly = false): Promise<VideoModel[]> {
  await initializeDatabase();
  await initializeVideoChannelsTables();
  const db = getAdapter();

  const sql = enabledOnly
    ? 'SELECT * FROM video_models WHERE enabled = 1 ORDER BY sort_order ASC, created_at ASC'
    : 'SELECT * FROM video_models ORDER BY sort_order ASC, created_at ASC';

  const [rows] = await db.execute(sql);

  return (rows as any[]).map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    description: row.description || '',
    apiModel: row.api_model,
    baseUrl: row.base_url || undefined,
    apiKey: row.api_key || undefined,
    features: parseVideoFeatures(row.features),
    aspectRatios: parseAspectRatios(row.aspect_ratios),
    durations: parseDurations(row.durations),
    defaultAspectRatio: row.default_aspect_ratio || 'landscape',
    defaultDuration: row.default_duration || '8s',
    videoConfigObject: parseVideoConfigObject(row.video_config_object),
    highlight: Boolean(row.highlight),
    enabled: Boolean(row.enabled),
    sortOrder: row.sort_order || 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

// 获取单个视频模型
export async function getVideoModel(id: string): Promise<VideoModel | null> {
  await initializeDatabase();
  await initializeVideoChannelsTables();
  const db = getAdapter();

  const [rows] = await db.execute('SELECT * FROM video_models WHERE id = ?', [id]);
  const models = rows as any[];
  if (models.length === 0) return null;

  const row = models[0];
  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    description: row.description || '',
    apiModel: row.api_model,
    baseUrl: row.base_url || undefined,
    apiKey: row.api_key || undefined,
    features: parseVideoFeatures(row.features),
    aspectRatios: parseAspectRatios(row.aspect_ratios),
    durations: parseDurations(row.durations),
    defaultAspectRatio: row.default_aspect_ratio || 'landscape',
    defaultDuration: row.default_duration || '8s',
    videoConfigObject: parseVideoConfigObject(row.video_config_object),
    highlight: Boolean(row.highlight),
    enabled: Boolean(row.enabled),
    sortOrder: row.sort_order || 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// 创建视频模型
export async function createVideoModel(
  model: Omit<VideoModel, 'id' | 'createdAt' | 'updatedAt'>
): Promise<VideoModel> {
  await initializeDatabase();
  await initializeVideoChannelsTables();
  const db = getAdapter();

  const id = generateId();
  const now = Date.now();

  await db.execute(
    `INSERT INTO video_models (
      id, channel_id, name, description, api_model, base_url, api_key,
      features, aspect_ratios, durations,
      default_aspect_ratio, default_duration, video_config_object, highlight,
      enabled, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      model.channelId,
      model.name,
      model.description,
      model.apiModel,
      model.baseUrl || '',
      model.apiKey || '',
      JSON.stringify(model.features),
      JSON.stringify(model.aspectRatios),
      JSON.stringify(model.durations),
      model.defaultAspectRatio,
      model.defaultDuration,
      model.videoConfigObject ? JSON.stringify(model.videoConfigObject) : null,
      model.highlight ? 1 : 0,
      model.enabled ? 1 : 0,
      model.sortOrder,
      now,
      now,
    ]
  );

  return { ...model, id, createdAt: now, updatedAt: now };
}

// 更新视频模型
export async function updateVideoModel(
  id: string,
  updates: Partial<Omit<VideoModel, 'id' | 'createdAt' | 'updatedAt'>>
): Promise<VideoModel | null> {
  await initializeDatabase();
  await initializeVideoChannelsTables();
  const db = getAdapter();

  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];

  if (updates.channelId !== undefined) { fields.push('channel_id = ?'); values.push(updates.channelId); }
  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.apiModel !== undefined) { fields.push('api_model = ?'); values.push(updates.apiModel); }
  if (updates.baseUrl !== undefined) { fields.push('base_url = ?'); values.push(updates.baseUrl); }
  if (updates.apiKey !== undefined) { fields.push('api_key = ?'); values.push(updates.apiKey); }
  if (updates.features !== undefined) { fields.push('features = ?'); values.push(JSON.stringify(updates.features)); }
  if (updates.aspectRatios !== undefined) { fields.push('aspect_ratios = ?'); values.push(JSON.stringify(updates.aspectRatios)); }
  if (updates.durations !== undefined) { fields.push('durations = ?'); values.push(JSON.stringify(updates.durations)); }
  if (updates.defaultAspectRatio !== undefined) { fields.push('default_aspect_ratio = ?'); values.push(updates.defaultAspectRatio); }
  if (updates.defaultDuration !== undefined) { fields.push('default_duration = ?'); values.push(updates.defaultDuration); }
  if (Object.prototype.hasOwnProperty.call(updates, 'videoConfigObject')) {
    const value = (updates as { videoConfigObject?: VideoConfigObject }).videoConfigObject;
    fields.push('video_config_object = ?');
    values.push(value ? JSON.stringify(value) : null);
  }
  if (updates.highlight !== undefined) { fields.push('highlight = ?'); values.push(updates.highlight ? 1 : 0); }
  if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
  if (updates.sortOrder !== undefined) { fields.push('sort_order = ?'); values.push(updates.sortOrder); }

  values.push(id);
  await db.execute(`UPDATE video_models SET ${fields.join(', ')} WHERE id = ?`, values);

  return getVideoModel(id);
}

// 删除视频模型
export async function deleteVideoModel(id: string): Promise<boolean> {
  await initializeDatabase();
  await initializeVideoChannelsTables();
  const db = getAdapter();

  const [result] = await db.execute('DELETE FROM video_models WHERE id = ?', [id]);
  return (result as any).affectedRows > 0;
}

// 获取安全的视频模型列表
export async function getSafeVideoModels(enabledOnly = false): Promise<SafeVideoModel[]> {
  const models = await getVideoModels(enabledOnly);
  const channels = await getVideoChannels();
  return buildSafeVideoModels(models, channels, enabledOnly);
}

// 获取视频模型的完整配置
export async function getVideoModelWithChannel(modelId: string): Promise<{
  model: VideoModel;
  channel: VideoChannel;
  effectiveBaseUrl: string;
  effectiveApiKey: string;
} | null> {
  const model = await getVideoModel(modelId);
  if (!model) return null;

  const channel = await getVideoChannel(model.channelId);
  if (!channel) return null;

  return {
    model,
    channel,
    effectiveBaseUrl: model.baseUrl || channel.baseUrl,
    effectiveApiKey: model.apiKey || channel.apiKey,
  };
}
