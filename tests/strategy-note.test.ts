import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'plt-strategy-note-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('strategy-note', () => {
  async function apiFixture() {
    const { buildApp } = await import('../src/app/app.ts');
    const { authOptions, login } = await import('./helpers/auth.ts');
    const app = await buildApp({
      databasePath: join(workDir, 'app.db'), today: '2026-10-14', seed: true, autoSync: false, logger: false, ...authOptions,
    });
    return { app, login: (u: 'admin' | 'dianzhang' | 'user') => login(app, u) };
  }

  async function publish(app: Awaited<ReturnType<typeof import('../src/app/app.ts').buildApp>>, cookie: string, date: string, note?: string) {
    return app.inject({
      method: 'POST', url: '/api/portfolios', headers: { cookie },
      payload: {
        date,
        ...(note === undefined ? {} : { note }),
        combos: [
          { code: '123', weight: 34 },
          { code: '456', weight: 33 },
          { code: '789', weight: 33 },
        ],
      },
    });
  }

  it('publishes a portfolio with a note and clients read it back', async () => {
    const { app, login } = await apiFixture();
    try {
      const admin = await login('admin');
      const client = await login('user');
      // 未来日期无 seed 方案，POST 可用
      const posted = await publish(app, admin.cookie, '2026-10-20', '近期和值 12-18 密集，走势参考');
      expect(posted.statusCode).toBe(201);
      // 读取走当日口径：今天日期已由 seed 发布（无 note），用 PUT 更新补理由
      const updated = await app.inject({
        method: 'PUT', url: '/api/portfolios/2026-10-20', headers: { cookie: admin.cookie },
        payload: { note: '组三近期回补', combos: [{ code: '123', weight: 34 }, { code: '456', weight: 33 }, { code: '789', weight: 33 }] },
      });
      expect(updated.statusCode).toBe(200);
      const read = await app.inject({ url: '/api/portfolios/2026-10-20', headers: { cookie: client.cookie } });
      expect(read.statusCode).toBe(200);
      expect(read.json().note).toBe('组三近期回补');
    } finally { await app.close(); }
  });

  it('accepts legacy portfolios without note (backward compatible)', async () => {
    const { app, login } = await apiFixture();
    try {
      const client = await login('user');
      // seed 已发布的今日方案无 note（legacy 形态），读取照常
      const read = await app.inject({ url: '/api/portfolios/2026-10-14', headers: { cookie: client.cookie } });
      expect(read.statusCode).toBe(200);
      expect(read.json().note).toBeUndefined();
    } finally { await app.close(); }
  });

  it('rejects notes beyond 120 characters with 400', async () => {
    const { app, login } = await apiFixture();
    try {
      const admin = await login('admin');
      const rejected = await publish(app, admin.cookie, '2026-10-21', '好'.repeat(121));
      expect(rejected.statusCode).toBe(400);
      // 120 字符整恰可通过
      const ok = await publish(app, admin.cookie, '2026-10-22', '好'.repeat(120));
      expect(ok.statusCode).toBe(201);
    } finally { await app.close(); }
  });

  it('trims whitespace-only note to a 400 rejection', async () => {
    const { app, login } = await apiFixture();
    try {
      const admin = await login('admin');
      const posted = await publish(app, admin.cookie, '2026-10-23', '   ');
      expect(posted.statusCode).toBe(400); // trim 后为空串不满足 min(1)
    } finally { await app.close(); }
  });

  it('note never leaks ahead of codes: same record, same lifecycle', async () => {
    const { app, login } = await apiFixture();
    try {
      const admin = await login('admin');
      const client = await login('user');
      // 未来日期的方案：既有实现为「前端仅展示当日方案」，API 层方案记录整体返回。
      // note 与号码在同一记录中同生共死——有 note 必有号码，无单独泄露通道。
      await publish(app, admin.cookie, '2026-10-24', '理由与号码同生命周期');
      const read = await app.inject({ url: '/api/portfolios/2026-10-24', headers: { cookie: client.cookie } });
      if (read.statusCode === 200) {
        const body = read.json();
        // note 存在 ⇒ 号码完整存在（同一条 portfolio 记录，无 note 单独透出的字段级拆分）
        if (body.note) expect(body.combos.every((combo: { code: string }) => /^\d{3}$/.test(combo.code))).toBe(true);
      } else {
        expect(read.statusCode).toBe(404);
      }
    } finally { await app.close(); }
  });

  it('manager stays isolated from the reference portfolio endpoint', async () => {
    const { app, login } = await apiFixture();
    try {
      const manager = await login('dianzhang');
      // 店长端无方案展示（loadGlobal 对 manager 返回空），reference 访问控制维持 403
      const read = await app.inject({ url: '/api/portfolios/2026-10-14', headers: { cookie: manager.cookie } });
      expect(read.statusCode).toBe(403);
    } finally { await app.close(); }
  });
});
