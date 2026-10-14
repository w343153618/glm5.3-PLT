# Spec: pick-assist — 选号体验升级

> 模块 id: `pick-assist` ｜ 二期能力地图第 2 模块
> 需求来源: 用户批准的「贴心功能」清单：形态解说卡、智能机选过滤器、近期重号轻提示、幸运号收藏、开奖倒计时、余额不足引导
> 数据契约: 依赖 draw-stats 的三条 API（`/api/stats/trends|code/:code|recent`），已上线

## Objective

升级客户「自主选号」页与跟单体验：选号时实时看到形态与奖金概率解说、带过滤器的智能机选、选到近期开过的号给轻提示、可收藏幸运号一键复投、临近开奖显示倒计时与截止提醒、余额不足时引导联系店长。全部为客户端改动 + 两条小后端接口（幸运号存取），统计页面挂在选号页旁边一屏可达。

**文案红线贯穿所有 UI 文案：只用「走势参考」「历史统计」，禁用「预测/必中/专家推荐」。所有提示均为「告知」不「拦截」。**

## 用户故事 / 验收标准（具体可测）

**验收标准——已全部满足 ✅ 2026-10-14：**

1. **形态解说卡**（纯前端，选号页已有组选判定的扩展）：
   - [x] 客户拨出 3 位数字后实时显示：当前形态（直选/组选三/组选六/豹子不可组选）、各玩法单注奖金与中奖概率（直选 1/1000、组三 3/1000、组六 6/1000）、2 元一注的理论回报
   - [x] 与现有 `customGroupType` 判定逻辑一致（豹子 → 组选无效提示）
2. **智能机选（带过滤器）**：
   - [x] 「机选」按钮弹过滤器面板：☑ 排除近 7 期开过的号（数据来自 `/api/stats/recent?days=7`）☑ 只要组选六形态 ☑ 排除豹子 ☑ 和值区间（默认不限）
   - [x] 生成时按勾选条件随机重试（最多 200 次尝试，失败则提示「放宽条件再试」），一次出 1 注；文案明确「机选筛选，非推荐」
3. **近期重号轻提示**：
   - [x] 客户拨完 3 位数字，若该号（组选视角，排序比较）出现在近 7 天开奖里，显示一行小字：「该号近 7 日已开出 N 次，走势参考」；不弹窗、不阻断下单
4. **幸运号收藏**：
   - [x] `GET/POST /api/lucky-codes`（client）：每位客户最多存 10 个号（3 位数字）；下单页「我的幸运号」区展示，点选即填入；重复保存幂等；删除支持
   - [x] schema：`lucky_code` 表（clientId + code 唯一）；rolePolicies 限定 client
5. **开奖倒计时与截止提醒**：
   - [x] 爬虫扩展：`GET /api/stats/next-draw` 返回 huiniao 的 `next_open_time`（下期开奖时间，UTC+8），双源容错后落库或直传
   - [x] 前端：当天 20:00 后选号页顶部显示「距今晚开奖约 X 小时 X 分」；21:15 后显示「临近开奖，请尽快完成跟单」（纯提示，不锁单——锁单规则已有另外机制）
6. **余额不足引导**：
   - [x] 客户下单确认弹窗里，若余额不足，除现有错误外，附店长推广码/联系引导：「余额不足，请联系店长充值（可在拓客页出示您的专属二维码请店长扫码）」——复用现有 referral 数据，不加新接口
7. **统计面板入口**：
   - [x] 选号页加「走势参考」折叠区：最近 30 期列表 + 三个位置的冷热条（出现次数横条图，纯 CSS）+ 和值/跨度分布简表；窗口 30/50/100 切换；点击走势中的号码可查 `/api/stats/code/:code` 历史弹窗

## Tech Stack

纯前端（Vue CDN，无构建）+ 2 条后端路由（幸运号 CRUD）+ 1 条 next-draw 路由。幸运号用 db KV 表（与现有表机制一致）。零 npm 依赖。

## Commands

```sh
npm test
npx tsc --noEmit
npx vitest run tests/pick-assist.test.ts tests/client-ui.test.ts
```

## Project Structure（新增/改动）

```
src/modules/lucky/index.ts        → 幸运号模块（list/save/remove，clientId 归属校验）
src/app/app.ts                    → 3 条路由 + rolePolicies
src/app/client/app.js             → 形态卡、机选过滤器、重号提示、幸运号、倒计时、余额引导、走势面板
src/app/client/index.html         → 选号页扩展（形态卡/过滤器/幸运号/走势折叠区/倒计时条）
src/app/client/styles.css         → 冷热条、折叠区、形态卡样式
src/modules/lottery-crawler/…     → 透传 next_open_time（fetch 已返回该字段，加 schema 字段与返回）
tests/pick-assist.test.ts         → 幸运号 API + next-draw（≥8 项）
tests/client-ui.test.ts           → 形态卡/机选/提示的前端状态断言（扩展现有 harness）
```

## 数据模型

- `lucky_code` 表：`{id, clientId, code, createdAt}`，clientId+code 唯一（重复保存幂等返回既有记录）
- next-draw 不落库（每请求现取 huiniao，6s 超时，失败返回 `{nextOpenTime: null}` 前端隐藏倒计时）

## Testing Strategy

- 后端：幸运号 CRUD（增删查、上限 10、幂等、跨客户隔离 403）；next-draw 双源 mock 与失败降级
- 前端（SSR harness）：形态卡随 selectedCode 变化、机选过滤器命中/放弃、重号提示文案出现、幸运号列表渲染
- 既有 284 项保持全绿

## Boundaries

- **Always**: 重号/倒计时提示为「告知」不「拦截」；机选文案「筛选非推荐」；幸运号上限 10 且 client 隔离
- **Ask first**: 改 OrderSlipSchema 或下单流程（本模块不动）；锁单逻辑（不做，只提示）
- **Never**: 不做任何「推荐号码」语义文案；不锁单不拦截；不引入图表库（纯 CSS 条）

## Success Criteria

1. 选号页一屏内可完成：看形态解说 → 机选/手选 → 查走势参考 → 下单
2. 幸运号存取删全链路可用且跨客户隔离
3. 倒计时在 20:00 后出现，next-draw 失败时优雅隐藏
4. ≥8 项新测试 + 前端断言扩展全绿；既有 284 项不回归；tsc 无错
5. 部署后手机实测形态卡与走势面板渲染正常

**实施注记：** database.ts 新增受限 delete 方法（records 表专用，审计 journal 仍禁删）；lucky_code 存 records KV 表（id=clientId:code）；形态卡/机选/提示纯前端 computed；测试 8 项后端 + 3 项前端新增，全量 295 项绿 + tsc 无错。

## Open Questions

（无——机选「一次一注」而非五注备选，保持与现有单注交互一致；和值区间过滤器默认不限）
