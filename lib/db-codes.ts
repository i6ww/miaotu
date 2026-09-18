import type { InviteBatchResult, InviteCode, RedemptionBatchSummary, RedemptionCode, StatsOverview, DailyStats, PaymentStatsSummary, PaymentOrderStatus } from '@/types';
import { generateId } from './utils';
import { createDatabaseAdapter, type DatabaseAdapter } from './db-adapter';
import { getPaymentOrdersForAdmin, getSystemConfig } from './db';

// ========================================
// Database adapter
// ========================================

let adapter: DatabaseAdapter | null = null;

function getAdapter(): DatabaseAdapter {
  if (!adapter) {
    adapter = createDatabaseAdapter();
  }
  return adapter;
}

// ========================================
// Table initialization
// ========================================

let tablesInitialized = false;

export async function initializeCodesTables(): Promise<void> {
  if (tablesInitialized) return;
  
  const db = getAdapter();
  const dbType = process.env.DB_TYPE || 'sqlite';

  // Invite codes table
  if (dbType === 'mysql') {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS invite_codes (
        id VARCHAR(36) PRIMARY KEY,
        code VARCHAR(20) UNIQUE NOT NULL,
        creator_id VARCHAR(36) NOT NULL,
        used_by VARCHAR(36),
        used_at BIGINT,
        bonus_points INT DEFAULT 0,
        creator_bonus INT DEFAULT 0,
        expires_at BIGINT,
        created_at BIGINT NOT NULL,
        INDEX idx_code (code),
        INDEX idx_creator (creator_id)
      )
    `);
  } else {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS invite_codes (
        id TEXT PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        creator_id TEXT NOT NULL,
        used_by TEXT,
        used_at INTEGER,
        bonus_points INTEGER DEFAULT 0,
        creator_bonus INTEGER DEFAULT 0,
        expires_at INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    try { await db.execute('CREATE INDEX IF NOT EXISTS idx_invite_code ON invite_codes(code)'); } catch {}
    try { await db.execute('CREATE INDEX IF NOT EXISTS idx_invite_creator ON invite_codes(creator_id)'); } catch {}
  }

  // Redemption codes table
  if (dbType === 'mysql') {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS redemption_codes (
        id VARCHAR(36) PRIMARY KEY,
        code VARCHAR(32) UNIQUE NOT NULL,
        points INT NOT NULL,
        used_by VARCHAR(36),
        used_at BIGINT,
        expires_at BIGINT,
        batch_id VARCHAR(36),
        note VARCHAR(200),
        created_at BIGINT NOT NULL,
        INDEX idx_redeem_code (code),
        INDEX idx_batch (batch_id)
      )
    `);
  } else {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS redemption_codes (
        id TEXT PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        points INTEGER NOT NULL,
        used_by TEXT,
        used_at INTEGER,
        expires_at INTEGER,
        batch_id TEXT,
        note TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    try { await db.execute('CREATE INDEX IF NOT EXISTS idx_redeem_code ON redemption_codes(code)'); } catch {}
    try { await db.execute('CREATE INDEX IF NOT EXISTS idx_redeem_batch ON redemption_codes(batch_id)'); } catch {}
  }

  tablesInitialized = true;
}

// ========================================
// Invite code functions
// ========================================

