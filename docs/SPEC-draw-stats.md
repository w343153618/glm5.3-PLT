# Spec: draw-stats — 开奖数据统计服务

> 模块 id: `draw-stats` ｜ 二期能力地图: docs/CAPABILITY-MAP-PHASE2.md（会话批准记录）
> 需求来源: 用户 2026-10-14「贴心功能」发散讨论，批准项：走势图、冷热号、遗漏值、和值/跨度分布、历史同期查询、近期重号数据底座。**试机号已砍**（探源确认 huiniao/sporttery 均无此字段，按批准的默认决策不加第三数据源）

## Objective

把已同步的开奖数据（`resolution` 表，含 settlementCode/date）加工成客户端可用的统计服务：走势、分位频率与冷热、当前遗漏、和值/跨度分布、指定号码历史命中查询。**纯计算模块，零新增抓取、零新依赖、零 schema 改动。** 所有对外文案只用「走势参考」「历史统计」，禁用「预测/必中/专家推荐」。

本模块只产出后端模块 + API；统计面板的 UI 由下游 pick-assist 消费。

## 用户故事 / 验收标准（具体可测）

**验收标准——已全部满足 ✅ 2026-10-14：**
1. 作为客户，我在选号时能看到最近 N 期（30/50/100 可选）的走势参考：
   - [x] `GET /api/stats/trends?window=N`（N ∈ {30,50,100}，默认 30）返回：
     - `draws`: 按 date 降序的 `{date, code}` 列表（走势原始数据）
     - `positions`: 3 个位置各自的 0-9 出现次数（频率/冷热）
     - `omission`: 3 个位置各自的 0-9 当前遗漏期数（距最近一次出现隔了多少期；从未出现 = 全量期数）
     - `sum`: 和值 0-27 的分布计数；`span`: 跨度 0-9 的分布计数
   - [x] 窗口不足 N 期时按实际期数计算并在响应中带 `total`（实际参与期数）
2. 作为客户，我输入/选出一个号码想知道它的历史情况：
   - [x] `GET /api/stats/code/:code`（code 须 3 位数字，否则 400）返回 `{code, straightHits, groupHits, lastStraightHit, lastGroupHit}`——直选命中次数（完全相同）、组选命中次数（任意排列相同）、最近一次直选/组选开出的日期（无则 null）
3. 近期重号数据底座（供 pick-assist 的轻提示用）：
   - [x] `GET /api/stats/recent?days=7`（默认 7，≤30）返回近 N 天开出的号码集合 `{draws: [{date, code}]}`，pick-assist 前端用它判断所选号是否近期开过
4. 权限：三个已登录角色（client/manager/hq）均可查看统计（公开开奖数据的加工，无敏感性）；未登录 401。

**实施注记：** strategy 模块新增 `listResolutions()`（唯一对既有代码的改动，只读）；draw-stats 纯计算模块不触 schema、不加依赖；`quotaPerUnit` 为分单位 number。测试 14 项（11 纯计算精确断言 + 3 API 权限/校验），全量 284 项绿 + tsc 无错。

## Tech Stack

沿用底座：Fastify + TS + node:sqlite。新增 `src/modules/draw-stats/index.ts` 纯函数模块（输入 ResolutionEvent[]，输出统计对象），app.ts 挂 3 条 GET 路由。零 npm 依赖。

## Commands

```sh
npm test
npx tsc --noEmit
npx vitest run tests/draw-stats.test.ts
```

## Project Structure（新增/改动）

```
src/modules/draw-stats/index.ts   → createDrawStatsModule(strategy)：trends(window) / codeHistory(code) / recent(days)
src/app/app.ts                    → 3 条 GET 路由 + rolePolicies（client/manager/hq）
tests/draw-stats.test.ts          → 纯计算 + API 双层测试（≥12 项）
```

## Code Style

```typescript
// 纯计算，无 IO；resolutions 由 strategy 模块提供（db.list('resolution')）
export function createDrawStatsModule(strategy: StrategyModule) {
  function trends(window: number): Trends {
    const draws = strategy.listResolutions(); // 新增：按 date 降序的已解析开奖
    const slice = draws.slice(0, window);
    const positions = [0, 1, 2].map(pos => tally(slice, pos));
    const omission = [0, 1, 2].map(pos => currentOmission(draws, pos)); // 遗漏从全量算，非窗口内
    return { total: slice.length, draws: slice, positions, omission, sum: sumHistogram(slice), span: spanHistogram(slice) };
  }
}
```

关键口径：**遗漏从全量开奖序列计算**（窗口只影响频率统计的样本量）；和值 = 三位数之和（0-27）；跨度 = 最大位 − 最小位（0-9）。

## Testing Strategy

- 纯计算：构造 5-8 期已知开奖，断言频率/遗漏/和值/跨度/组选计数的精确值（含边界：全同号「豹子」跨度 0、从未出现的数字遗漏 = 全量期数）
- API：window 参数校验（非法值 400）、code 格式校验（非 3 位数字 400）、days 上限、未登录 401、三角色 200
- 既有 270 项保持全绿（零 schema 改动，回归点仅在 app.ts 路由注册）

## Boundaries

- **Always**: 文案禁「预测/必中/专家推荐」；纯计算无副作用；参数全部校验（window∈{30,50,100}、days∈[1,30]、code /^[0-9]{3}$/）
- **Ask first**: 新增数据源或改 resolution schema（本模块均不需要）
- **Never**: 不做任何「推荐号码」逻辑（统计归统计，选号归客户）；不缓存（每次现算，量级 ≤ 数千行毫秒级）

## Success Criteria

1. 三条 API 对真实同步数据返回正确统计（部署后用服务器实际开奖数据 curl 验证）
2. ≥12 项新测试全绿，既有 270 项不回归，tsc 无错
3. pick-assist 规格可以直接引用本模块的三条 API 作为数据契约

## Open Questions

（无——窗口档位 30/50/100 与遗漏口径已定；试机号砍掉已获批）
