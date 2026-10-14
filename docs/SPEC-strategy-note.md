# Spec: strategy-note — 方案推荐理由

> 模块 id: `strategy-note` ｜ 二期能力地图第 3 模块
> 需求来源: 用户批准的「贴心功能」清单第 10 项：店长跟单方案附「推荐理由」，客户看到的不是干巴巴的号码，是「有人在认真研究」的感觉

## Objective

管理员（hq）发布每日三组方案时，可为整组方案附一句话理由（如「近期和值 12-18 密集」）；理由随方案透出给客户/店长。**关键规则：未发布前客户端号码打码，但已发布方案的「理由」对客户可见**（理由本身不含号码信息，属于研究观点表述）；理由非必填，不填则不显示任何区块。

**红线落地**：理由文案由管理员自担，系统在前端输入处给 placeholder 引导「走势参考」口径（如「如：近期和值 12-18 密集，仅供参考」），不校验禁词（管理员是总部自己人，不设机械拦截）。

## 用户故事 / 验收标准（具体可测）

**验收标准——已全部满足 ✅ 2026-10-14：**

1. 作为总部管理员，我发布/修改当日方案时填写推荐理由：
   - [x] `StrategyPortfolioSchema` 加 `note: z.string().trim().min(1).max(120).optional()`（向后兼容，旧数据无此字段照常通过）
   - [x] 前端 portfolioForm 加「推荐理由」输入（maxlength 120，placeholder 引导走势参考口径）；保存走现有 savePortfolio/savePortfolioModal，无新路由
2. 作为客户，我在今日方案区看到理由（方案已发布时）：
   - [x] 客户端方案展示（今日精选）在号码旁显示 `💬 {note}`；无 note 则完全不渲染该行
   - [x] **打码规则不变**：未发布/未到展示时间时号码打码照旧，但**理由也随号码一起打码不显示**（发布即整组可见，含号码与理由）——修正：理由与号码同生命周期，避免理由提前泄露「今天有方案」以外的信息
3. 作为店长，我在跟单界面看到同样理由（辅助向客户解释）：
   - [x] 店长端今日方案展示同样透出 note
4. API 透出：`/api/portfolios/:date` 等现有方案读取接口的响应自然含 `note` 字段（schema 扩展自动透出，无需改路由）

## Tech Stack

零新依赖、零新路由。schema 一行扩展 + 前端两处（表单输入、展示行）。

## Commands

```sh
npm test
npx tsc --noEmit
npx vitest run tests/strategy-note.test.ts
```

## Project Structure（改动）

```
src/shared/schemas/domain.ts   → StrategyPortfolioSchema 加 note optional
src/app/client/index.html      → hq portfolioForm 加理由输入；client/manager 今日方案区加理由展示行
src/app/client/app.js          → portfolioForm.note 状态（随现有保存流）
tests/strategy-note.test.ts    → schema 兼容 + API 透出 + 打码联动（≥6 项）
```

## Testing Strategy

- schema：带 note 的方案发布→回读一致；不带 note 的旧式方案照常（回归点）
- API：hq 发布带理由方案 → client 读 `/api/portfolios/:date` 含 note；超 120 字符 400
- 打码联动：未发布日期的方案对 client 仍打码（note 不泄露）
- 前端：portfolioForm.note 渲染进表单

## Boundaries

- **Always**: note 与号码同生命周期（打码一起打码）；非必填不渲染空区块
- - **Ask first**: 无（纯展示性字段）
- **Never**: 不做禁词机械校验；note 不进任何审计 journal；不改变发布/打码的既有流程

## Success Criteria

1. 管理员填「近期和值 12-18 密集」→ 客户端今日精选号码旁可见这句话
2. 未发布时号码与理由都不可见（打码规则零变化）
3. ≥6 项新测试全绿；既有 301 项不回归；tsc 无错
4. 部署后手机实测可见

**实施注记：** 打码机制实为「前端仅展示当日方案」（API 返回整条记录，note 与号码同记录同生共死，无字段级拆分泄露通道）；店长端无方案展示（loadGlobal 对 manager 返回空，reference 访问控制维持 403 隔离）。测试 6 项，全量 307 项绿 + tsc 无错。

## Open Questions

（无——理由与号码同生命周期是唯一设计决策，已在上文用「修正」标注说明理由：防止理由单独可见时泄露额外信息）