function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Get user's own invite code (for sharing)
export async function getUserInviteCode(userId: string): Promise<string | null> {
  await initializeCodesTables();
  const db = getAdapter();

  // Find an unused invite code created by this user
  const [rows] = await db.execute(
    'SELECT code FROM invite_codes WHERE creator_id = ? AND used_by IS NULL ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  const arr = rows as any[];
  return arr.length > 0 ? arr[0].code : null;
}

// Create a personal invite code for user (with default bonuses from site settings)
export async function createUserInviteCode(userId: string): Promise<string> {
  await initializeCodesTables();
  const db = getAdapter();

  const config = await getSystemConfig();
  if (!config.inviteSettings.enabled) {
    throw new Error('邀请码功能未启用');
  }
  const bonusPoints = config.inviteSettings.rewardEnabled
    ? config.inviteSettings.inviteeBonusPoints
    : 0;
  const creatorBonus = config.inviteSettings.rewardEnabled
    ? config.inviteSettings.inviterBonusPoints
    : 0;

  // Retry up to 5 times in case of code collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    const id = generateId();
    const now = Date.now();

    try {
      await db.execute(
        `INSERT INTO invite_codes (id, code, creator_id, bonus_points, creator_bonus, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, code, userId, bonusPoints, creatorBonus, now]
      );
      return code;
    } catch (err: any) {
      if (err?.code === 'ER_DUP_ENTRY' || err?.code === 'SQLITE_CONSTRAINT') {
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to generate unique invite code');
}

export async function createInviteCode(
  creatorId: string,
  bonusPoints?: number,
  creatorBonus?: number,
  expiresAt?: number
): Promise<InviteCode> {
  await initializeCodesTables();
  const db = getAdapter();
  const config = await getSystemConfig();
  const resolvedBonusPoints = typeof bonusPoints === 'number'
    ? bonusPoints
    : config.inviteSettings.rewardEnabled
      ? config.inviteSettings.inviteeBonusPoints
      : 0;
  const resolvedCreatorBonus = typeof creatorBonus === 'number'
    ? creatorBonus
    : config.inviteSettings.rewardEnabled
      ? config.inviteSettings.inviterBonusPoints
      : 0;

  // Retry up to 5 times in case of code collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const invite: InviteCode = {
      id: generateId(),
      code: generateInviteCode(),
      creatorId,
      bonusPoints: resolvedBonusPoints,
      creatorBonus: resolvedCreatorBonus,
      expiresAt,
      createdAt: Date.now(),
    };

    try {
      await db.execute(
        `INSERT INTO invite_codes (id, code, creator_id, bonus_points, creator_bonus, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [invite.id, invite.code, invite.creatorId, invite.bonusPoints, invite.creatorBonus, invite.expiresAt || null, invite.createdAt]
      );
      return invite;
    } catch (err: any) {
      // If duplicate key error, retry with new code
      if (err?.code === 'ER_DUP_ENTRY' || err?.code === 'SQLITE_CONSTRAINT') {
        continue;
      }
      throw err;
    }
  }
  
  throw new Error('Failed to generate unique invite code');
}

export async function createInviteBatch(
  creatorId: string,
  count: number,
  bonusPoints?: number,
  creatorBonus?: number,
  expiresAt?: number
): Promise<InviteBatchResult> {
  const safeCount = Math.max(1, Math.min(100, Math.floor(count || 1)));
  const codes: InviteCode[] = [];
  let resolvedInviteeBonus = bonusPoints;
  let resolvedInviterBonus = creatorBonus;

  for (let index = 0; index < safeCount; index += 1) {
    const invite = await createInviteCode(creatorId, bonusPoints, creatorBonus, expiresAt);
    if (resolvedInviteeBonus === undefined) {
      resolvedInviteeBonus = invite.bonusPoints;
    }
    if (resolvedInviterBonus === undefined) {
      resolvedInviterBonus = invite.creatorBonus;
    }
    codes.push(invite);
  }

  return {
    createdAt: Date.now(),
    count: codes.length,
    bonusPoints: resolvedInviteeBonus ?? 0,
    creatorBonus: resolvedInviterBonus ?? 0,
    expiresAt,
    codes,
  };
}

export async function getInviteCodeByCode(code: string): Promise<InviteCode | null> {
  await initializeCodesTables();
  const db = getAdapter();

  const [rows] = await db.execute('SELECT * FROM invite_codes WHERE code = ?', [code.toUpperCase()]);
  const codes = rows as any[];
  if (codes.length === 0) return null;

  const row = codes[0];
  return {
    id: row.id,
    code: row.code,
    creatorId: row.creator_id,
    usedBy: row.used_by || undefined,
    usedAt: row.used_at ? Number(row.used_at) : undefined,
    bonusPoints: row.bonus_points || 0,
    creatorBonus: row.creator_bonus || 0,
    expiresAt: row.expires_at ? Number(row.expires_at) : undefined,
    createdAt: Number(row.created_at),
  };
}

export async function applyInviteCode(code: string, userId: string): Promise<{ success: boolean; error?: string; bonusPoints?: number }> {
  await initializeCodesTables();
  const db = getAdapter();
  const config = await getSystemConfig();
  const inviteSettings = config.inviteSettings;

  if (!inviteSettings.enabled) {
    return { success: false, error: '邀请码功能已关闭' };
  }

  const invite = await getInviteCodeByCode(code);
  if (!invite) return { success: false, error: '邀请码不存在' };
  if (invite.usedBy) return { success: false, error: '邀请码已被使用' };
  if (invite.expiresAt && invite.expiresAt < Date.now()) return { success: false, error: '邀请码已过期' };
  if (invite.creatorId === userId) return { success: false, error: '不能使用自己的邀请码' };

  const now = Date.now();
  
  // Use atomic update with WHERE condition to prevent race condition
  const [result] = await db.execute(
    'UPDATE invite_codes SET used_by = ?, used_at = ? WHERE id = ? AND used_by IS NULL',
    [userId, now, invite.id]
  );
  
  const affected = (result as any).affectedRows ?? (result as any).changes ?? 0;
  if (affected === 0) {
    return { success: false, error: '邀请码已被使用' };
  }

  const inviteeBonus = inviteSettings.rewardEnabled
    ? Math.max(0, inviteSettings.inviteeBonusPoints)
    : 0;
  const inviterBonus = inviteSettings.rewardEnabled
    ? Math.max(0, inviteSettings.inviterBonusPoints)
    : 0;

  // Update user balance (bonus points)
  if (inviteeBonus > 0) {
    await db.execute(
      'UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ?',
      [inviteeBonus, now, userId]
    );
  }

  // Update creator balance (creator bonus)
  if (inviterBonus > 0) {
    await db.execute(
      'UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ?',
      [inviterBonus, now, invite.creatorId]
    );
  }

  return { success: true, bonusPoints: inviteeBonus };
}

export async function syncUnusedInviteCodeBonuses(
  bonusPoints: number,
  creatorBonus: number
): Promise<number> {
  await initializeCodesTables();
  const db = getAdapter();

  const [result] = await db.execute(
    'UPDATE invite_codes SET bonus_points = ?, creator_bonus = ? WHERE used_by IS NULL',
    [Math.max(0, bonusPoints), Math.max(0, creatorBonus)]
  );

  return (result as any).affectedRows ?? (result as any).changes ?? 0;
}

export async function getInviteCodes(options: {
  creatorId?: string;
  limit?: number;
  offset?: number;
  showUsed?: boolean;
} = {}): Promise<InviteCode[]> {
  await initializeCodesTables();
  const db = getAdapter();

  const limit = Math.max(Number(options.limit) || 50, 1);
  const offset = Math.max(Number(options.offset) || 0, 0);

  let sql = `
    SELECT i.*, 
           u.email as creator_email, u.name as creator_name,
           used.email as used_email, used.name as used_name
    FROM invite_codes i
    LEFT JOIN users u ON i.creator_id = u.id
    LEFT JOIN users used ON i.used_by = used.id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (options.creatorId) {
    sql += ' AND creator_id = ?';
    params.push(options.creatorId);
  }
  if (!options.showUsed) {
    sql += ' AND used_by IS NULL';
  }

  sql += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

  const [rows] = await db.execute(sql, params);

  return (rows as any[]).map(row => ({
    id: row.id,
    code: row.code,
    creatorId: row.creator_id,
    usedBy: row.used_by || undefined,
    usedAt: row.used_at ? Number(row.used_at) : undefined,
    bonusPoints: row.bonus_points || 0,
    creatorBonus: row.creator_bonus || 0,
    expiresAt: row.expires_at ? Number(row.expires_at) : undefined,
    createdAt: Number(row.created_at),
    creatorEmail: row.creator_email || undefined,
    creatorName: row.creator_name || undefined,
    usedByEmail: row.used_email || undefined,
    usedByName: row.used_name || undefined,
  }));
}

export async function getInviteCodesCount(options: { creatorId?: string; showUsed?: boolean } = {}): Promise<number> {
  await initializeCodesTables();
  const db = getAdapter();

  let sql = 'SELECT COUNT(1) as count FROM invite_codes WHERE 1=1';
  const params: unknown[] = [];

  if (options.creatorId) {
    sql += ' AND creator_id = ?';
    params.push(options.creatorId);
  }
  if (!options.showUsed) {
    sql += ' AND used_by IS NULL';
  }

  const [rows] = await db.execute(sql, params);
  return Number((rows as any[])[0]?.count || 0);
}

export async function deleteInviteCode(id: string): Promise<boolean> {
  await initializeCodesTables();
  const db = getAdapter();

  const [result] = await db.execute('DELETE FROM invite_codes WHERE id = ?', [id]);
  const affected = (result as any).affectedRows ?? (result as any).changes ?? 0;
  return affected > 0;
}


// ========================================
// Redemption code functions
// ========================================

function generateRedemptionCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) code += '-';
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export async function createRedemptionCodes(
  count: number,
  points: number,
  options: { expiresAt?: number; note?: string } = {}
): Promise<RedemptionCode[]> {
  await initializeCodesTables();
  const db = getAdapter();

  const batchId = generateId();
  const now = Date.now();
  const codes: RedemptionCode[] = [];

  for (let i = 0; i < count; i++) {
    // Retry up to 5 times per code in case of collision
    for (let attempt = 0; attempt < 5; attempt++) {
      const code: RedemptionCode = {
        id: generateId(),
        code: generateRedemptionCode(),
        points,
        batchId,
        note: options.note,
        expiresAt: options.expiresAt,
        createdAt: now,
      };

      try {
        await db.execute(
          `INSERT INTO redemption_codes (id, code, points, batch_id, note, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [code.id, code.code, code.points, code.batchId, code.note || null, code.expiresAt || null, code.createdAt]
        );
        codes.push(code);
        break;
      } catch (err: any) {
        if (err?.code === 'ER_DUP_ENTRY' || err?.code === 'SQLITE_CONSTRAINT') {
          if (attempt === 4) throw new Error('Failed to generate unique redemption code');
          continue;
        }
        throw err;
      }
    }
  }

  return codes;
}

