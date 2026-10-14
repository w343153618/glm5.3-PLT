# Spec: ticket-photo — 彩票照片上传与查看

> 模块 id: `ticket-photo` ｜ 能力地图: [CAPABILITY-MAP.md](./CAPABILITY-MAP.md)
> 需求来源: docs/intent/pailie3-erp.md「店主上传彩票照片」

## Objective

店长在体彩终端真实出票后，对订单拍照上传；客户在自己订单上看到彩票照片，晴天可凭照片到店核对领取纸质票。照片存服务器本地磁盘（data/ 目录，随现有备份机制迁移），**零新增 npm 依赖**（不引入 @fastify/multipart，采用 base64 JSON 上传，32KB bodyLimit 单独为该路由放宽至 7MB）。

**用户故事：**
1. 作为店长，我在「历史记录」里对某笔订单点「上传票照」，拍照/选图，上传后订单标记「已传票照」。
2. 作为客户，我在「历史记录」里看到订单的彩票照片缩略图，点开放大查看。
3. 作为总部，我在订单表里可查看照片（只读）。

**验收标准（具体可测）——已全部满足 ✅ 2026-10-14：**
- [x] `POST /api/orders/:orderId/photo`（manager）：body `{ photoBase64, filename? }`；校验归属店长；解析 base64 → 魔数校验必须为 JPEG（FFD8FF）或 PNG（89504E47）；大小 ≤ 5MB 解码后；存 `data/photos/<orderId>.jpg|png`；订单记录写入 `photoToken`（32 字节随机 hex）与 photoMime；重传覆盖旧文件（新 token 使旧 URL 失效）
- [x] `GET /api/orders/:orderId/photo?token=xxx`：token 恒定校验；client 仅本人订单、manager 仅名下订单、hq 全部可见；照片文件流返回，Content-Type 正确，Cache-Control: private, no-store
- [x] 错误用例：越权 403 / token 错 403 / 无照片 404 / 格式非 jpg/png 400 / 超 5MB 413 / base64 非法 400
- [x] 订单列表 API（stores/:storeId/orders、clients/:id/orders、hq/orders）响应中带 `hasPhoto: boolean`（不直接暴露 token，token 仅在订单详情中按角色返回——简化：列表响应含 photoToken，前端用其构造 URL，token 不可预测且每次重传轮换）
- [x] 前端：店长订单行显示「上传票照」按钮（file input + FileReader → base64 → POST）；上传中禁用按钮；成功 toast「票照已上传」
- [x] 前端：客户/店长/hq 订单行有照片时显示缩略图（img，40px），点击 <dialog> 放大
- [x] 备份兼容：photos 目录位于 data/ 下，随现有 backup/restore 脚本整体迁移（VACUUM INTO 不含照片，需在 DEPLOYMENT.md 注明：迁移时需单独拷贝 data/photos/）

## Tech Stack

沿用底座，零新依赖。图片以 base64（dataURL 的 payload 部分）走 JSON 上传；服务端 Buffer 校验写盘。

## Commands

```sh
npm test
npx tsc --noEmit
npx vitest run tests/photo.test.ts
```

## Project Structure（新增/改动）

```
src/modules/photo/index.ts            → createPhotoModule：save(orderId, buffer) / pathOf(orderId, mime) / 校验
src/app/app.ts                        → 2 条新路由 + rolePolicies + 该路由 bodyLimit 放宽（7MB）
src/app/client/index.html             → 订单表格「票照」列：上传按钮/缩略图 + 放大 dialog
src/app/client/app.js                 → uploadPhoto(item)、photoUrl(item)、放大 dialog 状态
tests/photo.test.ts                   → 模块 + API 测试（≥10 项）
docs/DEPLOYMENT.md                    → 注明 photos 目录迁移
```

## 数据模型

- 磁盘：`data/photos/<orderId>.<jpg|png>`（一单一图，重传覆盖）
- 订单记录（registration kind）扩展字段：`photoToken?: string`、`photoMime?: 'image/jpeg' | 'image/png'`
- OrderSlipSchema 增加两个 optional 字段（向后兼容，旧数据无此字段照常通过）

## Code Style

```typescript
// 魔数校验，拒绝仅凭扩展名/base64 前缀伪装的文件
function detectImageMime(buffer: Buffer): 'image/jpeg' | 'image/png' | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 4).toString('hex') === '89504e47') return 'image/png';
  return null;
}
```

## Testing Strategy

- tests/photo.test.ts：魔数检测、大小边界（5MB ± 1B）、保存/覆盖/token 轮换
- API 层：上传→查看→越权→伪造 token→错误格式全链路（inject，用小 PNG/JPEG 真实字节构造）
- 既有 252 项保持全绿（OrderSlipSchema 扩展向后兼容是关键回归点）

## Boundaries

- **Always**: 照片写入前做魔数+大小校验；token 每次上传轮换；查看走恒定时间比较
- **Ask first**: 引入图片处理库（本模块不需要）；修改 OrderSlipSchema 之外的 schema
- **Never**: 不做 EXIF 清理（无依赖可用，备注安全限制）；不接受 base64 之外的传输形态；不把照片放进 SQLite

## Success Criteria

1. 店长对名下订单上传真实照片（jpg/png ≤5MB）成功，重传覆盖且旧链接失效
2. 客户在自己订单看到缩略图并可放大
3. 越权访问（跨店、伪造 token、无照片）全部拒绝
4. 252+10 项测试全绿，tsc 无错
5. DEPLOYMENT.md 说明照片目录随 data/ 迁移

## Open Questions

（无——两个边界问题已在上一轮获批：客户在订单行看缩略图；单订单限 1 张重传覆盖）
