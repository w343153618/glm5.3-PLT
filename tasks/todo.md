# referral-qr 模块任务清单

> 计划: [plan.md](./plan.md) ｜ 规格: [../docs/SPEC-referral-qr.md](../docs/SPEC-referral-qr.md)

## Task 1: referral schema + 模块

**Description:** 新建 `src/shared/schemas/referral.ts`（推广码、share_event、注册输入的 zod schema）和 `src/modules/referral/index.ts`：base62 编解码（managerId UUID ↔ 短码）、推广码惰性生成（key=managerId 幂等）、share_event 追加写入、按 managerId×date 聚合统计。

**Acceptance criteria:**
- [ ] 编码→解码 roundtrip 对随机 UUID 全部还原
- [ ] 非法码（长度/字符/解码失败）抛 DomainError 400
- [ ] share_event 走 journals 追加机制（改/删被触发器拒绝）
- [ ] 统计聚合含 shareCount、registerCount（注册数从 client_attribution_audit 取）

**Verification:**
- [ ] `npx vitest run tests/referral.test.ts` 新增 ≥6 项通过
- [ ] `npx tsc --noEmit` 无错

**Dependencies:** 无
**Files:** `src/shared/schemas/referral.ts`, `src/shared/schemas/index.ts`, `src/shared/database.ts`(注册新 journal), `src/modules/referral/index.ts`, `tests/referral.test.ts`
**Scope:** M

## Task 2: access.register()

**Description:** 在 `src/app/access.ts` 增加 `register(request, reply, { refCode, username, password, name })`：解码推广码→校验店长存在→scrypt 哈希密码→创建 client（归属店长，写归属审计 note「扫码注册」）→创建 auth_account→复用 login 逻辑签发会话。复用并收紧 IP 限流。

**Acceptance criteria:**
- [ ] 注册成功返回 Actor（client 角色）并 Set-Cookie
- [ ] 用户名重复返回 409；非法 refCode 400；密码规则与现有 bootstrap 一致（≥8 位）
- [ ] 注册后 stores.listClients(storeId) 含新客户且 managerId 正确

**Verification:**
- [ ] `npx vitest run tests/referral.test.ts` 注册相关 ≥4 项通过
- [ ] 全量回归保持绿

**Dependencies:** Task 1
**Files:** `src/app/access.ts`, `src/modules/store/index.ts`(可能需暴露创建带审计的入口), `tests/referral.test.ts`
**Scope:** M

## Task 3: API 路由 + rolePolicies

**Description:** `src/app/app.ts` 新增 4 条路由：`GET /api/referrals/me`（client+manager）、`POST /api/auth/register`（公开）、`GET /api/referrals/code/:code`（公开，仅返回 valid 布尔）、`GET /api/hq/referral-stats`（hq）。全部显式登记 rolePolicies / publicRoutes。`referrals/me` 响应带 shareEvent 记录（前端上报用）。

**Acceptance criteria:**
- [ ] 未登录访问受保护新路由返回 401
- [ ] 客户请求 referrals/me 得到其店长的推广码（非自身专属码）
- [ ] hq 可按 date/managerId 过滤统计；非 hq 访问 403
- [ ] rolePolicies 未登记的路由默认拒绝（回归既有守卫测试）

**Verification:**
- [ ] `npx vitest run` 全量通过（新增 API 测试 ≥4 项）
- [ ] `npx tsc --noEmit` 无错

**Dependencies:** Task 1, 2
**Files:** `src/app/app.ts`, `tests/referral.test.ts`（或 tests/api 增补）
**Scope:** M

### Checkpoint: 注册链路后端完成
- [ ] 全量测试通过（≥228 项）
- [ ] inject 冒烟：注册→自动登录→归属正确 → **提交推送一次**

## Task 4: 手写 QR 生成器

**Description:** `src/app/client/qr.ts`：QR Code Model 2、byte mode、ECC L、版本 1-10 自动选择；输出模块矩阵；canvas 绘制函数。多组固定向量单元测试（与标准编码规则手工比对，含版本升级路径）。

**Acceptance criteria:**
- [ ] "HELLO WORLD" 等已知向量生成矩阵与参考实现一致
- [ ] 长文本（>100 字符 URL）自动升版本不抛错
- [ ] finder/timing/alignment 图案与 format info 位置正确（测试断言关键模块）

**Verification:**
- [ ] `npx vitest run tests/qr.test.ts` ≥5 项通过
- [ ] 浏览器渲染冒烟（在 html 载入不报错）

**Dependencies:** 无（可与 Task 1-3 并行）
**Files:** `src/app/client/qr.ts`, `tests/qr.test.ts`
**Scope:** S

## Task 5: 前端注册页 + 拓客/邀请页

**Description:** `index.html`/`app.js`：未登录状态检测 `?ref=` 显示注册表单（用户名/密码/昵称，提交 POST /api/auth/register）；登录后店长见「拓客」页、客户见「邀请好友」页——展示二维码 canvas（链接 `https://<host>/?ref=<code>`）+ 复制链接按钮 + 上报 share_event；styles.css 拓客卡片样式。

**Acceptance criteria:**
- [ ] 带 ref 未登录 → 注册表单，成功后直接进客户工作台
- [ ] 无 ref 访问 → 只显示登录（注册入口隐藏）
- [ ] 店长与客户渲染的二维码内容一致（同一店长码）
- [ ] 注册表单校验错误有中文提示

**Verification:**
- [ ] 浏览器手动全流程（含手机宽度 375px）
- [ ] 全量回归绿

**Dependencies:** Task 3, 4
**Files:** `src/app/client/index.html`, `src/app/client/app.js`, `src/app/client/styles.css`
**Scope:** L（HTML/JS/CSS 三处，但同属一个页面切片）

### Checkpoint: 端到端可用
- [ ] 手动流程：店长见码→注册→自动登录→归属正确 → **提交推送一次**

## Task 6: hq 统计面板 + 文档 + 全量回归

**Description:** hq 工作台新增「裂变统计」区块（referral-stats 表格：店长×日期×分享次数×注册数）；更新 docs/AUTHENTICATION.md 注册机制、SPEC 验收清单勾选；跑全量测试 + tsc；提交推送。

**Acceptance criteria:**
- [ ] hq 界面可见按日统计表
- [ ] 文档反映注册链路
- [ ] 全部验收标准满足，测试全绿

**Verification:**
- [ ] `npx vitest run` + `npx tsc --noEmit` 全绿
- [ ] 手动核对 SPEC Success Criteria 1-5

**Dependencies:** Task 5
**Files:** `src/app/client/index.html`, `src/app/client/app.js`, `docs/AUTHENTICATION.md`, `docs/SPEC-referral-qr.md`
**Scope:** M

### Checkpoint: Complete
- [ ] SPEC 验收标准逐条满足
- [ ] 提交推送，模块收尾