export async function getRedemptionCodeByCode(code: string): Promise<RedemptionCode | null> {
  await initializeCodesTables();
  const db = getAdapter();

  const normalizedCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const formattedCode = normalizedCode.match(/.{1,4}/g)?.join('-') || normalizedCode;

  const [rows] = await db.execute('SELECT * FROM redemption_codes WHERE code = ?', [formattedCode]);
  const codes = rows as any[];
  if (codes.length === 0) return null;

  const row = codes[0];
  return {
    id: row.id,
    code: row.code,
    points: row.points,
    usedBy: row.used_by || undefined,
    usedAt: row.used_at ? Number(row.used_at) : undefined,
    expiresAt: row.expires_at ? Number(row.expires_at) : undefined,
    batchId: row.batch_id || undefined,
    note: row.note || undefined,
    createdAt: Number(row.created_at),
  };
}

export async function redeemCode(code: string, userId: string): Promise<{ success: boolean; error?: string; points?: number }> {
  await initializeCodesTables();
  const db = getAdapter();

  const redemption = await getRedemptionCodeByCode(code);
  if (!redemption) return { success: false, error: '卡密不存在' };
  if (redemption.usedBy) return { success: false, error: '卡密已被使用' };
  if (redemption.expiresAt && redemption.expiresAt < Date.now()) return { success: false, error: '卡密已过期' };

  const now = Date.now();
  
  // Use atomic update with WHERE condition to prevent race condition
  const [result] = await db.execute(
    'UPDATE redemption_codes SET used_by = ?, used_at = ? WHERE id = ? AND used_by IS NULL',
    [userId, now, redemption.id]
  );
  
  const affected = (result as any).affectedRows ?? (result as any).changes ?? 0;
  if (affected === 0) {
    return { success: false, error: '卡密已被使用' };
  }

  await db.execute(
    'UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ?',
    [redemption.points, now, userId]
  );

  return { success: true, points: redemption.points };
}

