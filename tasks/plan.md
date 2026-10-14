# Implementation Plan: referral-qr 二维码裂变注册与归属系统

> 规格: [SPEC-referral-qr.md](../docs/SPEC-referral-qr.md)（已批准）
> 任务清单: [todo.md](./todo.md)

## Overview

在既有底座上新增裂变注册链路：店长/客户获取推广码 → 新用户扫码打开 `/?ref=<code>` → 自助注册（昵称+密码）→ 自动登录并归属对应店长 → 分享/注册行为进入审计与统计。全部复用现有 auth_account / client / client_attribution_audit 存储与 rolePolicies 权限机制，零新增 npm 依赖。

## Architecture Decisions

1. **推广码 = managerId 的 base62 可逆短码**，不引入映射表——校验即解码，解码即归属店长，杜绝撞库伪造（校验失败 400）。每店长一个码，惰性生成（首次请求时创建，key=managerId，幂等）。
2. **注册复用现有三张表**：`auth_account`（Client 角色）+ `client`（归属）+ `client_attribution_audit`（note「扫码注册」），不建新业务表；仅新增 `share_event` 追加式流水用于分享统计。
3. **share_event 注册为 append-only journal**（journals 机制自动获得禁改禁删触发器）。
4. **二维码纯手写**（`src/app/client/qr.ts`，QR Model 2 byte mode ECC L，约 60 行），canvas 渲染，避免第三方依赖。
5. **注册后自动登录**：register() 在 access.ts 内部完成 scrypt 哈希 + 会话签发，与 login() 共享限流与 cookie 逻辑。
6. **权限**：所有新路由显式登记 rolePolicies；`POST /api/auth/register` 与 `GET /api/referrals/code/:code`（校验码有效性）为公开路由（后者仅返回 ok/失效，不泄露店长信息）。

## Task List

### Phase 1: 数据与模块层（纵向切片 1——注册链路后端）
- [ ] Task 1: referral schema + 模块（推广码编解码、share_event、统计聚合）
- [ ] Task 2: access.register()（scrypt 哈希、唯一性、会话签发）
- [ ] Task 3: API 路由（referrals/me、auth/register、hq/referral-stats、referrals/code/:code 校验）+ rolePolicies

### Checkpoint: 注册链路后端完成
- [ ] 全量测试通过（含新增 ≥12 项）
- [ ] inject 冒烟：注册→登录→归属正确

### Phase 2: 前端（纵向切片 2——用户可见功能）
- [ ] Task 4: 手写 QR 生成器 qr.ts + 单元测试（固定向量验证）
- [ ] Task 5: 前端注册页（未登录 + ref 参数）+ 拓客/邀请页（店长/客户视角二维码）+ 分享计数上报

### Checkpoint: 端到端可用
- [ ] 浏览器手动验证：店长见码→模拟扫码→注册→自动登录→归属正确
- [ ] 客户视角二维码与店长一致

### Phase 3: 收尾
- [ ] Task 6: hq 前端统计面板（referral-stats 表格）+ 文档更新 + 全量回归

### Checkpoint: Complete
- [ ] SPEC 验收标准逐条满足
- [ ] 216+15 项测试全绿，tsc 无错
- [ ] 提交推送

## Risks and Mitigations

| 风险 | 影响 | 缓解 |
|---|---|---|
| base62 短码被猜测/撞库 | 中 | 码长 22 字符（完整 UUID base62），校验失败即 400，公开校验接口只返回布尔 |
| 注册接口被批量刷 | 中 | 复用 login 的 IP 限流（15 分钟 5 次/账号、50 次/IP）并加倍限制注册 |
| 手写 QR 生成器出错 | 高 | 用多组已知向量（如 "HELLO WORLD"、URL）与在线标准比对单元测试；版本自动升级 v1-v10 |
| share_event 刷量 | 低 | 每会话每分钟去重上报；统计仅作参考不涉钱 |
| 既有测试语义回归 | 高 | 每个 Task 完成即跑全量 vitest + tsc，不许跳过 |

## Open Questions

（无——规格中的两个 Open Questions 已按默认答案执行：无验证码；Host 动态生成）
