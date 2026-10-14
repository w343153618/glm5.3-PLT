import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from '../src/shared/database.ts';
import { createLuckyModule } from '../src/modules/lucky/index.ts';
import { fetchNextDrawTime } from '../src/modules/lottery-crawler/index.ts';
import type { AppDatabase } from '../src/shared/database.ts';

let workDir: string;
let db: AppDatabase;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'plt-lucky-'));
  db = createDatabase(join(workDir, 'app.db'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('lucky 纯模块', () => {
  const alice = 'client-alice';
  const bob = 'client-bob';

  it('saves, lists sorted by createdAt, and is idempotent per client+code', () => {
    const lucky = createLuckyModule(db);
    const first = lucky.save(alice, '123');
    expect(first.code).toBe('123');
    const again = lucky.save(alice, '123');
    expect(again.id).toBe(first.id); // 幂等：返回既有记录
    lucky.save(alice, '456');
    expect(lucky.list(alice).map(entry => entry.code)).toEqual(['123', '456']);
  });

  it('enforces the 10-code cap per client with 400', () => {
    const lucky = createLuckyModule(db);
    for (let index = 0; index < 10; index += 1) lucky.save(alice, String(index).padStart(3, '0'));
    expect(() => lucky.save(alice, '999')).toThrowError(/最多收藏 10 个幸运号/);
    // 上限按客户隔离：另一客户不受影响
    expect(() => lucky.save(bob, '999')).not.toThrow();
  });

  it('isolates clients: list and remove only see own codes', () => {
    const lucky = createLuckyModule(db);
    lucky.save(alice, '123');
    lucky.save(bob, '456');
    expect(lucky.list(bob).map(entry => entry.code)).toEqual(['456']);
    // bob 无法删除 alice 的号（id 含 clientId，根本查不到 → 404）
    expect(() => lucky.remove(bob, '123')).toThrowError(/不存在/);
    lucky.remove(alice, '123');
    expect(lucky.list(alice)).toEqual([]);
  });

  it('remove nonexistent code throws 404; invalid codes throw 400', () => {
    const lucky = createLuckyModule(db);
    expect(() => lucky.remove(alice, '777')).toThrowError(/不存在/);
    // 数字 123 经 String() 恰为合法号码 → 视为可接受输入（存得进、读得出）
    expect(lucky.save(alice, 123).code).toBe('123');
    for (const bad of ['12', '1234', 'abc', '1a3', '', null, 12, 1234]) {
      expect(() => lucky.save(alice, bad)).toThrowError(/号码须为 3 位数字/);
    }
  });
});

describe('fetchNextDrawTime', () => {
  it('parses huiniao next_open_time when present', async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      code: 1,
      data: { data: { list: [{ next_open_time: '2026-10-14 21:25:00' }] } },
    }), { status: 200 })) as typeof fetch;
    expect(await fetchNextDrawTime(fetcher)).toBe('2026-10-14 21:25:00');
  });

  it('returns null on http failure, malformed payload, or network error', async () => {
    const failing = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    expect(await fetchNextDrawTime(failing)).toBeNull();
    const malformed = (async () => new Response(JSON.stringify({ data: { data: { list: [{ next_open_time: 'garbage' }] } } }), { status: 200 })) as typeof fetch;
    expect(await fetchNextDrawTime(malformed)).toBeNull();
    const crashed = (async () => { throw new Error('network down'); }) as typeof fetch;
    expect(await fetchNextDrawTime(crashed)).toBeNull();
  });
});

describe('lucky & next-draw API 路由', () => {
  async function apiFixture() {
    const { buildApp } = await import('../src/app/app.ts');
    const { authOptions, login } = await import('./helpers/auth.ts');
    const dir = mkdtempSync(join(tmpdir(), 'plt-lucky-api-'));
    const app = await buildApp({
      databasePath: join(dir, 'app.db'), today: '2026-10-14', seed: true, autoSync: false, logger: false, ...authOptions,
    });
    return { app, login: (u: 'admin' | 'dianzhang' | 'user') => login(app, u), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('full CRUD lifecycle as client, with validation and cross-role denial', async () => {
    const { app, login, cleanup } = await apiFixture();
    try {
      const client = await login('user');
      const manager = await login('dianzhang');

      // 保存 → 列表
      const saved = await app.inject({ method: 'POST', url: '/api/lucky-codes', headers: { cookie: client.cookie }, payload: { code: '518' } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().code).toBe('518');
      // 幂等重存
      const repeat = await app.inject({ method: 'POST', url: '/api/lucky-codes', headers: { cookie: client.cookie }, payload: { code: '518' } });
      expect(repeat.json().id).toBe(saved.json().id);
      const listed = await app.inject({ url: '/api/lucky-codes', headers: { cookie: client.cookie } });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().codes).toHaveLength(1);

      // 非法号码 400
      const bad = await app.inject({ method: 'POST', url: '/api/lucky-codes', headers: { cookie: client.cookie }, payload: { code: '1a3' } });
      expect(bad.statusCode).toBe(400);
      // 删除不存在的 404
      const missing = await app.inject({ method: 'DELETE', url: '/api/lucky-codes/777', headers: { cookie: client.cookie } });
      expect(missing.statusCode).toBe(404);
      // 删除成功
      const removed = await app.inject({ method: 'DELETE', url: '/api/lucky-codes/518', headers: { cookie: client.cookie } });
      expect(removed.statusCode).toBe(200);
      const emptied = await app.inject({ url: '/api/lucky-codes', headers: { cookie: client.cookie } });
      expect(emptied.json().codes).toEqual([]);

      // 店长 403（仅客户功能）；未登录 401
      const asManager = await app.inject({ url: '/api/lucky-codes', headers: { cookie: manager.cookie } });
      expect(asManager.statusCode).toBe(403);
      const anonymous = await app.inject({ url: '/api/lucky-codes' });
      expect(anonymous.statusCode).toBe(401);
    } finally { await app.close(); cleanup(); }
  });

  it('next-draw endpoint requires auth and returns a nullable string', async () => {
    const { app, login, cleanup } = await apiFixture();
    try {
      const anonymous = await app.inject({ url: '/api/stats/next-draw' });
      expect(anonymous.statusCode).toBe(401);
      const client = await login('user');
      const response = await app.inject({ url: '/api/stats/next-draw', headers: { cookie: client.cookie } });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body === null || typeof body.nextOpenTime === 'string' || body.nextOpenTime === null).toBe(true);
    } finally { await app.close(); cleanup(); }
  });
});