export async function getRedemptionCodes(options: {
  batchId?: string;
  limit?: number;
  offset?: number;
  showUsed?: boolean;
} = {}): Promise<RedemptionCode[]> {
  await initializeCodesTables();
  const db = getAdapter();

  const limit = Math.max(Number(options.limit) || 50, 1);
  const offset = Math.max(Number(options.offset) || 0, 0);

  let sql = 'SELECT * FROM redemption_codes WHERE 1=1';
  const params: unknown[] = [];

  if (options.batchId) {
    sql += ' AND batch_id = ?';
    params.push(options.batchId);
  }
  if (!options.showUsed) {
    sql += ' AND used_by IS NULL';
  }

  sql += ` ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

  const [rows] = await db.execute(sql, params);

  return (rows as any[]).map(row => ({
    id: row.id,
    code: row.code,
    points: row.points,
    usedBy: row.used_by || undefined,
    usedAt: row.used_at ? Number(row.used_at) : undefined,
    expiresAt: row.expires_at ? Number(row.expires_at) : undefined,
    batchId: row.batch_id || undefined,
    note: row.note || undefined,
    createdAt: Number(row.created_at),
  }));
}

export async function getRedemptionCodesCount(options: { batchId?: string; showUsed?: boolean } = {}): Promise<number> {
  await initializeCodesTables();
  const db = getAdapter();

  let sql = 'SELECT COUNT(1) as count FROM redemption_codes WHERE 1=1';
  const params: unknown[] = [];

  if (options.batchId) {
    sql += ' AND batch_id = ?';
    params.push(options.batchId);
  }
  if (!options.showUsed) {
    sql += ' AND used_by IS NULL';
  }

  const [rows] = await db.execute(sql, params);
  return Number((rows as any[])[0]?.count || 0);
}

export async function getRecentRedemptionBatches(limit = 8): Promise<RedemptionBatchSummary[]> {
  await initializeCodesTables();
  const db = getAdapter();
  const safeLimit = Math.max(1, Math.min(20, Math.floor(limit || 8)));

  const [rows] = await db.execute(
    `SELECT
       batch_id,
       COUNT(1) as count,
       SUM(CASE WHEN used_by IS NOT NULL THEN 1 ELSE 0 END) as used_count,
       MAX(points) as points,
       MAX(note) as note,
       MAX(expires_at) as expires_at,
       MAX(created_at) as created_at
     FROM redemption_codes
     WHERE batch_id IS NOT NULL AND batch_id != ''
     GROUP BY batch_id
     ORDER BY created_at DESC
     LIMIT ${safeLimit}`
  );

  return (rows as any[]).map((row) => {
    const count = Number(row.count || 0);
    const usedCount = Number(row.used_count || 0);
    return {
      batchId: row.batch_id,
      count,
      usedCount,
      unusedCount: Math.max(0, count - usedCount),
      points: Number(row.points || 0),
      note: row.note || undefined,
      expiresAt: row.expires_at ? Number(row.expires_at) : undefined,
      createdAt: Number(row.created_at || 0),
    };
  });
}

export async function deleteRedemptionCode(id: string): Promise<boolean> {
  await initializeCodesTables();
  const db = getAdapter();

  const [result] = await db.execute('DELETE FROM redemption_codes WHERE id = ?', [id]);
  const affected = (result as any).affectedRows ?? (result as any).changes ?? 0;
  return affected > 0;
}

export async function deleteRedemptionCodesByBatch(batchId: string): Promise<number> {
  await initializeCodesTables();
  const db = getAdapter();

  const [result] = await db.execute('DELETE FROM redemption_codes WHERE batch_id = ? AND used_by IS NULL', [batchId]);
  return (result as any).affectedRows ?? (result as any).changes ?? 0;
}

// ========================================
// Statistics functions
// ========================================

export async function getStatsOverview(days = 30, paymentFilters: {
  limit?: number;
  offset?: number;
  search?: string;
  status?: PaymentOrderStatus | 'all';
  startTime?: number;
  endTime?: number;
} = {}): Promise<StatsOverview> {
  await initializeCodesTables();
  const db = getAdapter();
  const dbType = process.env.DB_TYPE || 'sqlite';

  // Use UTC for consistency
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayOfWeek = now.getUTCDay() || 7;
  const weekUTC = todayUTC - (dayOfWeek - 1) * 24 * 60 * 60 * 1000;
  const monthUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const startDate = todayUTC - (days - 1) * 24 * 60 * 60 * 1000;

  // Total counts
  const [userRows] = await db.execute('SELECT COUNT(1) as count FROM users');
  const totalUsers = Number((userRows as any[])[0]?.count || 0);

  const [activeRows] = await db.execute('SELECT COUNT(1) as count FROM users WHERE disabled = 0');
  const activeUsers = Number((activeRows as any[])[0]?.count || 0);

  const [chatModelRows] = await db.execute('SELECT COUNT(1) as count FROM chat_models');
  const totalChatModels = Number((chatModelRows as any[])[0]?.count || 0);

  const [chatEnabledRows] = await db.execute('SELECT COUNT(1) as count FROM chat_models WHERE enabled = 1');
  const enabledChatModels = Number((chatEnabledRows as any[])[0]?.count || 0);

  const [genRows] = await db.execute('SELECT COUNT(1) as count FROM generations');
  const totalGenerations = Number((genRows as any[])[0]?.count || 0);

  const [pointsRows] = await db.execute('SELECT SUM(balance) as total FROM users');
  const totalPoints = Number((pointsRows as any[])[0]?.total || 0);

  // Today counts
  const [todayUserRows] = await db.execute('SELECT COUNT(1) as count FROM users WHERE created_at >= ?', [todayUTC]);
  const todayUsers = Number((todayUserRows as any[])[0]?.count || 0);

  const [todayGenRows] = await db.execute('SELECT COUNT(1) as count FROM generations WHERE created_at >= ?', [todayUTC]);
  const todayGenerations = Number((todayGenRows as any[])[0]?.count || 0);

  // Daily stats - use aggregation query instead of per-day queries
  const dailyStats: DailyStats[] = [];
  
  // Initialize all days with zero values
  const dayMap = new Map<string, DailyStats>();
  for (let i = 0; i < days; i++) {
    const dayStart = startDate + i * 24 * 60 * 60 * 1000;
    const dateStr = new Date(dayStart).toISOString().split('T')[0];
    dayMap.set(dateStr, { date: dateStr, generations: 0, users: 0, points: 0 });
  }

  // Aggregate generations by day - ensure consistent YYYY-MM-DD string format
  const dateExpr = dbType === 'mysql' 
    ? "DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d')"
    : "strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')";
  
  const [genByDay] = await db.execute(
    `SELECT ${dateExpr} as day, COUNT(1) as count, SUM(cost) as points 
     FROM generations 
     WHERE created_at >= ? 
     GROUP BY day`,
    [startDate]
  );
  for (const row of genByDay as any[]) {
    // Handle both string and Date object formats
    let dayKey: string;
    if (row.day instanceof Date) {
      dayKey = row.day.toISOString().split('T')[0];
    } else {
      dayKey = String(row.day);
    }
    const stat = dayMap.get(dayKey);
    if (stat) {
      stat.generations = Number(row.count || 0);
      stat.points = Number(row.points || 0);
    }
  }

  // Aggregate users by day
  const [usersByDay] = await db.execute(
    `SELECT ${dateExpr} as day, COUNT(1) as count 
     FROM users 
     WHERE created_at >= ? 
     GROUP BY day`,
    [startDate]
  );
  for (const row of usersByDay as any[]) {
    // Handle both string and Date object formats
    let dayKey: string;
    if (row.day instanceof Date) {
      dayKey = row.day.toISOString().split('T')[0];
    } else {
      dayKey = String(row.day);
    }
    const stat = dayMap.get(dayKey);
    if (stat) {
      stat.users = Number(row.count || 0);
    }
  }

  // Convert map to sorted array
  for (let i = 0; i < days; i++) {
    const dayStart = startDate + i * 24 * 60 * 60 * 1000;
    const dateStr = new Date(dayStart).toISOString().split('T')[0];
    const stat = dayMap.get(dateStr);
    if (stat) dailyStats.push(stat);
  }

  const [typeRows] = await db.execute(
    `SELECT type, COUNT(1) as count
     FROM generations
     WHERE created_at >= ?
     GROUP BY type`,
    [startDate]
  );

  const generationTypes = (typeRows as any[]).map((row) => ({
    type: row.type,
    count: Number(row.count || 0),
  }));

  const [paymentRows] = await db.execute(
    `SELECT
       SUM(CASE WHEN paid_at >= ? THEN paid_amount_cents ELSE 0 END) as today_amount_cents,
       SUM(CASE WHEN paid_at >= ? THEN paid_amount_cents ELSE 0 END) as week_amount_cents,
       SUM(CASE WHEN paid_at >= ? THEN paid_amount_cents ELSE 0 END) as month_amount_cents,
       SUM(CASE WHEN paid_at >= ? THEN points ELSE 0 END) as today_points,
       SUM(CASE WHEN paid_at >= ? THEN points ELSE 0 END) as week_points,
       SUM(CASE WHEN paid_at >= ? THEN points ELSE 0 END) as month_points
     FROM payment_orders
     WHERE status = 'succeeded'`,
    [todayUTC, weekUTC, monthUTC, todayUTC, weekUTC, monthUTC]
  );
  const paymentRow = (paymentRows as any[])[0] || {};
  const paymentStats: PaymentStatsSummary = {
    todayAmountCents: Number(paymentRow.today_amount_cents || 0),
    weekAmountCents: Number(paymentRow.week_amount_cents || 0),
    monthAmountCents: Number(paymentRow.month_amount_cents || 0),
    todayPoints: Number(paymentRow.today_points || 0),
    weekPoints: Number(paymentRow.week_points || 0),
    monthPoints: Number(paymentRow.month_points || 0),
  };
  const paymentOrdersResult = await getPaymentOrdersForAdmin({
    limit: paymentFilters.limit ?? 20,
    offset: paymentFilters.offset ?? 0,
    search: paymentFilters.search,
    status: paymentFilters.status,
    startTime: paymentFilters.startTime,
    endTime: paymentFilters.endTime,
  });

  return {
    totalUsers,
    activeUsers,
    totalChatModels,
    enabledChatModels,
    totalGenerations,
    totalPoints,
    todayUsers,
    todayGenerations,
    dailyStats,
    generationTypes,
    paymentStats,
    recentPaymentOrders: paymentOrdersResult.orders,
    paymentOrdersTotal: paymentOrdersResult.total,
  };
}

// ========================================
// Admin generation management
// ========================================

export async function getAllGenerations(options: {
  limit?: number;
  offset?: number;
  userId?: string;
  type?: string;
  status?: string;
  search?: string;
  startTime?: number;
  endTime?: number;
  channelType?: string;
} = {}): Promise<{ generations: any[]; total: number }> {
  await initializeCodesTables();
  const db = getAdapter();

  const limit = Math.max(Number(options.limit) || 50, 1);
  const offset = Math.max(Number(options.offset) || 0, 0);

  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (options.userId) {
    whereClauses.push('g.user_id = ?');
    params.push(options.userId);
  }
  if (options.type) {
    whereClauses.push('g.type = ?');
    params.push(options.type);
  }
  if (options.status) {
    whereClauses.push('g.status = ?');
    params.push(options.status);
  }
  if (options.startTime !== undefined) {
    whereClauses.push('g.created_at >= ?');
    params.push(options.startTime);
  }
  if (options.endTime !== undefined) {
    whereClauses.push('g.created_at <= ?');
    params.push(options.endTime);
  }
  if (options.channelType) {
    // Filter by the channel type that actually served the generation.
    // Video: channel id lives in params.videoChannelId — avoid DB-specific JSON
    // functions (MySQL json_extract needs UNQUOTE, SQLite differs), so match by
    // LIKE on the channel UUIDs of that type instead.
    // Image: channel id lives in generation_jobs.channel_id → image_channels.type.
    const [videoChannelRows] = await db.execute(
      'SELECT id FROM video_channels WHERE type = ?',
      [options.channelType]
    );
    const videoChannelIds = (videoChannelRows as any[]).map(r => String(r.id)).filter(Boolean);
    const videoLikeClauses = videoChannelIds.map(() => 'g.params LIKE ?');
    const videoLikeParams = videoChannelIds.map(id => `%${id}%`);
    whereClauses.push(
      `((g.type = 'sora-video' AND (${videoLikeClauses.join(' OR ') || '0'}))
        OR (g.type != 'sora-video' AND EXISTS (
          SELECT 1 FROM generation_jobs jj
          JOIN image_channels ic ON ic.id = jj.channel_id
          WHERE jj.generation_id = g.id AND ic.type = ?
        )))`
    );
    params.push(...videoLikeParams, options.channelType);
  }
  if (options.search) {
    const pattern = `%${options.search}%`;
    whereClauses.push('(u.email LIKE ? OR u.name LIKE ? OR g.prompt LIKE ?)');
    params.push(pattern, pattern, pattern);
  }

  const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
  const countJoin = options.search ? 'LEFT JOIN users u ON g.user_id = u.id' : '';

  // Get total count
  const [countRows] = await db.execute(
    `SELECT COUNT(1) as count FROM generations g ${countJoin} ${whereStr}`,
    params
  );
  const total = Number((countRows as any[])[0]?.count || 0);

  // Get generations with user info
  const [rows] = await db.execute(
    `SELECT g.*, u.email as user_email, u.name as user_name 
     FROM generations g 
     LEFT JOIN users u ON g.user_id = u.id 
     ${whereStr}
     ORDER BY g.created_at DESC 
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const generations = (rows as any[]).map(row => ({
    id: row.id,
    userId: row.user_id,
    userEmail: row.user_email,
    userName: row.user_name,
    type: row.type,
    prompt: row.prompt,
    params: typeof row.params === 'string' ? JSON.parse(row.params || '{}') : row.params,
    resultUrl: row.result_url,
    cost: row.cost,
    status: row.status || 'completed',
    errorMessage: row.error_message,
    balancePrecharged: Boolean(row.balance_precharged),
    balanceRefunded: Boolean(row.balance_refunded),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at || row.created_at),
  })) as Array<Record<string, unknown> & { id: string; type: string; params?: Record<string, unknown> }>;

  // Attach channel names for admin visibility: video routes are recorded in
  // generations.params.videoChannelId, image routes in generation_jobs.channel_id.
  try {
    const videoChannelIds = new Set<string>();
    const imageGenerationIds: string[] = [];
    for (const gen of generations) {
      const videoChannelId = typeof gen.params?.videoChannelId === 'string' ? gen.params.videoChannelId : undefined;
      if (videoChannelId) {
        videoChannelIds.add(videoChannelId);
      } else if (gen.type !== 'sora-video') {
        imageGenerationIds.push(gen.id);
      }
    }

    const channelIdToName = new Map<string, string>();

    if (imageGenerationIds.length > 0) {
      const jobPlaceholders = imageGenerationIds.map(() => '?').join(',');
      const [jobRows] = await db.execute(
        `SELECT generation_id, channel_id FROM generation_jobs WHERE generation_id IN (${jobPlaceholders})`,
        imageGenerationIds
      );
      const imageChannelIds = new Set<string>();
      const generationToChannel = new Map<string, string>();
      for (const job of jobRows as any[]) {
        if (job.channel_id) {
          generationToChannel.set(job.generation_id, job.channel_id);
          imageChannelIds.add(job.channel_id);
        }
      }
      if (imageChannelIds.size > 0) {
        const placeholders = Array.from(imageChannelIds).map(() => '?').join(',');
        const [channelRows] = await db.execute(
          `SELECT id, name FROM image_channels WHERE id IN (${placeholders})`,
          Array.from(imageChannelIds)
        );
        for (const ch of channelRows as any[]) channelIdToName.set(ch.id, ch.name);
      }
      for (const gen of generations) {
        const chId = generationToChannel.get(gen.id);
        if (chId) {
          gen.channelId = chId;
          gen.channelName = channelIdToName.get(chId);
        }
      }
    }

    if (videoChannelIds.size > 0) {
      const placeholders = Array.from(videoChannelIds).map(() => '?').join(',');
      const [channelRows] = await db.execute(
        `SELECT id, name FROM video_channels WHERE id IN (${placeholders})`,
        Array.from(videoChannelIds)
      );
      for (const ch of channelRows as any[]) channelIdToName.set(ch.id, ch.name);
      for (const gen of generations) {
        const chId = typeof gen.params?.videoChannelId === 'string' ? gen.params.videoChannelId : undefined;
        if (chId) {
          gen.channelId = chId;
          gen.channelName = channelIdToName.get(chId);
        }
      }
    }
  } catch (error) {
    // Channel enrichment is best-effort; never fail the record listing because of it.
    console.error('Enrich generation channels error:', error);
  }

  return { generations, total };
}

