# Capability Map: 排列3 ERP 差距补齐（glm5.3-PLT）

> 状态：2026-10-14 用户口头批准（"开始"），含两个默认决策（自助注册、照片 5MB 限制）
> 需求来源：docs/intent/pailie3-erp.md（已确认需求书）

| 模块 id | 职责 | 依赖 | 状态 |
|---|---|---|---|
| commission-fix | 佣金口径：中奖奖金 20%（店长 10%），clientNetGain = 奖金 − 佣金 | — | ✅ 已完成（commit 17abc61） |
| referral-qr | 店长专属二维码/分享链接 → 客户扫码自助注册即归属该店长 → 老客户分享仍指向所属店长 → 总部统计每日分享/注册数 | — | ✅ 已完成 |
| ticket-photo | 店长对订单拍照上传彩票照片（5MB jpg/png），客户端订单详情可见；**完全自愿、无审核、不强制** | — | ✅ 已完成 |
| watermark | 全部登录后页面叠加动态水印（用户名+时间），配合安卓壳 FLAG_SECURE | — | ✅ 已完成 |
| deploy-pack | Caddyfile（HTTPS+APK 下载分发）、部署文档更新到新加坡服务器 101.32.167.156 高端口场景 | referral-qr, ticket-photo | ✅ 已完成 |

**构建顺序：** referral-qr → ticket-photo → watermark → deploy-pack

**已批准的设计决策：**
1. 客户扫码后**自助注册**（昵称+自设密码），注册即归属二维码对应的店长，无需店长激活
2. 照片限制 **5MB，jpg/png**
3. 二维码落地页即 APP 同一入口（H5 + 推荐参数），安卓壳打开同一地址
4. 照片存服务器本地磁盘（data/ 目录，随备份迁移）
