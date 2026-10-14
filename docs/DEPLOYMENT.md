# 单目录部署、备份与迁移

本服务只登记已经在线下完成的业务及其对账记录。运行目录为整个 `records-erp/`，无须引用仓库其他目录；Android 工程不参与容器构建。需要 Docker Engine 和支持 `up --wait` 的 Docker Compose v2+。首轮构建需要下载 Node 基础镜像及锁定依赖。

## 一键启动

```sh
cd records-erp
./scripts/start.sh
```

脚本会创建仅当前用户可读的 `.env`，以及 `data/`、`backups/`，构建镜像并等待健康检查通过。默认地址为 `http://127.0.0.1:19888`。数据及账号摘要保存在 `data/app.db`，SQLite 的 `-wal`、`-shm` 文件也保留在同一个挂载目录。镜像以非 root 用户运行，根文件系统只读；服务容器没有 Linux capabilities。应用通过 Node 直接接收 SIGTERM，Compose 等待最多 30 秒完成关闭与数据库关闭。

启动脚本把当前非 root 用户的 UID/GID 写入 `.env`，root 执行时默认使用 `1000:1000`，并设置挂载目录所有权。迁移后服务账号 UID/GID 不同时，请先更新 `.env` 并调整 `data/`、`backups/` 所有权；不要将目录设为全员可写。脚本只设置目录本身，不递归改变既有文件的所有者。单个数据目录只允许一个应用容器使用；不要扩为多副本或用不同 Compose 项目名同时打开该目录。

首次使用可先复制 `.env.example` 为 `.env` 并按需设置：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BIND_ADDRESS` | `127.0.0.1` | 宿主机监听地址 |
| `ERP_PORT` | `19888` | 宿主机端口；容器内部保持 19888 |
| `DEMO_SEED` | `false` | 仅显式设置 `true` 才加载合成演示业务历史 |
| `AUTH_BOOTSTRAP_PASSWORD` | 空 | 可覆盖尚未创建账号的初始口令；不重置已有账号 |
| `COOKIE_SECURE` | `false` | HTTPS 访问时设为 `true`；本机 HTTP 调试使用 `false` |
| `ERP_UID` / `ERP_GID` | 启动时写入 | 正整数，禁止 root UID/GID |

含 `$`、`#`、空格的口令在 `.env` 内使用单引号，避免 Compose 插值或注释截断。`.env` 不进入 Git、镜像或备份快照。不要把 `docker compose config` 的完整输出发到聊天或日志，因为其中可能包含口令；校验配置使用 `docker compose config --quiet`。

默认不插入合成业务。首次账号与归属的建立过程参见 [AUTHENTICATION.md](./AUTHENTICATION.md)。在已有数据库上更改初始化变量不会重置账号、归属或业务记录。对外访问应在同机反向代理配置 HTTPS，并将 `COOKIE_SECURE=true`；原始 Node 端口默认只绑定本机，反向代理配置及证书需按目标服务器单独设置。

```sh
docker compose ps
docker compose logs --tail 100 erp-app
docker compose stop --timeout 30 erp-app
docker compose up --detach --wait
```

## 在线一致备份

```sh
./scripts/backup.sh
# 或明确指定一个新文件名，已有备份不会被覆盖：
./scripts/backup.sh before-upgrade.db
```

脚本使用 SQLite `VACUUM INTO` 创建一致快照，包含备份时已提交的 WAL 数据，排除未提交的事务；不直接复制正在写入的 `app.db`。快照先写入临时文件，通过 `PRAGMA quick_check` 后以独占方式发布到 `backups/`，权限为 `0600`。备份完成后数据库仍可正常使用。快照包含所有业务表和账号摘要，妥善限制备份访问权限，并复制到独立存储验证恢复。

**票照文件（ticket-photo 模块）不在数据库快照内。** 照片以文件形式存放在 `data/photos/`（每单一图，文件名为订单 ID）。`backup.sh` 的数据库快照不包含这些文件；迁移或灾备时需在服务停止后单独打包 `data/photos/` 目录随快照一并转移，恢复时先执行 `restore.sh` 再把 `photos/` 放回 `data/` 下。订单记录中的 `photoToken` 保存在数据库里，照片文件与数据库不一致时查看会返回 404。

不要在服务运行时单独复制 `app.db`，也不要分别、并行复制 `app.db` 和 `app.db-wal`。两种方式都可能得到不一致的数据。若要复制整个 `data/` 目录，先 `docker compose stop --timeout 30 erp-app`，确认容器停止后再整体复制，且复制期间不允许其他进程连接该目录。在线备份脚本适合不断服的常规快照。

## 恢复与新服务器迁移

1. 在原服务器运行一致备份脚本。
2. 将 `records-erp/` 的源码、锁定依赖清单、Docker 配置、`scripts/`、文档以及所选 `backups/*.db` 拷贝到新服务器。运行中不要随目录复制 `data/`；可只携带快照。`.env` 含敏感配置，需要单独受控传输，或者在新主机从示例重新建立；无需复制 `node_modules/`。
3. 在新服务器按新的运行用户配置 `.env`，然后运行 `./scripts/start.sh`。保持 `DEMO_SEED=false`，默认 loopback 端口；准备恢复的服务不应提前对外开放。
4. 执行恢复脚本：

