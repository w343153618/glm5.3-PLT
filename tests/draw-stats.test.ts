import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from '../src/shared/database.ts';
import { createStrategyModule } from '../src/modules/strategy/index.ts';
import { createDrawStatsModule } from '../src/modules/draw-stats/index.ts';
import type { AppDatabase } from '../src/shared/database.ts';
import type { ResolutionEvent } from '../src/shared/schemas/domain.ts';

let workDir: string;
let db: AppDatabase;

// 已知开奖序列（date 升序入库，模块内按 date 降序统计）：
// 10-01 "123" 10-02 "456" 10-03 "159" 10-04 "456" 10-05 "000" 10-06 "123"
// quotaPerUnit 为分单位 number（MonetaryAmountSchema = 正整数分）
const DRAWS: ResolutionEvent[] = [
  { date: '2026-10-01', settlementCode: '123', quotaPerUnit: 104000 },
  { date: '2026-10-02', settlementCode: '456', quotaPerUnit: 104000 },
  { date: '2026-10-03', settlementCode: '159', quotaPerUnit: 104000 },
  { date: '2026-10-04', settlementCode: '456', quotaPerUnit: 104000 },
  { date: '2026-10-05', settlementCode: '000', quotaPerUnit: 104000 },
  { date: '2026-10-06', settlementCode: '123', quotaPerUnit: 104000 },
];

