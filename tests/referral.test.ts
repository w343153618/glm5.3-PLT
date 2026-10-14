import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/shared/database.ts';
import { DomainError } from '../src/shared/errors.ts';
import { createStoreModule } from '../src/modules/store/index.ts';
import { createReferralModule, encodeReferralCode, decodeReferralCode } from '../src/modules/referral/index.ts';
import { createAccess } from '../src/app/access.ts';
import type { FastifyRequest, FastifyReply } from 'fastify';

function fixture() {
  const db = createDatabase(':memory:');
  const stores = createStoreModule(db);
  const referral = createReferralModule(db);
  const store = stores.addStore({ id: randomUUID(), name: '门店 1' });
  const manager = stores.addManager({ id: randomUUID(), storeId: store.id, name: '店长 1' });
  return { db, stores, referral, store, manager };
}

/** access 层测试用：轻量 request/reply 桩。 */
function stubRequestResponse(ip = '203.0.113.10') {
  const headers: Record<string, string | number | undefined> = {};
  const request = { ip, headers: { cookie: undefined }, get header() { return undefined; } } as unknown as FastifyRequest;
  const headerCalls: Array<[string, string]> = [];
  const reply = {
    headerCalls,
    header(name: string, value: string) { headerCalls.push([name, value]); return this as unknown as FastifyReply; },
  } as unknown as FastifyReply & { headerCalls: Array<[string, string]> };
  return { request, reply };
}

describe('referral code codec', () => {
  it('roundtrips random UUIDs through base62 encode/decode', () => {
    for (let index = 0; index < 50; index += 1) {
      const id = randomUUID();
      expect(decodeReferralCode(encodeReferralCode(id))).toBe(id);
    }
  });

  it('produces codes matching the referral code format', () => {
    const code = encodeReferralCode(randomUUID());
    expect(code).toMatch(/^[0-9a-zA-Z]{20,24}$/);
  });

  it.each(['', 'short', 'contains spaces here', '!!!', '0'.repeat(25), 'A'.repeat(19)])(
    'rejects malformed code %j', (code) => {
      expect(() => decodeReferralCode(code)).toThrow(DomainError);
    });

  it('handles a syntactically valid code that decodes out of UUID range by throwing', () => {
    // 22 个 'Z' 是合法 base62，但解码值超出 128 位 UUID 范围 → 必须抛 DomainError，不能返回越界值
    expect(() => decodeReferralCode('Z'.repeat(22))).toThrow(DomainError);
  });

  it('resolves a code to its manager id without extra data', () => {
    const { referral, manager } = fixture();
    const code = referral.getOrCreateCode(manager.id);
    expect(referral.resolveCode(code)).toEqual({ managerId: manager.id });
  });

  it('generates one stable code per manager (idempotent)', () => {
    const { referral, manager } = fixture();
    const first = referral.getOrCreateCode(manager.id);
    const second = referral.getOrCreateCode(manager.id);
    expect(second).toBe(first);
  });

  it('generates different codes for different managers', () => {
    const { referral, store } = fixture();
    const another = createStoreModule(createDatabase(':memory:'));
    expect(another).toBeDefined();
    const code1 = referral.getOrCreateCode(randomUUID());
    const code2 = referral.getOrCreateCode(randomUUID());
    expect(code1).not.toBe(code2);
    void store;
  });
});

describe('share events and stats', () => {
  it('records a share event as append-only journal', () => {
    const { db, referral, manager } = fixture();
    const event = referral.recordShare({ managerId: manager.id, sharerRole: 'manager', date: '2026-10-14' });
    expect(event).toMatchObject({ managerId: manager.id, sharerRole: 'manager', date: '2026-10-14' });
    expect(() => db.set('share_event', event.id, { ...event, date: '2026-10-13' })).toThrow(DomainError);
    expect(() => db.get('share_event', event.id)).toBeDefined();
  });

  it('aggregates share counts and register counts by manager and date', () => {
    const { db, referral, stores, manager } = fixture();
    referral.recordShare({ managerId: manager.id, sharerRole: 'manager', date: '2026-10-14' });
    referral.recordShare({ managerId: manager.id, sharerRole: 'client', sharerClientId: randomUUID(), date: '2026-10-14' });
    // 注册：创建客户档案并写归属审计（note=扫码注册）
    const client = stores.addClient({
      id: randomUUID(), storeId: manager.storeId, managerId: manager.id, name: '扫码客户', date: '2026-10-14',
      note: '扫码注册',
    });
    void client;
    const rows = referral.stats();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ managerId: manager.id, date: '2026-10-14', shareCount: 2, registerCount: 1 });
    // 过滤
    expect(referral.stats({ date: '2026-10-13' })).toHaveLength(0);
    expect(referral.stats({ managerId: manager.id, date: '2026-10-14' })[0]!.shareCount).toBe(2);
    void db;
  });

  it('does not count non-referral client creation in register stats', () => {
    const { referral, stores, manager } = fixture();
    stores.addClient({ id: randomUUID(), storeId: manager.storeId, managerId: manager.id, name: '线下客户', date: '2026-10-14' });
    expect(referral.stats()).toHaveLength(0);
  });
});

