# SPEC-report-share — 红黑战绩周报分享图

> 模块 id: `report-share` ｜ 二期「贴心功能」最后一个模块
> 来源：二期能力地图第 5 项。用户批准的清单原文：「红黑战绩周报（本周/本月胜率盈亏，Canvas 生成分享图带水印+裂变二维码，分享即获客）」
> 需求：客户视角把「自己的真实战绩」生成一张可保存/转发的图；诚实红黑（不隐藏亏损），分享图带水印+邀请二维码，看到的人扫码注册即裂变获客

## Objective

客户在战绩日历页新增「生成本周战绩卡」入口，点击后前端用 Canvas 绘制一张分享图：
- 时间段二选一：**本周 / 本月**（默认本周）
- 数字：跟单注数、命中注数、命中率、总投入、总奖金、净盈亏（红黑如实——负数绿色背景写「-¥X」，正数红色写「+¥Y」）
- 品牌区：店名 + 「排列3 · 实战战绩」标题
- 防截图水印：分享人用户名平铺斜纹（复用页面水印 SVG 思路，直接绘制到 Canvas）
- 裂变二维码：客户自己的邀请链接（复用 referral 模块的推广码，`encodeQr` + `drawQrToCanvas` 已有）
- 底部一行小字：「历史统计仅供参考 · 扫码注册跟我选号」（合规红线：不用「预测/必中」）

**只做客户端生成**：数据全部来自既有 API（`/api/clients/:id/orders` + `bills` 或 calendar），Canvas 纯前端绘制，零后端改动。

## 用户故事 / 验收标准（具体可测）

1. 作为客户，我能把本周真实战绩生成一张图：
   - [x] 战绩日历页（client 视角）新增「分享战绩」按钮 → 弹窗选择「本周 / 本月」→ 生成 Canvas 分享图
   - [x] 图内数字与账单一致：注数=该时段 orders 数；命中=该时段 bills 中 grossGain>0 数；投入=Σ totalAmount；奖金=Σ grossGain；净盈亏=奖金-投入（**中奖实得口径用 clientNetGain 展示在括号内**，主数字用毛奖金，与结算通知一致可对上）
   - [x] 无订单时段：显示「本期暂无跟单记录」而非空图
2. 裂变与防截图：
   - [x] 分享图右下角绘制客户推广二维码（referral.link），扫码进入注册页
   - [x] 全图平铺半透明斜纹水印（用户名 + 日期），截图转发可溯源
   - [x] 图片底部固定合规文案（见 Objective）
3. 体验：
   - [x] 「保存图片」按钮：`canvas.toBlob` → `a[download]` 下载 PNG（文件名 `战绩卡-YYYYMMDD.png`）
   - [x] 弹窗内预览缩放适配移动端（图宽 750px 逻辑像素，按容器缩放）
   - [x] hq/manager 不显示此入口（战绩是客户个人视角；店长汇总已有 notify manager-summary）

## Tech Stack

零新依赖、零后端改动。复用：
- `src/app/client/qr.ts` — `encodeQr`/`drawQrToCanvas`（推广码）
- Canvas 2D API（水印平铺、圆角卡片、文字排版）
- 数据：client 已加载的 `orders`/`bills`（loadScope 时已拉取，无新请求）

## Commands

```sh
npm test
npx tsc --noEmit
npx vitest run tests/client-ui.test.ts
```

## Project Structure（新增/改动）

```
src/app/client/app.js          → shareReport 状态 + buildShareCanvas（Canvas 绘制）+ 周期计算（本周/本月）
src/app/client/index.html      → 战绩日历页 client 分支加「分享战绩」按钮 + 弹窗（预览 canvas + 保存按钮 + 周期切换）
src/app/client/styles.css      → 弹窗样式
tests/client-ui.test.ts        → 周期切分计算纯函数测试 + 绘制参数快照（≥6 项）
```

## 数据口径（关键）

```javascript
// 周期：本周 = 周一(含)至今；本月 = 1日(含)至今；均以 bootstrap.today 为锚（北京时间）
function periodRange(mode, today) { /* returns {start, end} */ }
// 数字聚合（全从已加载的 client orders/bills 过滤 date ∈ [start,end]）
// orders: 注数 = length，投入 = Σ totalAmount
// bills（按 orderSlipId 关联同时段订单）: 命中数 = grossGain>0 数，奖金 = Σ grossGain，实得 = Σ clientNetGain
// 净盈亏 = 奖金 − 投入（可能为负——如实展示，这是「红黑」的承诺）
```

## Testing Strategy

- 纯函数 `periodRange`：周一锚定跨月、月初、今天恰是周一等边界（≥3 项）
- 聚合数字：构造 3 单 2 中（含 1 亏）用例，验证注数/命中/投入/奖金/净盈亏（≥2 项）
- UI：按钮仅 client 可见；无订单时段文案；分享函数导出存在（≥1 项）
- 既有 318 项保持全绿（零后端改动，回归风险仅在 app.js 导出清单）

## Boundaries

- **Always**: 净盈亏如实显示（红就是红）；水印含用户名；底部合规文案逐字固定
- **Ask first**: 无
- **Never**: 不做店长/hq 版战绩卡（无消费场景）；不引第三方图表/海报库；不把战绩数字做得比真实更「好看」（如隐藏亏损单）；文案禁用「预测/必中/稳赚」

## Success Criteria

1. 客户生成本周战绩卡：数字与其账单对得上，亏损期显示绿色负数
2. 分享图含水印+二维码，保存为 PNG 可发微信群
3. ≥6 项新测试全绿；既有 318 项不回归；tsc 无错
4. 部署后真机生成一张验证

## Open Questions

（无——口径与一期结算一致；周期边界用周一/月初的朴素定义）
