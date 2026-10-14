# Spec: deploy-pack — 部署件补齐（腾讯云新加坡 101.32.167.156）

> 模块 id: `deploy-pack` ｜ 能力地图: [CAPABILITY-MAP.md](./CAPABILITY-MAP.md)
> 需求来源: docs/intent/pailie3-erp.md「部署到腾讯云新加坡服务器高端口、离线 APK 直传」

## Objective

补齐 docker-compose.yml 已引用但仓库中缺失的三个部署件（Caddyfile、ssl/ 目录说明、pailie3.apk 分发位），补上 `scripts/start.sh` 依赖的 `.env.example`，并把 DEPLOYMENT.md 更新到真实目标场景：**腾讯云新加坡 `101.32.167.156`，Caddy 以 host 网络直接监听 `https://101.32.167.156:19888/`，反代到仅绑定 `127.0.0.1:19889` 的应用容器**。安卓壳加载地址与 Caddy 监听地址完全一致（`https://101.32.167.156:19888/`），推广二维码链接因前端用 `window.location` 动态生成、自动跟随对外地址，无需改代码。

本模块**只产出仓库内的部署件文件与文档，不在本回合操作真实服务器**——实际部署到 101.32.167.156 时另行请求授权执行。

## 用户故事 / 验收标准（具体可测）

1. 作为运维，我在目标服务器 `git clone` 仓库后，按 DEPLOYMENT.md 新章节操作即可完成 HTTPS 部署：
   - [x] `Caddyfile` 存在且配置为：监听 `https://101.32.167.156:19888`（自签或自有证书 tls 指向 `/etc/caddy/ssl/`）、`reverse_proxy 127.0.0.1:19889`、根路径 serve 静态目录以便 `https://101.32.167.156:19888/pailie3.apk` 可下载（`@apk` matcher + `file_server`，Content-Type `application/vnd.android.package-archive`）
   - [x] `.env.example` 存在，包含 DEPLOYMENT.md 变量表列出的全部键（BIND_ADDRESS/ERP_PORT/DEMO_SEED/AUTH_BOOTSTRAP_PASSWORD/COOKIE_SECURE/ERP_UID/ERP_GID），`COOKIE_SECURE` 默认注释说明生产为 true
   - [x] `ssl/` 与 APK 分发：README 或 DEPLOYMENT 注明管理员自备证书放入 `ssl/`（`fullchain.pem`+`privkey.pem` 或 Caddy 自签），`pailie3.apk` 放仓库根（`.gitignore` 排除，防大二进制进 Git），Caddy 挂载后即可分发
   - [x] `docker compose config --quiet` 通过（本回合用本地 Docker CLI 验证）
2. 作为店长/客户，我从 `https://101.32.167.156:19888/pailie3.apk` 下载安卓安装包离线安装，打开即连上服务（地址与 MainActivity.java:45 写死值一致，无跳转）。
3. 作为总部管理员，我扫码/分享出去的推广链接形如 `https://101.32.167.156:19888/?ref=<code>`，与安卓壳同源，扫码注册后归属正确（前端 `window.location` 动态生成，已实现，文档固化说明即可）。

**验收标准（具体可测）——已全部满足 ✅ 2026-10-14：**
- [x] `Caddyfile`：`https://101.32.167.156:19888` 站点块 + tls 证书路径 + `/pailie3.apk` handle（Content-Type/Content-Disposition + file_server）+ 其余 `reverse_proxy 127.0.0.1:19889`；头部注释含自签证书 openssl 命令与换正式证书的同步要点
- [x] `.env.example`：六键齐备（ERP_UID/ERP_GID 注释形式），`COOKIE_SECURE=false` 默认 + 注释「生产 HTTPS 设 true」，`ERP_PORT=19889`
- [x] `ssl/`：目录 + README（占位说明，`.gitignore` 已排除 `/ssl/`）
- [x] `.gitignore` 追加 `/pailie3.apk` 与 `/ssl/`
- [x] `docker-compose.yml`：`COOKIE_SECURE` 改读 `"${COOKIE_SECURE:-false}"`
- [x] `docs/DEPLOYMENT.md` 新增「公网部署：腾讯云新加坡 101.32.167.156 高端口」章节：五步操作（证书→.env→start.sh→APK 分发→安全组）+ 三地址一致性核对表
- [x] `docs/CAPABILITY-MAP.md` deploy-pack → ✅
- [x] 回归：`npm test` 270 项全过零 unhandled error（顺手修复 photo.test.ts 两处流未消费导致的清理竞态）+ `npx tsc --noEmit` 无错 + `docker compose config --quiet` 通过