```sh
./scripts/restore.sh before-upgrade.db
```

恢复脚本先停止应用并检查它已停止，再用一次性容器验证快照。若目标已有数据库，先在 `backups/before-restore-*.db` 保留恢复前的一致快照，然后检查 WAL checkpoint、替换数据库及清理旧 WAL/SHM，最后启动并等待健康检查。恢复命令失败时保持应用停止，原数据库或恢复前备份可供检查与回退。任何其他直接使用该数据目录的进程也必须事先停止；脚本只能管理本 Compose 项目的应用容器。

恢复后先核对登录账号、所属门店、客户、存根、结余及审计流水，再切换反向代理或域名。进程内会话在重启后失效，需重新登录。恢复不会重置保存的口令。需要回退时，将脚本生成的 `before-restore-*.db` 文件名传给同一恢复脚本。快照恢复会回到备份时点，之后写入的数据不会自动合并。

如果容器健康等待失败，查看日志，检查磁盘空间、UID/GID、目录权限、环境变量和端口占用。修正后可重复运行启动脚本。不要删除 `data/` 来排除启动错误。

## 公网部署：腾讯云新加坡 101.32.167.156 高端口

目标形态：Caddy（`https-proxy` 服务，host 网络）直接监听 `https://101.32.167.156:19888/` 做 HTTPS 终结与 APK 分发，反代到仅绑定 `127.0.0.1:19889` 的应用容器；公网流量无法直达 Node 进程。三处对外地址必须保持一致（见文末核对表）。

在全新服务器上按以下顺序操作（需要 Docker Engine 与 Compose v2+，以及 git clone 本仓库）：

1. **证书**：生成自签证书放入 `ssl/`（目录已被 `.gitignore` 排除，私钥不入库）：
   ```sh
   mkdir -p ssl
   openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
     -keyout ssl/privkey.pem -out ssl/fullchain.pem \
     -subj '/CN=101.32.167.156' -addext 'subjectAltName=IP:101.32.167.156'
   ```
   安卓壳 WebView 已容忍自签告警；手机浏览器首次访问会提示「不安全」，选择继续即可。换正式证书/域名时同步修改 `Caddyfile` 站点地址与安卓壳加载地址。
2. **配置 `.env`**：`cp .env.example .env`，将 `COOKIE_SECURE=true`（HTTPS 场景 Cookie 仅安全传输）、`ERP_PORT=19889`、`DEMO_SEED=false`。首账号与归属建立参见 [AUTHENTICATION.md](./AUTHENTICATION.md)。
3. **启动**：`./scripts/start.sh`——构建应用容器并等待健康检查；随后 Caddy 容器自动随 compose 起来（`restart: always`）。验证：
   ```sh
   curl -k https://101.32.167.156:19888/api/health
   docker compose logs --tail 100 https-proxy
   ```
4. **分发安卓安装包**：将 `pailie3.apk` 放到仓库根目录（已被 `.gitignore` 排除，不入 Git），手机浏览器访问 `https://101.32.167.156:19888/pailie3.apk` 即可下载离线安装。
5. **防火墙/安全组**：在腾讯云安全组放行入站 TCP `19888`（仅此一个端口；19889 只监听 loopback，无须也不应放行）。

**对外地址一致性核对表**（三处必须指向同一地址，改动任一处须同步其余两处）：

| 位置 | 地址 |
| --- | --- |
| `Caddyfile` 站点块 | `https://101.32.167.156:19888` |
| 安卓壳 `android-app/app/src/main/java/com/pailie3/store/MainActivity.java`（`loadUrl`） | `https://101.32.167.156:19888/` |
| 推广二维码/分享链接 | 前端用 `window.location` 动态生成，自动跟随访问地址，无需改动 |

公网运行的其他注意事项：`COOKIE_SECURE=true` 后 cookie 不再经 HTTP 明文传输；升级前先 `./scripts/backup.sh`；`data/photos/` 的迁移要求见上文备份章节；云服务器需保证磁盘余量（SQLite WAL 与照片文件同盘）。

## 本地验证范围

`npm test` 中的 `deployment.test.ts` 使用真实 SQLite 文件与 WAL，验证包含已提交数据、排除进行中事务、拒绝覆盖快照、恢复前留档、损坏快照不替换数据和空目录恢复；另验证恢复脚本先停写、失败保持停止与路径校验。`docker compose config --quiet` 检查 Compose 配置语法。镜像构建和实际健康启动需要本机 Docker daemon、基础镜像及依赖可用；这两类验证应单独记录，不把单元测试等同于云服务器部署完成。

2026-10-13 已在本机独立临时目录完成真实 Docker 验收：Docker Engine 29.4.0、Compose 5.1.2、容器 Node 26.11.1；一键构建与健康启动成功。运行 UID 为 501，根文件系统写入被拒绝，镜像不含 `.env` 和 Vitest，健康接口与专用测试账号登录均返回 200。实测在线快照、停止服务、恢复、健康重启和重新登录通过：恢复后保留备份时的 1 条测试记录，恢复前留档保留 2 条记录。测试容器、网络及项目测试镜像已移除；未部署云服务器，未使用实际业务数据。