describe('access.register()', () => {
  async function accessFixture() {
    const f = fixture();
    const access = await createAccess(f.db, f.stores, {});
    const { request, reply } = stubRequestResponse();
    const register = (input: { refCode: string; username: string; password: string; name?: string }) =>
      access.register(request, reply, { name: input.name ?? input.username, ...input }, f.referral.resolveCode, () => '2026-10-14');
    return { ...f, access, register, reply };
  }

  it('creates a client attributed to the referral manager, an account, and a session', async () => {
    const { referral, manager, stores, register, reply } = await accessFixture();
    const refCode = referral.getOrCreateCode(manager.id);
    const actor = await register({ refCode, username: 'newbie1', password: 'Abcd1234', name: '王先生' });
    expect(actor).toMatchObject({ role: 'client', username: 'newbie1', storeId: manager.storeId, managerId: manager.id });
    const client = stores.listClients(manager.storeId).find((row) => row.name === '王先生');
    expect(client).toMatchObject({ managerId: manager.id, storeId: manager.storeId, reconciliationBalance: 0 });
    expect(reply.headerCalls[0]![0]).toBe('Set-Cookie');
    expect(String(reply.headerCalls[0]![1])).toContain('app_session=');
  });

  it('rejects a duplicate username with 409', async () => {
    const { referral, manager, register } = await accessFixture();
    const refCode = referral.getOrCreateCode(manager.id);
    await register({ refCode, username: 'newbie2', password: 'Abcd1234' });
    await expect(register({ refCode, username: 'newbie2', password: 'Abcd1234' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects an invalid referral code with 400', async () => {
    const { register } = await accessFixture();
    await expect(register({ refCode: 'invalid-code', username: 'newbie3', password: 'Abcd1234' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a valid-format code for a non-existent manager with 400', async () => {
    const { register } = await accessFixture();
    const ghostCode = encodeReferralCode(randomUUID());
    await expect(register({ refCode: ghostCode, username: 'newbie4', password: 'Abcd1234' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a short password', async () => {
    const { referral, manager, register } = await accessFixture();
    const refCode = referral.getOrCreateCode(manager.id);
    await expect(register({ refCode, username: 'newbie5', password: 'short' })).rejects.toThrow();
  });

  it('writes a scan-register attribution audit visible to hq stats', async () => {
    const { referral, manager, register } = await accessFixture();
    const refCode = referral.getOrCreateCode(manager.id);
    await register({ refCode, username: 'newbie6', password: 'Abcd1234' });
    const rows = referral.stats();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ managerId: manager.id, date: '2026-10-14', registerCount: 1, shareCount: 0 });
  });

  it('rate-limits registration attempts per IP', async () => {
    const { referral, manager, register } = await accessFixture();
    const refCode = referral.getOrCreateCode(manager.id);
    for (let index = 0; index < 5; index += 1) {
      await register({ refCode, username: `rate${index}`, password: 'Abcd1234' });
    }
    await expect(register({ refCode, username: 'rate6', password: 'Abcd1234' })).rejects.toMatchObject({ statusCode: 429 });
  });
});

describe('referral API routes', () => {
  async function apiFixture() {
    const { buildApp } = await import('../src/app/app.ts');
    const { authOptions, login } = await import('./helpers/auth.ts');
    const app = await buildApp({ databasePath: ':memory:', today: '2026-10-14', seed: true, autoSync: false, logger: false, ...authOptions });
    return { app, login: (username: 'admin' | 'dianzhang' | 'user') => login(app, username) };
  }

  it('serves the referral code validity check publicly without leaking manager data', async () => {
    const { app, login } = await apiFixture();
    try {
      const manager = await login('dianzhang');
      const mine = await app.inject({ url: '/api/referrals/me', headers: { cookie: manager.cookie } });
      expect(mine.statusCode).toBe(200);
      const { code } = mine.json();
      const valid = await app.inject({ url: `/api/referrals/code/${code}` });
      expect(valid.statusCode).toBe(200);
      expect(valid.json()).toEqual({ valid: true });
      const invalid = await app.inject({ url: '/api/referrals/code/not-a-code' });
      expect(invalid.json()).toEqual({ valid: false });
    } finally { await app.close(); }
  });

  it('completes scan-to-register end to end with attribution and auto login', async () => {
    const { app, login } = await apiFixture();
    try {
      const manager = await login('dianzhang');
      const { code } = (await app.inject({ url: '/api/referrals/me', headers: { cookie: manager.cookie } })).json();
      const registered = await app.inject({
        method: 'POST', url: '/api/auth/register',
        payload: { refCode: code, username: 'neighbor01', password: 'Passw0rd1', name: '张邻居' },
      });
      expect(registered.statusCode).toBe(201);
      const actor = registered.json();
      expect(actor).toMatchObject({ role: 'client', username: 'neighbor01', managerId: manager.actor.managerId });
      // 自动登录：新会话可直接访问受保护接口
      const cookie = String(registered.headers['set-cookie']).split(';')[0]!;
      const me = await app.inject({ url: '/api/auth/me', headers: { cookie } });
      expect(me.statusCode).toBe(200);
      expect(me.json().role).toBe('client');
      // 注册出现在 hq 统计中
      const admin = await login('admin');
      const stats = await app.inject({ url: '/api/hq/referral-stats', headers: { cookie: admin.cookie } });
      expect(stats.statusCode).toBe(200);
      expect(stats.json()).toEqual([
        expect.objectContaining({ managerId: manager.actor.managerId, date: '2026-10-14', registerCount: 1 }),
      ]);
    } finally { await app.close(); }
  });

  it('returns the owning manager code for a client (fission never reattributes)', async () => {
    const { app, login } = await apiFixture();
    try {
      const manager = await login('dianzhang');
      const managerCode = (await app.inject({ url: '/api/referrals/me', headers: { cookie: manager.cookie } })).json().code;
      const client = await login('user');
      const mine = await app.inject({ url: '/api/referrals/me', headers: { cookie: client.cookie } });
      expect(mine.statusCode).toBe(200);
      // 客户视角：二维码与其店长的相同
      expect(mine.json()).toEqual({ managerId: client.actor.managerId, code: managerCode, role: 'client' });
    } finally { await app.close(); }
  });

  it('enforces the role matrix on referral routes', async () => {
    const { app, login } = await apiFixture();
    try {
      const client = await login('user');
      // 未登录
      expect((await app.inject({ url: '/api/referrals/me' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/referrals/share', payload: {} })).statusCode).toBe(401);
      // 客户不能访问 hq 统计
      expect((await app.inject({ url: '/api/hq/referral-stats', headers: { cookie: client.cookie } })).statusCode).toBe(403);
      // 店长可以记录分享
      const manager = await login('dianzhang');
      const shared = await app.inject({ method: 'POST', url: '/api/referrals/share', headers: { cookie: manager.cookie } });
      expect(shared.statusCode).toBe(201);
      expect(shared.json()).toMatchObject({ sharerRole: 'manager', date: '2026-10-14' });
      // admin（hq）不能访问 referrals/me
      const admin = await login('admin');
      expect((await app.inject({ url: '/api/referrals/me', headers: { cookie: admin.cookie } })).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('rejects registration with a used username via HTTP with 409', async () => {
    const { app, login } = await apiFixture();
    try {
      const manager = await login('dianzhang');
      const { code } = (await app.inject({ url: '/api/referrals/me', headers: { cookie: manager.cookie } })).json();
      const payload = { refCode: code, username: 'taken01', password: 'Passw0rd1', name: '甲' };
      expect((await app.inject({ method: 'POST', url: '/api/auth/register', payload })).statusCode).toBe(201);
      expect((await app.inject({ method: 'POST', url: '/api/auth/register', payload })).statusCode).toBe(409);
    } finally { await app.close(); }
  });
});