**补充业务规则（2026-10-14 用户确认）：** 票照上传为**完全自愿**环节——除非顾客私下与店主沟通、店主自行决定，不上传也完全正常；无审核流程，不强制上传。当前实现即此语义，无代码改动。

## Tech Stack

零代码改动、零新依赖。纯部署件：Caddy 2 静态配置文件 + env 模板 + 文档。

## Commands

```sh
docker compose config --quiet   # compose 引用的文件路径与语法校验
npm test                        # 回归确认无破坏（应全绿，无代码改动）
```

## Project Structure（新增/改动）

```
Caddyfile                       → 新增：HTTPS 反代 + APK 分发（compose 已引用）
.env.example                    → 新增：start.sh 与 DEPLOYMENT.md 依赖的模板
.gitignore                      → 追加 pailie3.apk 与 ssl/（证书不入库）
docs/DEPLOYMENT.md              → 增「公网部署：腾讯云新加坡 101.32.167.156」章节
docs/CAPABILITY-MAP.md          → deploy-pack 状态 ✅
```

## 部署形态（核心配置一段）

```caddyfile
https://101.32.167.156:19888 {
    tls /etc/caddy/ssl/fullchain.pem /etc/caddy/ssl/privkey.pem
    encode gzip
    handle /pailie3.apk {
        header Content-Type application/vnd.android.package-archive
        file_server
    }
    handle {
        reverse_proxy 127.0.0.1:19889
    }
}
```

- `https-proxy` 容器 `network_mode: host`（既有），直接占用宿主 19888；应用容器仅绑 `127.0.0.1:19889`，公网无法直达 Node
- 生产 `.env` 设置 `COOKIE_SECURE=true`（HTTPS 下 Cookie 仅安全传输）
- 自签证书导致安卓壳 `onReceivedSslError → handler.proceed()`（MainActivity 已有，属已知信任模型；文档注明换正式证书更佳）

## Boundaries

- **Always**: `docker compose config --quiet` 验证；文档写明先 `backup.sh` 再升级；Cookie 安全标记与 HTTPS 场景对应
- **Ask first**: 真实服务器上的任何操作（SSH 上 101.32.167.156 执行部署/生成证书/放置 APK）——本回合只做仓库内文件
- **Never**: 不把证书私钥或 APK 提交进 Git；不改应用代码（compose 现有 `COOKIE_SECURE: "false"` 硬编码改为读 env `"${COOKIE_SECURE:-false}"` 属部署件修正，是唯一一处 compose 改动）；不引入域名/DNS（当前按裸 IP 高端口方案）

## Success Criteria

1. `docker compose config --quiet` 通过，Caddyfile 路径引用闭环
2. 全量测试保持全绿（无代码改动，应零影响）
3. 按 DEPLOYMENT.md 新章节，管理员在全新服务器上具备完整可跟随的操作路径（clone → 证书 → .env → start.sh → APK 上传）
4. 安卓壳地址、Caddy 监听、二维码链接三者指向同一 `https://101.32.167.156:19888/`，文档中有一致性核对表

## Open Questions

1. **证书形态**：自签（零成本，安卓壳已容忍，但手机浏览器首次访问会告警）还是你有正式证书/域名？默认按自签写文档。
2. **APK 分发位**：仓库根 `pailie3.apk`（compose 已按此挂载，gitignore 排除、由你手动上传到服务器）——确认这样即可，还是想改成 `dist/` 目录？
