import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../../shared/database.ts';
import { DomainError } from '../../shared/errors.ts';
import { ShareEventSchema, ReferralCodeSchema } from '../../shared/schemas/referral.ts';
import { ClientAttributionAuditSchema } from '../../shared/schemas/store.ts';
import type { ShareEvent } from '../../shared/schemas/referral.ts';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** UUID（十六进制 32 字符）→ base62 短码。 */
export function encodeReferralCode(managerId: string): string {
  const hex = managerId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new DomainError('店长标识格式不正确', 400);
  let value = 0n;
  for (const digit of hex) value = value * 16n + BigInt(parseInt(digit, 16));
  let code = '';
  while (value > 0n) {
    code = ALPHABET[Number(value % 62n)] + code;
    value /= 62n;
  }
  return code.padStart(22, '0');
}

/** base62 短码 → UUID。校验失败抛 DomainError 400。 */
export function decodeReferralCode(code: string): string {
  const parsed = ReferralCodeSchema.safeParse(code);
  if (!parsed.success) throw new DomainError('推广码格式不正确', 400);
  let value = 0n;
  for (const char of code) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new DomainError('推广码格式不正确', 400);
    value = value * 62n + BigInt(index);
  }
  let hex = value.toString(16).padStart(32, '0');
  if (hex.length !== 32) throw new DomainError('推广码格式不正确', 400);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
    throw new DomainError('推广码格式不正确', 400);
  }
  return uuid;
}

export interface ReferralStatsFilter {
  managerId?: string;
  date?: string;
}

export interface ReferralStatsRow {
  managerId: string;
  date: string;
  shareCount: number;
  registerCount: number;
}

export function createReferralModule(db: AppDatabase) {
  /** 获取店长推广码（惰性生成，幂等）。 */
  function getOrCreateCode(managerId: string): string {
    const existing = db.get('referral_code', managerId) as { managerId: string; code: string } | undefined;
    if (existing) return existing.code;
    const code = encodeReferralCode(managerId);
    try {
      db.insert('referral_code', managerId, { managerId, code });
    } catch {
      // 并发下另一事务已插入：读回即可
      const raced = db.get('referral_code', managerId) as { managerId: string; code: string } | undefined;
      if (!raced) throw new DomainError('推广码生成失败，请重试', 500);
      return raced.code;
    }
    return code;
  }

  /** 校验推广码并解析出店长 ID（不泄露店长信息）。 */
  function resolveCode(code: string): { managerId: string } {
    return { managerId: decodeReferralCode(code) };
  }

  /** 记录一次分享（追加式流水）。 */
  function recordShare(input: { managerId: string; sharerRole: 'manager' | 'client'; sharerClientId?: string; date: string }): ShareEvent {
    return db.transaction(() => {
      const event = ShareEventSchema.parse({
        id: randomUUID(), managerId: input.managerId,
        sharerRole: input.sharerRole,
        ...(input.sharerClientId ? { sharerClientId: input.sharerClientId } : {}),
        date: input.date, createdAt: new Date(),
      });
      db.insert('share_event', event.id, event);
      return event;
    });
  }

  /** 按店长×日期聚合分享次数与注册数。注册数取自归属审计（note=扫码注册）。 */
  function stats(filter: ReferralStatsFilter = {}): ReferralStatsRow[] {
    const shares = db.list('share_event').map((item) => ShareEventSchema.parse(item))
      .filter((event) => (filter.managerId === undefined || event.managerId === filter.managerId)
        && (filter.date === undefined || event.date === filter.date));
    const registrations = db.list('client_attribution_audit').map((item) => ClientAttributionAuditSchema.parse(item))
      .filter((audit) => audit.note === '扫码注册')
      .filter((audit) => (filter.managerId === undefined || audit.managerId === filter.managerId)
        && (filter.date === undefined || audit.date === filter.date));
    const map = new Map<string, ReferralStatsRow>();
    for (const event of shares) {
      const key = `${event.managerId}:${event.date}`;
      const row = map.get(key) ?? { managerId: event.managerId, date: event.date, shareCount: 0, registerCount: 0 };
      row.shareCount += 1;
      map.set(key, row);
    }
    for (const audit of registrations) {
      const key = `${audit.managerId}:${audit.date}`;
      const row = map.get(key) ?? { managerId: audit.managerId, date: audit.date, shareCount: 0, registerCount: 0 };
      row.registerCount += 1;
      map.set(key, row);
    }
    return [...map.values()].sort((a, b) => b.date.localeCompare(a.date) || a.managerId.localeCompare(b.managerId));
  }

  return { getOrCreateCode, resolveCode, recordShare, stats };
}

export type ReferralModule = ReturnType<typeof createReferralModule>;
