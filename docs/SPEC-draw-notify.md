# Spec: draw-notify — 应用内消息中心

> 模块 id: `draw-notify` ｜ 二期能力地图第 4 模块
> 需求来源: 用户批准的「贴心功能」清单第 8 项：开奖推送。已批准的降级方案：**不做系统级推送**（国内 WebView 无 FCM、无 PWA push），改应用内消息中心——客户打开 APP 即见红点+横幅

## Objective

开奖结算（`recordResolution`，含每晚自动同步）后，为当日有跟单的每位客户自动生成一条结算消息：「今晚您跟单 3 注，中 2 注，奖金 ¥520（实得 ¥416）」或「今晚您跟单 2 注，未中奖」。客户登录后导航区见红点（未读数），点开消息中心查看历史，可标记已读。店长收到名下客户的汇总消息（辅助跟进）；hq 不收消息（无消费场景）。

**消息只做应用内**：客户打开 APP 才看到；配合 pick-assist 的开奖倒计时引导当晚回看，覆盖「开奖时刻」情感峰值。

## 用户故事 / 验收标准（具体可测）

1. 作为客户，开奖结算后我打开 APP 能看到中奖/未中消息：
   - [x] 结算钩子：`recordResolution` 事务提交后（事务外，失败仅记日志不影响结算）为当日有订单的每个 clientId 聚合生成一条 `notify_message`：`{type:'settlement', date, orders:N, hits:M, grossGain, clientNetGain}`；无订单的日期不生成
   - [x] `GET /api/notifications`（client/manager）→ `{ items: [...], unread: N }`，按时间倒序，最多返回 90 天
   - [x] `POST /api/notifications/read`（client/manager）body `{ids:[...]}` 或 `{all:true}` → 标记已读
   - [x] 前端：导航区铃铛图标 + 未读红点数字；点开消息抽屉（drawer）列表：日期、图标（🎉中奖 / 💭未中）、金额（中奖时显示实得）；「全部已读」按钮
2. 作为店长，我收到名下客户当日汇总：
   - [x] 同一钩子为每个 managerId 生成一条：`{type:'manager-summary', date, orders:N, hits:M, grossGain, commission}`（含店长佣金，方便对账）
3. 数据与安全：
   - [x] 消息存储 `notify_message`（普通 records KV，id=UUID，**可删可改**——非审计数据，与 lucky_code 同级）
   - [x] 隔离：client 只见自己的；manager 只见自己的汇总消息；未登录 401
   - [x] 幂等：同一 date 的结算重复触发（如 auto-sync 重试）不重复生成（按 date+type+owner 去重）

## Tech Stack

零新依赖。`src/modules/notify/index.ts` 模块（create/read），结算钩子挂在 app.ts 的 resolutions 路由后（registry.recordResolution 返回 bills，据此聚合——**不改 registry 模块**，在路由层后置处理）。

## Commands

```sh
npm test
npx tsc --noEmit
npx vitest run tests/draw-notify.test.ts
```

## Project Structure（新增/改动）

```
src/modules/notify/index.ts    → createNotification（幂等）/ listForClient / listForManager / markRead
src/app/app.ts                 → 2 条路由 + recordResolution 后钩子（auto-sync 与手动录入两个入口都挂）
src/app/client/app.js          → 铃铛+红点+消息抽屉、loadNotifications 挂登录后、标记已读
src/app/client/index.html      → 导航铃铛、notifications drawer
src/app/client/styles.css      → 红点、消息列表样式
tests/draw-notify.test.ts      → 生成聚合/幂等/隔离/已读（≥10 项）
```

## 数据模型

```typescript
const NotifyMessageSchema = z.strictObject({
  id: z.uuid(),
  ownerType: z.enum(['client', 'manager']),
  ownerId: z.string(),           // clientId 或 managerId
  type: z.enum(['settlement', 'manager-summary']),
  date: z.iso.date(),            // 结算业务日期
  readAt: z.date().optional(),
  createdAt: z.date(),
  payload: z.strictObject({      // 结算数字快照（显示用）
    orders: z.number().int().min(0),
    hits: z.number().int().min(0),
    grossGain: MonetaryAmountSchema.optional(),     // 中奖才有
    clientNetGain: MonetaryAmountSchema.optional(), // 客户消息
    commission: MonetaryAmountSchema.optional(),    // 店长消息
  }),
});
```

## Testing Strategy

- 钩子：结算 → 客户消息与店长消息各一条、数字聚合正确（3 注中 2 的构造用例）、无订单日期不生成
- 幂等：同日期重复结算不重复；auto-sync 与手动录入双入口都触发且去重
- 隔离：client A 看不到 client B 的消息；manager 只见 manager-summary
- 已读：单条/全部标记后 unread 归零
- 既有 307 项保持全绿（recordResolution 本体零改动是关键回归点）

## Boundaries

- **Always**: 钩子在结算事务外执行、失败静默（消息丢失可接受，结算不可受影响）；显示金额用 clientNetGain（实得）
- **Ask first**: 无
- **Never**: 不做系统级推送（无 FCM/PWA 通道，已批准降级）；不做短信/微信模板消息；消息不进审计 journal（可删除的非敏感数据）；hq 无消息入口

## Success Criteria

1. 开奖号录入后，客户重新打开 APP 见红点，点开见「今晚您跟单 N 注，中 M 注…」
2. 店长看到含佣金数字的当日汇总
3. ≥10 项新测试全绿；既有 307 项不回归；tsc 无错
4. 部署后真实结算触发验证

## Open Questions

（无——90 天上限与红点样式为默认值；消息中心与店长汇总的分发在钩子内一次完成）
