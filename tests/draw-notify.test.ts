import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from '../src/shared/database.ts';
import { createNotifyModule, type SettlementBillLike } from '../src/modules/notify/index.ts';
import type { AppDatabase } from '../src/shared/database.ts';
import type { NotifyMessage } from '../src/modules/notify/index.ts';

let workDir: string;
let db: AppDatabase;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'plt-notify-'));
  db = createDatabase(join(workDir, 'app.db'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function billFixture(overrides: Partial<SettlementBillLike> = {}): SettlementBillLike {
  return {
    clientId: 'client-a', managerId: 'manager-x', // 命中单：gross>0
    grossGain: 1040, clientNetGain: 832, managerIncentive: 104,
    ...overrides,
  };
}

describe('notify 纯模块', () => {
  it('aggregates settlement bills into one client and one manager message', () => {
    const notify = createNotifyModule(db);
    notify.createSettlementNotifications({ date: '2026-10-14' }, [
      billFixture(),
      billFixture({ grossGain: 0, clientNetGain: 0, managerIncentive: 0 }),
      billFixture({ grossGain: 173, clientNetGain: 138.4, managerIncentive: 34.6 }),
    ]);
    const client = notify.listFor('client', 'client-a');
    expect(client.items).toHaveLength(1);
    const message = client.items[0]! as NotifyMessage;
    expect(message.type).toBe('settlement');
    expect(message.payload.orders).toBe(3);
    expect(message.payload.hits).toBe(2);
    expect(message.payload.grossGain).toBe(1213);
    expect(message.payload.clientNetGain).toBe(970.4);
    expect(client.unread).toBe(1);
    const manager = notify.listFor('manager', 'manager-x');
    expect(manager.items).toHaveLength(1);
    expect(manager.items[0]!.payload.commission).toBe(138.6);
  });

  it('keeps zero-gain misses without gross/clientNet fields', () => {
    const notify = createNotifyModule(db);
    notify.createSettlementNotifications({ date: '2026-10-14' }, [
      billFixture({ grossGain: 0, clientNetGain: 0, managerIncentive: 0 }),
    ]);
    const client = notify.listFor('client', 'client-a');
    expect(client.items[0]!.payload).toEqual({ orders: 1, hits: 0 });
  });

  it('is idempotent for repeated settlements of the same date', () => {
    const notify = createNotifyModule(db);
    notify.createSettlementNotifications({ date: '2026-10-14' }, [billFixture()]);
    notify.createSettlementNotifications({ date: '2026-10-14' }, [billFixture()]);
    expect(notify.listFor('client', 'client-a').items).toHaveLength(1);
  });

  it('isolates owners and orders by date desc', () => {
    const notify = createNotifyModule(db);
    notify.createSettlementNotifications({ date: '2026-10-13' }, [billFixture()]);
    notify.createSettlementNotifications({ date: '2026-10-14' }, [billFixture({ clientId: 'client-b' })]);
    expect(notify.listFor('client', 'client-a').items.map(item => item.date)).toEqual(['2026-10-13']);
    expect(notify.listFor('client', 'client-b').items.map(item => item.date)).toEqual(['2026-10-14']);
    expect(notify.listFor('client', 'client-a').unread).toBe(1);
  });

  it('markRead clears unread via ids or all', () => {
    const notify = createNotifyModule(db);
    notify.createSettlementNotifications({ date: '2026-10-13' }, [billFixture()]);
    notify.createSettlementNotifications({ date: '2026-10-14' }, [billFixture()]);
    const { items } = notify.listFor('client', 'client-a');
    notify.markRead('client', 'client-a', { ids: [items[0]!.id] });
    expect(notify.listFor('client', 'client-a').unread).toBe(1);
    notify.markRead('client', 'client-a', { all: true });
    expect(notify.listFor('client', 'client-a').unread).toBe(0);
    // 重复标记安全（已读不重复处理）
    notify.markRead('client', 'client-a', { all: true });
    expect(notify.listFor('client', 'client-a').unread).toBe(0);
  });

  it('marks read cannot touch another owner\'s message', () => {
    const notify = createNotifyModule(db);
    notify.createSettlementNotifications({ date: '2026-10-14' }, [billFixture()]);
    notify.createSettlementNotifications({ date: '2026-10-14' }, [billFixture({ clientId: 'client-b' })]);
    // client-b 试图标记全部已读——只能影响自己的消息
    notify.markRead('client', 'client-b', { all: true });
    expect(notify.listFor('client', 'client-a').unread).toBe(1);
    expect(notify.listFor('client', 'client-b').unread).toBe(0);
  });
});

describe('draw-notify API 路由 + 结算钩子', () => {
  async function apiFixture() {
    const { buildApp } = await import('../src/app/app.ts');
    const { authOptions, login } = await import('./helpers/auth.ts');
    const dir = mkdtempSync(join(tmpdir(), 'plt-notify-api-'));
    const app = await buildApp({
      databasePath: join(dir, 'app.db'), today: '2026-10-14', seed: true, autoSync: false, logger: false, ...authOptions,
    });
    return { app, login: (u: 'admin' | 'dianzhang' | 'user') => login(app, u), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('generates messages via the manual resolution route end to end', async () => {
    const { app, login, cleanup } = await apiFixture();
    try {
      const admin = await login('admin');
      const client = await login('user');
      const manager = await login('dianzhang');
      // user 账号绑定的客户不确定（db.list 顺序），先查 actor 拿 clientId，店长给该客户登记一注今日订单，保证确定性
      const actor = client.actor;
      const order = await app.inject({
        method: 'POST', url: '/api/orders', headers: { cookie: manager.cookie },
        payload: { managerId: actor.managerId, clientId: actor.clientId, date: '2026-10-14', selectedCode: '279', quantity: 1, totalAmount: 2, adoptedStrategy: true },
      });
      expect(order.statusCode).toBe(201);
      // 手动录入开奖号触发钩子
      const resolution = await app.inject({
        method: 'POST', url: '/api/resolutions', headers: { cookie: admin.cookie },
        payload: { date: '2026-10-14', settlementCode: '279', quotaPerUnit: 104000 },
      });
      expect(resolution.statusCode).toBe(200);
      // 客户消息
      const inbox = await app.inject({ url: '/api/notifications', headers: { cookie: client.cookie } });
      expect(inbox.statusCode).toBe(200);
      const body = inbox.json();
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.unread).toBeGreaterThanOrEqual(1);
      const settled = body.items.find((item: NotifyMessage) => item.date === '2026-10-14');
      expect(settled.type).toBe('settlement');
      expect(settled.payload.orders).toBeGreaterThanOrEqual(1);
      expect(settled.payload.hits).toBeGreaterThanOrEqual(1); // 该客户登记的 '279' 命中
      // 店长汇总
      const managerInbox = await app.inject({ url: '/api/notifications', headers: { cookie: manager.cookie } });
      const managerBody = managerInbox.json();
      expect(managerBody.items.some((item: NotifyMessage) => item.date === '2026-10-14' && item.type === 'manager-summary')).toBe(true);
      // 标记全部已读
      const read = await app.inject({ method: 'POST', url: '/api/notifications/read', headers: { cookie: client.cookie }, payload: { all: true } });
      expect(read.statusCode).toBe(200);
      const after = await app.inject({ url: '/api/notifications', headers: { cookie: client.cookie } });
      expect(after.json().unread).toBe(0);
    } finally { await app.close(); cleanup(); }
  });

  it('denies anonymous and hq access', async () => {
    const { app, login, cleanup } = await apiFixture();
    try {
      const anonymous = await app.inject({ url: '/api/notifications' });
      expect(anonymous.statusCode).toBe(401);
      const admin = await login('admin');
      const asHq = await app.inject({ url: '/api/notifications', headers: { cookie: admin.cookie } });
      expect(asHq.statusCode).toBe(403);
    } finally { await app.close(); cleanup(); }
  });
});
