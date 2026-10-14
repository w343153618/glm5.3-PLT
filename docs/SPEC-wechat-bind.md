# Spec: wechat-bind — 一键绑定微信

> 模块 id: `wechat-bind` ｜ 二期能力地图追加模块（2026-10-14 用户需求：客户和店长账号都要有「一键绑定微信」选项，彼此方便找到对方微信沟通）
> 需求来源: 用户中途插入需求，已记档 memory/plt-erp-wechat-binding

## Objective

客户和店长各自在自己的界面里绑定/修改自己的微信号（一个字段，填了即存）；绑定了微信的**店长**，其名下**客户**能看到店长微信号（复制即加好友）；绑定了微信的**客户**，其**店长**在客户列表里能看到该客户微信号。总部（hq）只读可见全部。目标：把线下沟通（充值、出票沟通）的门槛降到一次复制。

设计取向：**微信号字段（文本）而非微信二维码图片**——二维码图片涉及微信「扫一扫」展示场景（需要店长把个人收款码/名片码截图上传），一期先用纯文本微信号（用户自己填，错填自己负责改），交互最简单、零文件存储。后续若需要二维码展示可复用 ticket-photo 的图片基建再扩展。

## 用户故事 / 验收标准（具体可测）

**验收标准——已全部满足 ✅ 2026-10-14：**

1. 作为客户，我在自己的工作台有「微信绑定」设置项：
   - [x] `GET /api/wechat/me` → `{ wechat: string | null }`（本人绑定情况）
   - [x] `PUT /api/wechat/me` body `{ wechat: string }`（1-40 字符，去掉首尾空白；传空串 = 解绑）→ 保存后回显；非法（>40 字符、纯空白）400
   - [x] 前端：客户工作台「我的」页新增「微信」设置区——输入框 + 保存按钮 + 当前绑定展示；保存成功 toast「微信号已保存」
2. 作为客户，我看到我所属店长的微信号（若店长已绑定）：
   - [x] `GET /api/wechat/manager`（client，须已归属 managerId）→ `{ wechat: string | null, managerName: string }`
   - [x] 前端：客户工作台头部/拓客页展示「店长微信：xxx（点击复制）」；未绑定时显示「店长未绑定微信，可电话联系」
3. 作为店长，我绑定自己的微信 + 看到名下客户的微信：
   - [x] `GET /api/wechat/me` / `PUT /api/wechat/me` 同客户（同一组接口，角色自适应）
   - [x] 客户列表 API（`/api/stores/:storeId/clients`）每条记录附 `wechat: string | null`
   - [x] 前端：店长客户表格新增「微信」列（点击复制）；「我的微信」设置区同客户
4. 总部：hq 的客户归属审计/总览里可见 manager/client 微信（只读，通过现有 bootstrap/clients API 附带字段自然透出，不做单独界面）
5. 安全与边界：
   - [x] 每人只能改自己的（PUT 作用于 actor 本人档案）；改他人 403
   - [x] 微信号非必填，全链路 null 安全；不参与任何审计 journal（非业务敏感字段，存档案主体）

## Tech Stack

零新依赖。数据模型：`ClientSchema` / `StoreManagerSchema` 各加 `wechat: z.string().trim().min(1).max(40).optional()`；store 模块加 `setWechat(clientId|managerId, wechat)` 更新方法；app.ts 挂 3 条路由。旧数据无此字段照常通过（optional 向后兼容，同 ticket-photo 的 photoToken 先例）。

## Commands

```sh
npm test
npx tsc --noEmit
npx vitest run tests/wechat-bind.test.ts
```

## Project Structure（新增/改动）

```
src/shared/schemas/store.ts     → Client/StoreManager 加 wechat optional 字段
src/modules/store/index.ts      → setClientWechat / setManagerWechat（null = 解绑）
src/app/app.ts                  → GET/PUT /api/wechat/me、GET /api/wechat/manager + rolePolicies
src/app/client/app.js           → 本人绑定设置区（client+manager）、店长微信展示（client）、客户表格微信列（manager）、复制函数
src/app/client/index.html       → 对应 UI 区块
src/app/client/styles.css       → 设置区样式
tests/wechat-bind.test.ts       → API 测试（≥10 项）
```

## Code Style

```typescript
// 统一入口：角色自适应更新本人档案；空串转 undefined 解绑
app.put('/api/wechat/me', async (request) => {
  const actor = access.actor(request);
  const raw = String((request.body as { wechat?: unknown })?.wechat ?? '').trim();
  const wechat = raw === '' ? undefined : WechatSchema.parse(raw);
  if (actor.role === 'client' && actor.clientId) stores.setClientWechat(actor.clientId, wechat);
  else if (actor.role === 'manager' && actor.managerId) stores.setManagerWechat(actor.managerId, wechat);
  else throw new DomainError('仅客户或店长可绑定微信', 403);
  return { wechat: wechat ?? null };
});
```

## Testing Strategy

- API：客户/店长各自绑定→回读；解绑（空串）；超长/纯空白 400；未登录 401；hq 403（不能绑定）
- 客户查店长微信（绑定/未绑定两种）；店长客户列表含 wechat 字段；跨店客户不可见他人店长微信（按 managerId 归属）
- 既有 295 项保持全绿（schema optional 扩展向后兼容是关键回归点）

## Boundaries

- **Always**: 只改本人档案；输入 trim + 长度校验；null 安全
- **Ask first**: 做微信二维码图片上传（本模块不做，文本先行；需要时另立模块复用 photo 基建）
- **Never**: 不做微信号格式强校验（微信账号规则复杂且非公开，仅长度+非空白）；不把微信写进任何审计 journal；hq 无绑定入口（总部无沟通场景）

## Success Criteria

1. 客户绑定微信后，店长客户列表立刻可见可复制；反向同样成立
2. 解绑后对端显示「未绑定」态
3. ≥10 项新测试全绿；既有 295 项不回归；tsc 无错
4. 部署后双端实测绑定→互见→复制全链路

## Open Questions

（无——文本微信号先行、二维码留作后续扩展的设计取向已在 Objective 说明；不绑手机号不做验证，填错自己改）