// Classify a raw generation error message into a coarse failure category,
// so admins can spot upstream outages (e.g. quota exhaustion storms) at a glance.
function classifyFailureMessage(message: string | null | undefined): string {
  const msg = (message || '').toLowerCase();
  if (!msg) return 'unknown';
  if (/insufficient_user_quota|insufficient quota|额度不足|余额不足|积分不足/.test(msg)) return 'quota';
  if (/content_policy|content policy|审核|敏感|safety|blocked|违规|moderation/.test(msg)) return 'content';
  if (/timeout|timed out|超时|etimedout|econnreset|econnrefused|enotfound|network|fetch failed/.test(msg)) return 'network';
  if (/429|rate limit|rate_limit|限流|too many requests/.test(msg)) return 'rate_limit';
  if (/500|502|503|504|internal server|bad gateway|service unavailable|unavailable|上游/.test(msg)) return 'upstream';
  return 'other';
}

export const FAILURE_CATEGORY_LABELS: Record<string, string> = {
  quota: '额度不足',
  content: '内容审核',
  network: '网络/超时',
  rate_limit: '限流',
  upstream: '上游服务错误',
  other: '其他错误',
  unknown: '未知错误',
};

// Aggregate failed generations by coarse error category for the admin dashboard.
// Respects the same filters as the record list (except status, which is forced to failed).
export async function getGenerationFailureSummary(options: {
  userId?: string;
  type?: string;
  search?: string;
  startTime?: number;
  endTime?: number;
  channelType?: string;
} = {}): Promise<{
  total: number;
  categories: Array<{ key: string; label: string; count: number; topMessages: string[] }>;
}> {
  await initializeCodesTables();
  const db = getAdapter();

  const whereClauses: string[] = ["g.status = 'failed'"];
  const params: unknown[] = [];

  if (options.userId) {
    whereClauses.push('g.user_id = ?');
    params.push(options.userId);
  }
  if (options.type) {
    whereClauses.push('g.type = ?');
    params.push(options.type);
  }
  if (options.channelType) {
    const [videoChannelRows] = await db.execute(
      'SELECT id FROM video_channels WHERE type = ?',
      [options.channelType]
    );
    const videoChannelIds = (videoChannelRows as any[]).map(r => String(r.id)).filter(Boolean);
    const videoLikeClauses = videoChannelIds.map(() => 'g.params LIKE ?');
    const videoLikeParams = videoChannelIds.map(id => `%${id}%`);
    whereClauses.push(
      `((g.type = 'sora-video' AND (${videoLikeClauses.join(' OR ') || '0'}))
        OR (g.type != 'sora-video' AND EXISTS (
          SELECT 1 FROM generation_jobs jj
          JOIN image_channels ic ON ic.id = jj.channel_id
          WHERE jj.generation_id = g.id AND ic.type = ?
        )))`
    );
    params.push(...videoLikeParams, options.channelType);
  }
  if (options.startTime !== undefined) {
    whereClauses.push('g.created_at >= ?');
    params.push(options.startTime);
  }
  if (options.endTime !== undefined) {
    whereClauses.push('g.created_at <= ?');
    params.push(options.endTime);
  }
  const needsJoin = Boolean(options.search);
  if (options.search) {
    const pattern = `%${options.search}%`;
    whereClauses.push('(u.email LIKE ? OR u.name LIKE ? OR g.prompt LIKE ?)');
    params.push(pattern, pattern, pattern);
  }

  const whereStr = 'WHERE ' + whereClauses.join(' AND ');

  // Group by exact message in SQL first to keep the row count small, then
  // merge into coarse categories in application code.
  const [rows] = await db.execute(
    `SELECT g.error_message AS error_message, COUNT(1) AS count
     FROM generations g
     ${needsJoin ? 'LEFT JOIN users u ON g.user_id = u.id' : ''}
     ${whereStr}
     GROUP BY g.error_message
     ORDER BY count DESC
     LIMIT 300`,
    params
  );

  const categoryMap = new Map<string, { count: number; messages: Array<{ message: string; count: number }> }>();
  let total = 0;
  for (const row of rows as any[]) {
    const count = Number(row.count || 0);
    const message = row.error_message ? String(row.error_message) : '';
    const key = classifyFailureMessage(message);
    total += count;
    const bucket = categoryMap.get(key) || { count: 0, messages: [] };
    bucket.count += count;
    if (message) bucket.messages.push({ message, count });
    categoryMap.set(key, bucket);
  }

  const categories = Array.from(categoryMap.entries())
    .map(([key, bucket]) => ({
      key,
      label: FAILURE_CATEGORY_LABELS[key] || key,
      count: bucket.count,
      topMessages: bucket.messages
        .slice(0, 2)
        .map(m => (m.message.length > 120 ? m.message.slice(0, 120) + '…' : m.message)),
    }))
    .sort((a, b) => b.count - a.count);

  return { total, categories };
}

// Distinct channel types across image and video channels, for the admin filter dropdown.
export async function getAvailableChannelTypes(): Promise<string[]> {
  await initializeCodesTables();
  const db = getAdapter();
  const [rows] = await db.execute(
    `SELECT DISTINCT type FROM image_channels
     UNION
     SELECT DISTINCT type FROM video_channels`
  );
  return (rows as any[])
    .map(r => (r.type ? String(r.type) : ''))
    .filter(Boolean)
    .sort();
}

export async function adminDeleteGeneration(id: string): Promise<boolean> {
  await initializeCodesTables();
  const db = getAdapter();

  const [result] = await db.execute('DELETE FROM generations WHERE id = ?', [id]);
  const affected = (result as any).affectedRows ?? (result as any).changes ?? 0;
  return affected > 0;
}
