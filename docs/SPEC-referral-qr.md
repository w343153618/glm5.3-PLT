# Spec: referral-qr — 二维码裂变注册与归属系统

> 模块 id: `referral-qr` ｜ 能力地图: [CAPABILITY-MAP.md](./CAPABILITY-MAP.md)
> 需求来源: docs/intent/pailie3-erp.md「扫码裂变规则」章节

## Objective

让店长能把自己的专属二维码/分享链接发给街坊，客户扫码后打开注册页，**自助注册（昵称+自设密码）即归属该店长名下**，无需店长激活。老客户登录后也能生成自己的分享二维码，但该二维码**永远指向自己所属的店长**（裂变不改变归属关系）。总部后台可按店长/日期查询分享次数与扫码注册数统计。

**用户故事：**
1. 作为店长，我在 APP「拓客」页生成专属二维码，发给邻居微信；对方扫码装 APP 注册后自动挂我名下。
2. 作为客户，我在「邀请好友」页生成二维码；好友扫码注册后挂到**我的店长**名下（不是我名下）。
3. 作为总部管理员，我在网页后台按店长、按日期查：分享了几次、多少人扫码注册。

**验收标准（具体可测）：**
- [ ] `GET /api/referrals/me` 返回当前登录角色的推广码（店长返回自己的，客户返回其 managerId 的推广码）——客户端永远拿不到非本人所属店长的推广码
- [ ] 未登录访问 `/?ref=xxx` 时注册页可用；登录状态访问则直接进工作台（ref 参数忽略）
- [ ] `POST /api/auth/register`（公开路由）：body 带 `{ refCode, username, password, name? }`；校验 refCode 有效；创建 client 档案（归属 refCode 对应店长）+ auth_account（Client 角色，subjectId=新 client.id）；返回登录会话（自动登录）
- [ ] 用户名唯一性校验，重复返回 409；用户名规则 3-30 位字母数字（与现有 user 账号风格一致）
- [ ] 分享统计：每次生成/展示推广码记一次 `share_event`（追加式审计，含 date、managerId、sharerRole、sharerClientId?）
- [ ] 注册成功自动写一条 `client_attribution_audit`（note 注明「扫码注册」），复用现有归属审计，总部 `GET /api/hq/attribution-audits` 立刻可见
- [ ] `GET /api/hq/referral-stats`（hq 专属）：按 managerId×date 聚合 share 次数与注册数，支持 date/managerId 过滤
- [ ] 权限矩阵：`referrals/me` → client+manager；`auth/register` → 公开；`hq/referral-stats` → hq。所有新路由加入 rolePolicies 显式登记，未登记默认拒绝
- [ ] 注册页在手机端可用（店长/客户账号登录页也有入口链接跳转）

## Tech Stack

沿用底座，零新依赖：
- 后端：Fastify 5 + TypeScript（Node 26 原生 TS）+ node:sqlite
- 前端：Vue 3（CDN 本地托管 esm 版）
- 二维码：**纯前端生成**，不引第三方库——用约 60 行 TypeScript 手写 QR Code Model 2 (byte mode, ECC L) 实现内置于 `src/app/client/qr.ts`，避免供应链风险；canvas 渲染
- 校验：zod 4

## Commands

```sh
npm test                    # vitest run（216 项基线，本模块新增后须全绿）
npx tsc --noEmit            # 类型检查
npm start                   # 启动：http://127.0.0.1:19888
npx vitest run tests/referral.test.ts   # 本模块测试
```

## Project Structure（新增/改动）

```
src/shared/schemas/referral.ts          → ReferralCodeSchema / ShareEventSchema / RegisterInputSchema
src/shared/schemas/index.ts             → re-export
src/modules/referral/index.ts           → createReferralModule：推广码 CRUD、share_event 审计、统计聚合
src/app/access.ts                       → register() 方法（创建账号+会话，复用登录限流）
src/app/app.ts                          → 3 条新路由 + rolePolicies 登记 + 公开路由登记
src/app/client/qr.ts                    → 纯 TS 二维码生成器（无依赖）
src/app/client/index.html               → 未登录页注册入口 + 登录后拓客/邀请页 + 二维码画布
src/app/client/app.js                   → 推广码获取、分享计数、二维码渲染、注册提交
src/app/client/styles.css               → 拓客卡片样式
tests/referral.test.ts                  → 单元+API 测试（目标 ≥15 项）
```

## Code Style（示例）

```typescript
// 推广码：店长 id 的可逆短码（base62 编码 UUID），校验失败直接 400
export const ReferralCodeSchema = z.string().regex(/^[0-9a-zA-Z]{8,22}$/);

// 追加式审计：只 insert，不 set（走 journals 机制）
const ShareEventSchema = z.strictObject({
  id: z.uuid(),
  managerId: z.uuid(),
  sharerRole: z.enum(['manager', 'client']),
  sharerClientId: z.uuid().optional(),
  date: z.iso.date(),
  createdAt: z.date(),
});
```

## 数据模型

- `referral_code`（kind 存储，managerId 为 key）：每店长一个推广码，首次 `referrals/me` 时惰性生成，永不复用
- `share_event`（追加式 journal）：分享行为流水，作为「分享了多少次」的统计源
- 注册复用现有 `client` + `client_attribution_audit` + `auth_account`，不建新表

## Testing Strategy

- tests/referral.test.ts：模块单元测试（码生成/校验、注册归属、裂变指向所属店长、统计聚合、权限拒绝）
- API 层：inject 全流程——扫码注册→登录→下单；店长请求客户视角推广码返回其店长的码；hq 统计过滤
- 既有 216 项测试保持全绿（回归底线）

## Boundaries

- **Always**: 新路由显式登记 rolePolicies；审计只增不改；金额/归属相关逻辑放模块层并测试
- **Ask first**: 引入任何 npm 依赖（本模块计划零新增）；改动既有表结构
- **Never**: 不改既有 216 项测试的语义；不在日志/响应中输出密码明文；推广码不编码敏感信息

## Success Criteria

1. 店长登录 → 拓客页见专属二维码（含 `https://<host>/?ref=<code>` 链接与下载提示）
2. 新设备访问 `/?ref=code` → 注册表单 → 提交后自动登录进客户工作台，余额 0、归属该店长
3. 客户登录 → 邀请页二维码与店长的相同（同一店长）；好友经它注册同样归属该店长
4. hq 后台 referral-stats 能查到「该店长当日分享 N 次、注册 M 人」
5. 全量测试通过（≥231 项）+ tsc 无错

## Open Questions

1. 注册页是否需要图形验证码/手机号？（当前决定：**不要**，保持零摩擦；登录已有 IP 限流兜底）
2. 服务器域名：二维码里的链接当前用请求 Host 动态生成，生产部署后以实际域名/IP 为准（deploy-pack 模块固化）
