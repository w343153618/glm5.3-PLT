/**
 * draw-notify — 应用内消息中心（开奖结算通知）。
 * 消息由结算钩子（app.ts 路由层，recordResolution 之后）生成：
 *   - client：当日跟单结算汇总（注数/命中/奖金/实得）
 *   - manager：名下客户当日汇总（含店长佣金，方便对账）
 * 存储：records KV kind='notify_message'（普通可删数据，非审计 journal）。
 * 幂等：同 date+type+owner 只生成一条（重复结算重试不重复通知）。
 * 只做应用内消息：客户打开 APP 见红点；不做系统级推送（已批准降级）。
 */
import { z } from 'zod';
import type { AppDatabase } from '../../shared/database.ts';
import { NonnegativeMonetaryAmountSchema } from '../../shared/schemas/money.ts';

export const NotifyMessageSchema = z.strictObject({
  id: z.string().min(1), // 幂等键 `${type}:${date}:${ownerId}`，非 UUID（与 lucky_code 惯例一致）
  ownerType: z.enum(['client', 'manager']),
  ownerId: z.string().min(1),
  type: z.enum(['settlement', 'manager-summary']),
  date: z.iso.date(),
  readAt: z.date().optional(),
  createdAt: z.date(),
  payload: z.strictObject({
    orders: z.number().int().min(0),
    hits: z.number().int().min(0),
    grossGain: NonnegativeMonetaryAmountSchema.optional(),
    clientNetGain: NonnegativeMonetaryAmountSchema.optional(),
    commission: NonnegativeMonetaryAmountSchema.optional(),
  }),
});
export type NotifyMessage = z.infer<typeof NotifyMessageSchema>;

/** 结算钩子入参：registry.recordResolution 返回的真实 bill 结构（取所需子集）。 */
export interface SettlementBillLike {
  clientId: string;
  managerId: string;
  grossGain: number;      // > 0 即命中
  clientNetGain: number;  // 客户实得
  managerIncentive: number; // 店长佣金
}

/** 幂等键：date+type+owner 去重。 */
function keyOf(date: string, type: string, ownerId: string): string {
  return `${type}:${date}:${ownerId}`;
}

const MAX_AGE_DAYS = 90;

export function createNotifyModule(db: AppDatabase) {
  /** 结算钩子：为每位客户与其店长生成当日消息。幂等；失败由调用方决定是否记录。 */
  function createSettlementNotifications(resolution: { date: string }, bills: SettlementBillLike[]): void {
    // 按客户聚合
    const byClient = new Map<string, { orders: number; hits: number; gross: number; net: number }>();
    const byManager = new Map<string, { orders: number; hits: number; gross: number; commission: number }>();
    for (const bill of bills) {
      const isHit = bill.grossGain > 0;
      const client = byClient.get(bill.clientId) ?? { orders: 0, hits: 0, gross: 0, net: 0 };
      client.orders += 1;
      if (isHit) client.hits += 1;
      client.gross += bill.grossGain;
      client.net += bill.clientNetGain;
      byClient.set(bill.clientId, client);
      if (bill.managerId) {
        const manager = byManager.get(bill.managerId) ?? { orders: 0, hits: 0, gross: 0, commission: 0 };
        manager.orders += 1;
        if (isHit) manager.hits += 1;
        manager.gross += bill.grossGain;
        manager.commission += bill.managerIncentive;
        byManager.set(bill.managerId, manager);
      }
    }
    const now = new Date();
    for (const [clientId, stats] of byClient) {
      const id = keyOf(resolution.date, 'settlement', clientId);
      if (db.get('notify_message', id) !== undefined) continue; // 幂等
      const payload: NotifyMessage['payload'] = { orders: stats.orders, hits: stats.hits };
      if (stats.gross > 0) {
        payload.grossGain = stats.gross;
        payload.clientNetGain = stats.net;
      }
      db.insert('notify_message', id, NotifyMessageSchema.parse({
        id, ownerType: 'client', ownerId: clientId, type: 'settlement',
        date: resolution.date, createdAt: now, payload,
      }));
    }
    for (const [managerId, stats] of byManager) {
      const id = keyOf(resolution.date, 'manager-summary', managerId);
      if (db.get('notify_message', id) !== undefined) continue;
      const payload: NotifyMessage['payload'] = { orders: stats.orders, hits: stats.hits };
      if (stats.gross > 0) {
        payload.grossGain = stats.gross;
        payload.commission = stats.commission;
      }
      db.insert('notify_message', id, NotifyMessageSchema.parse({
        id, ownerType: 'manager', ownerId: managerId, type: 'manager-summary',
        date: resolution.date, createdAt: now, payload,
      }));
    }
  }

  function listFor(ownerType: 'client' | 'manager', ownerId: string): { items: NotifyMessage[]; unread: number } {
    const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400000);
    const items = db.list('notify_message')
      .map(item => item as Record<string, unknown>)
      .map(item => NotifyMessageSchema.parse({
        ...item,
        // db 惯例：Date 序列化为字符串，读回时转 Date
        createdAt: new Date(item.createdAt as string),
        ...(item.readAt !== undefined ? { readAt: new Date(item.readAt as string) } : {}),
      }))
      .filter(item => item.ownerType === ownerType && item.ownerId === ownerId)
      .filter(item => item.createdAt >= cutoff)
      .sort((left, right) => right.date.localeCompare(left.date) || right.createdAt.getTime() - left.createdAt.getTime());
    return { items, unread: items.filter(item => !item.readAt).length };
  }

  function markRead(ownerType: 'client' | 'manager', ownerId: string, raw: { ids?: string[]; all?: boolean }): void {
    const { items } = listFor(ownerType, ownerId);
    const targets = raw.all === true
      ? items.filter(item => !item.readAt)
      : items.filter(item => (raw.ids ?? []).includes(item.id));
    const now = new Date();
    for (const item of targets) {
      db.set('notify_message', item.id, NotifyMessageSchema.parse({ ...item, readAt: now }));
    }
  }

  return { createSettlementNotifications, listFor, markRead };
}

export type NotifyModule = ReturnType<typeof createNotifyModule>;
