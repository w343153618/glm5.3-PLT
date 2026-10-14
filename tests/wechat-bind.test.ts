import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'plt-wechat-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('wechat-bind API', () => {
  async function apiFixture() {
    const { buildApp } = await import('../src/app/app.ts');
    const { authOptions, login } = await import('./helpers/auth.ts');
    const app = await buildApp({
      databasePath: join(workDir, 'app.db'), today: '2026-10-14', seed: true, autoSync: false, logger: false, ...authOptions,
    });
    return { app, login: (u: 'admin' | 'dianzhang' | 'user') => login(app, u) };
  }

  it('client binds, reads back, and unbinds their wechat', async () => {
    const { app, login } = await apiFixture();
    try {
      const client = await login('user');
      // 初始未绑定
      const before = await app.inject({ url: '/api/wechat/me', headers: { cookie: client.cookie } });
      expect(before.statusCode).toBe(200);
      expect(before.json().wechat).toBeNull();
      // 绑定（含首尾空白，应被 trim）
      const bound = await app.inject({ method: 'PUT', url: '/api/wechat/me', headers: { cookie: client.cookie }, payload: { wechat: '  wx_zhang3  ' } });
      expect(bound.statusCode).toBe(200);
      expect(bound.json().wechat).toBe('wx_zhang3');
      // 回读
      const after = await app.inject({ url: '/api/wechat/me', headers: { cookie: client.cookie } });
      expect(after.json().wechat).toBe('wx_zhang3');
      // 解绑（空串）
      const cleared = await app.inject({ method: 'PUT', url: '/api/wechat/me', headers: { cookie: client.cookie }, payload: { wechat: '   ' } });
      expect(cleared.json().wechat).toBeNull();
      const reread = await app.inject({ url: '/api/wechat/me', headers: { cookie: client.cookie } });
      expect(reread.json().wechat).toBeNull();
    } finally { await app.close(); }
  });

  it('manager binds their wechat and appears to their clients', async () => {
    const { app, login } = await apiFixture();
    try {
      const manager = await login('dianzhang');
      const client = await login('user');
      // 客户先查：店长未绑定
      const before = await app.inject({ url: '/api/wechat/manager', headers: { cookie: client.cookie } });
      expect(before.statusCode).toBe(200);
      expect(before.json().wechat).toBeNull();
      expect(typeof before.json().managerName).toBe('string');
      // 店长绑定
      const bound = await app.inject({ method: 'PUT', url: '/api/wechat/me', headers: { cookie: manager.cookie }, payload: { wechat: 'boss_li' } });
      expect(bound.statusCode).toBe(200);
      // 客户再查：可见店长微信
      const after = await app.inject({ url: '/api/wechat/manager', headers: { cookie: client.cookie } });
      expect(after.json().wechat).toBe('boss_li');
      // 店长回读本人
      const mine = await app.inject({ url: '/api/wechat/me', headers: { cookie: manager.cookie } });
      expect(mine.json().wechat).toBe('boss_li');
    } finally { await app.close(); }
  });

  it('manager sees client wechat in the client list', async () => {
    const { app, login } = await apiFixture();
    try {
      const client = await login('user');
      const manager = await login('dianzhang');
      await app.inject({ method: 'PUT', url: '/api/wechat/me', headers: { cookie: client.cookie }, payload: { wechat: 'wx_wang5' } });
      const bootstrap = (await app.inject({ url: '/api/bootstrap', headers: { cookie: manager.cookie } })).json();
      const response = await app.inject({ url: `/api/stores/${bootstrap.managers[0].storeId}/clients`, headers: { cookie: manager.cookie } });
      expect(response.statusCode).toBe(200);
      const rows = response.json();
      expect(Array.isArray(rows)).toBe(true);
      // 每条记录的 wechat 字段 null 安全（optional：未绑定为 undefined 或 null 均可）
      for (const row of rows) expect(row.wechat === null || row.wechat === undefined || typeof row.wechat === 'string').toBe(true);
      expect(rows.some((row: { wechat: string | null }) => row.wechat === 'wx_wang5')).toBe(true);
    } finally { await app.close(); }
  });

  it('rejects invalid payloads with 400', async () => {
    const { app, login } = await apiFixture();
    try {
      const client = await login('user');
      const tooLong = await app.inject({ method: 'PUT', url: '/api/wechat/me', headers: { cookie: client.cookie }, payload: { wechat: 'a'.repeat(41) } });
      expect(tooLong.statusCode).toBe(400);
      const missing = await app.inject({ method: 'PUT', url: '/api/wechat/me', headers: { cookie: client.cookie }, payload: {} });
      // 缺字段按空串处理 = 解绑，不报错
      expect(missing.statusCode).toBe(200);
      expect(missing.json().wechat).toBeNull();
    } finally { await app.close(); }
  });

  it('denies hq binding, anonymous access, and cross-role views', async () => {
    const { app, login } = await apiFixture();
    try {
      const admin = await login('admin');
      // hq 不能绑定也不能查看 me
      const asHq = await app.inject({ method: 'PUT', url: '/api/wechat/me', headers: { cookie: admin.cookie }, payload: { wechat: 'hq_no' } });
      expect(asHq.statusCode).toBe(403);
      const hqMe = await app.inject({ url: '/api/wechat/me', headers: { cookie: admin.cookie } });
      expect(hqMe.statusCode).toBe(403);
      // 店长不能查 /api/wechat/manager（那是客户视角接口）
      const manager = await login('dianzhang');
      const asManager = await app.inject({ url: '/api/wechat/manager', headers: { cookie: manager.cookie } });
      expect(asManager.statusCode).toBe(403);
      // 未登录 401
      const anonymousPut = await app.inject({ method: 'PUT', url: '/api/wechat/me', payload: { wechat: 'x' } });
      expect(anonymousPut.statusCode).toBe(401);
      const anonymousGet = await app.inject({ url: '/api/wechat/manager' });
      expect(anonymousGet.statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it('persists across app rebuilds on the same database', async () => {
    const { buildApp } = await import('../src/app/app.ts');
    const { authOptions, login } = await import('./helpers/auth.ts');
    const path = join(workDir, 'persist.db');
    const first = await buildApp({ databasePath: path, today: '2026-10-14', seed: true, autoSync: false, logger: false, ...authOptions });
    try {
      const client = await login(first, 'user');
      await first.inject({ method: 'PUT', url: '/api/wechat/me', headers: { cookie: client.cookie }, payload: { wechat: 'wx_keep' } });
    } finally { await first.close(); }
    const second = await buildApp({ databasePath: path, today: '2026-10-14', seed: true, autoSync: false, logger: false, ...authOptions });
    try {
      const client = await login(second, 'user');
      const response = await second.inject({ url: '/api/wechat/me', headers: { cookie: client.cookie } });
      expect(response.json().wechat).toBe('wx_keep');
    } finally { await second.close(); }
  });
});