function seed(draws: ResolutionEvent[]) {
  for (const event of draws) db.insert('resolution', event.date, event);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'plt-drawstats-'));
  db = createDatabase(join(workDir, 'app.db'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('draw-stats 纯计算', () => {
  it('trends: 降序走势、窗口截取与 total', () => {
    seed(DRAWS);
    const stats = createDrawStatsModule(createStrategyModule(db));
    const result = stats.trends(30);
    expect(result.total).toBe(6);
    expect(result.draws[0]).toEqual({ date: '2026-10-06', code: '123' });
    expect(result.draws).toHaveLength(6);
    // 窗口不足：total 如实报告
    expect(stats.trends(100).total).toBe(6);
  });

  it('trends: 各位 0-9 频率精确值', () => {
    seed(DRAWS);
    const stats = createDrawStatsModule(createStrategyModule(db));
    const { positions } = stats.trends(30);
    // 百位：1,4,1,4,0,1 → 1×3, 4×2, 0×1
    expect(positions[0]!.counts).toEqual([1, 3, 0, 0, 2, 0, 0, 0, 0, 0]);
    // 十位：2,5,5,5,0,2 → 2×2, 5×3, 0×1
    expect(positions[1]!.counts).toEqual([1, 0, 2, 0, 0, 3, 0, 0, 0, 0]);
    // 个位：3,6,9,6,0,3 → 3×2, 6×2, 9×1, 0×1
    expect(positions[2]!.counts).toEqual([1, 0, 0, 2, 0, 0, 2, 0, 0, 1]);
  });

  it('trends: 遗漏从全量序列计算，从未出现 = 全量期数', () => {
    seed(DRAWS);
    const stats = createDrawStatsModule(createStrategyModule(db));
    const { omission } = stats.trends(3); // 窗口 3 期，但遗漏仍按全量 6 期
    // 最新期 10-06 "123"：百位 1 → 遗漏 0；十位 2 → 0；个位 3 → 0
    expect(omission[0]!.periods[1]).toBe(0);
    expect(omission[1]!.periods[2]).toBe(0);
    expect(omission[2]!.periods[3]).toBe(0);
    // 百位 4 最近出现在 10-04（倒数第 3 期，index 2）→ 遗漏 2
    expect(omission[0]!.periods[4]).toBe(2);
    // 百位 7 从未出现 → 遗漏 = 全量期数 6
    expect(omission[0]!.periods[7]).toBe(6);
    // 个位 9 最近出现在 10-03（index 3）→ 遗漏 3
    expect(omission[2]!.periods[9]).toBe(3);
  });

  it('trends: 和值与跨度分布（含豹子跨度 0）', () => {
    seed(DRAWS);
    const stats = createDrawStatsModule(createStrategyModule(db));
    const { sum, span } = stats.trends(30);
    // 和值：123→6, 456→15, 159→15, 456→15, 000→0, 123→6
    expect(sum[0]).toBe(1);
    expect(sum[6]).toBe(2);
    expect(sum[15]).toBe(3);
    // 跨度：123→2, 456→2, 159→8, 456→2, 000→0(豹子), 123→2
    expect(span[0]).toBe(1);
    expect(span[2]).toBe(4);
    expect(span[8]).toBe(1);
  });

  it('trends: 非法窗口回退默认 30', () => {
    seed(DRAWS);
    const stats = createDrawStatsModule(createStrategyModule(db));
    expect(stats.trends('abc').window).toBe(30);
    expect(stats.trends(50).window).toBe(50);
    expect(stats.trends(100).window).toBe(100);
  });

  it('trends: 无开奖数据时 404', () => {
    const stats = createDrawStatsModule(createStrategyModule(db));
    expect(() => stats.trends(30)).toThrowError(/暂无已同步的开奖数据/);
  });

  it('codeHistory: 直选/组选计数与最近命中日期', () => {
    seed(DRAWS);
    const stats = createDrawStatsModule(createStrategyModule(db));
    const straight = stats.codeHistory('456');
    expect(straight).toEqual({ code: '456', straightHits: 2, groupHits: 2, lastStraightHit: '2026-10-04', lastGroupHit: '2026-10-04' });
    // 组选命中：312 与 123 排列相同
    const group = stats.codeHistory('312');
    expect(group.straightHits).toBe(0);
    expect(group.groupHits).toBe(2);
    expect(group.lastGroupHit).toBe('2026-10-06');
    expect(group.lastStraightHit).toBeNull();
    // 豹子 000：直选即组选
    const leopard = stats.codeHistory('000');
    expect(leopard.straightHits).toBe(1);
    expect(leopard.groupHits).toBe(1);
    expect(leopard.lastStraightHit).toBe('2026-10-05');
  });

  it('codeHistory: 非法号码 400', () => {
    const stats = createDrawStatsModule(createStrategyModule(db));
    for (const bad of ['12', '1234', 'abc', '1a3', '', null, 12345]) {
      expect(() => stats.codeHistory(bad)).toThrowError(/号码须为 3 位数字/);
    }
  });

  it('recent: 以最新期为锚回推 N 个日历天', () => {
    seed(DRAWS);
    const stats = createDrawStatsModule(createStrategyModule(db));
    const threeDays = stats.recent(3); // 10-04 ~ 10-06
    expect(threeDays.days).toBe(3);
    expect(threeDays.draws.map(draw => draw.date)).toEqual(['2026-10-06', '2026-10-05', '2026-10-04']);
    const sevenDays = stats.recent(7); // 10-01 ~ 10-06 全部
    expect(sevenDays.draws).toHaveLength(6);
  });

  it('recent: days 上限 30、非法值抛错', () => {
    seed(DRAWS);
    const stats = createDrawStatsModule(createStrategyModule(db));
    expect(() => stats.recent(31)).toThrow();
    expect(() => stats.recent(0)).toThrow();
    expect(() => stats.recent('abc')).toThrow();
  });

  it('recent: 无数据 404', () => {
    const stats = createDrawStatsModule(createStrategyModule(db));
    expect(() => stats.recent(7)).toThrowError(/暂无已同步的开奖数据/);
  });
});

describe('draw-stats API 路由', () => {
  async function apiFixture() {
    const { buildApp } = await import('../src/app/app.ts');
    const { authOptions, login } = await import('./helpers/auth.ts');
    const dir = mkdtempSync(join(tmpdir(), 'plt-drawstats-api-'));
    const app = await buildApp({
      databasePath: join(dir, 'app.db'), today: '2026-10-14', seed: true, autoSync: false, logger: false, ...authOptions,
    });
    return { app, login: (u: 'admin' | 'dianzhang' | 'user') => login(app, u), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('serves trends for all three roles and rejects anonymous', async () => {
    const { app, login, cleanup } = await apiFixture();
    try {
      for (const username of ['user', 'dianzhang', 'admin'] as const) {
        const actor = await login(username);
        const response = await app.inject({ url: '/api/stats/trends?window=30', headers: { cookie: actor.cookie } });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.window).toBe(30);
        expect(Array.isArray(body.draws)).toBe(true);
        expect(body.positions).toHaveLength(3);
        expect(body.omission).toHaveLength(3);
        expect(body.sum).toHaveLength(28);
        expect(body.span).toHaveLength(10);
      }
      const anonymous = await app.inject({ url: '/api/stats/trends' });
      expect(anonymous.statusCode).toBe(401);
    } finally { await app.close(); cleanup(); }
  });

  it('serves code history with format validation', async () => {
    const { app, login, cleanup } = await apiFixture();
    try {
      const client = await login('user');
      const ok = await app.inject({ url: '/api/stats/code/123', headers: { cookie: client.cookie } });
      expect(ok.statusCode).toBe(200);
      const body = ok.json();
      expect(body.code).toBe('123');
      expect(typeof body.straightHits).toBe('number');
      expect(typeof body.groupHits).toBe('number');
      for (const bad of ['/api/stats/code/12', '/api/stats/code/1234', '/api/stats/code/1a3']) {
        const rejected = await app.inject({ url: bad, headers: { cookie: client.cookie } });
        expect(rejected.statusCode).toBe(400);
      }
    } finally { await app.close(); cleanup(); }
  });

  it('serves recent draws with days validation', async () => {
    const { app, login, cleanup } = await apiFixture();
    try {
      const client = await login('user');
      const ok = await app.inject({ url: '/api/stats/recent?days=7', headers: { cookie: client.cookie } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().days).toBe(7);
      const tooMany = await app.inject({ url: '/api/stats/recent?days=31', headers: { cookie: client.cookie } });
      expect(tooMany.statusCode).toBe(400);
    } finally { await app.close(); cleanup(); }
  });
});
