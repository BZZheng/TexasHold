# TexasHold 开发与部署手册

本手册覆盖本地双进程开发、生产构建、Make 管理的单机进程，以及 Docker Compose 部署。仓库命令不会自动推送 Git 或连接任何远程主机；远端发布仍需运维人员显式执行通用部署脚本。

## 一次性准备

要求 Node.js 22.12 或更高版本、npm 和 curl。Docker 部署还要求 Docker Engine 与 Compose v2。

```bash
cp .env.example .env
chmod 600 .env
make install
make doctor
```

`.env`、`deploy/*.env`、SSH 私钥、运行数据、数据库文件、备份、日志、PID 和构建产物均被 Git 忽略。只能提交 `.env.example` 或 `*.env.example`。不要把真实域名、地址、用户名、密钥路径、数据源连接串或恢复快照复制进示例文件。

## 常用命令

```bash
make dev                 # 前端与服务端同时热更新，前台运行
make dev-server          # 只启动服务端 watcher
make dev-web             # 只启动 Vite
make test                # 全量测试
make build               # 生产前端构建
make check               # 测试 + 构建
```

需要使用其他本地配置时可执行 `make dev ENV_FILE=path/to/local.env`；Make 会把该文件显式传给 watched Node 后端，而不是静默回退到固定的 `.env`。

本地页面是 `http://127.0.0.1:5173`，API 默认是 `http://127.0.0.1:7790`。

## 单机生产进程

先从生产模板创建一个不进 Git 的环境文件，并替换示例域名和路径：

```bash
cp deploy/production.env.example deploy/production.env
chmod 600 deploy/production.env
make env-check-production ENV_FILE=deploy/production.env
```

前台运行适合 systemd 或进程监督器：

```bash
make run ENV_FILE=deploy/production.env
```

Make 也能管理一个后台进程，PID 和日志分别保存在 `.run/`、`.logs/`：

```bash
make start ENV_FILE=deploy/production.env
make status APP_PORT=7790
make health APP_PORT=7790
make logs
make stop
```

`make stop` 只会向 PID 文件中且命令行包含 `server/index.js` 的进程发送普通终止信号；15 秒后仍未退出时会报错，不会自动强杀。

`.logs/app.log` 是 Make 后台进程的 stdout/stderr 汇总；应用结构化日志由 `LOG_DIR` 管理。两者用途不同，可分别通过 `SERVICE_LOG_DIR` 和 `LOG_DIR` 配置。

## Docker Compose

配置检查不会创建或替换容器：

```bash
make compose-check ENV_FILE=deploy/production.env
```

确认数据目录已备份、没有未处理的环境告警后，再由运维人员显式执行：

```bash
docker compose \
  --project-name texas-holdem \
  --env-file deploy/production.env \
  -f docker-compose.production.yml \
  up -d --build
```

生产健康检查（把保留示例域名替换为自己的域名）：

```bash
curl --fail --silent --show-error https://play.example.com/api/health
```

响应必须同时满足 `ok: true`、`runtime.persistenceHealthy: true` 和 `runtime.recoverable: true`，再视为可承接牌局。无感升级与自动回滚流程见 `deploy/seamless-upgrade.sh`；第一次从不支持快照的旧版本升级时，必须等所有牌局结束后再使用人工确认开关。

## 应用服务器与可选远程归档

- 应用服务器只使用绝对持久化目录；容器内 `/data` 是唯一可写业务卷。
- 远程归档完全可选。默认 `LOG_ARCHIVE_MODE=disabled`，不配置归档也能正常开房、下注、结算和本地联调。
- 需要长期保存时，可由独立归档主机通过受限 SSH 异步拉取。不要把网络文件系统放进牌局关键路径。
- 仅在已挂载且可检测的归档目录上使用 `LOG_ARCHIVE_MODE=push`。`LOG_ARCHIVE_DIR` 必须预先存在，建议用 `LOG_ARCHIVE_READY_FILE` 指向挂载内哨兵；应用不会自动创建挂载根目录。
- 账号密码哈希、会话摘要、牌堆、底牌、筹码与历史事件都属于敏感运行数据，即使不是明文密码也不能进入 Git。
- SSH 私钥必须在仓库外、权限为 `0600`，远程部署通过 `TEXAS_HOLDEM_SERVER_KEY` 引用；可选归档使用独立密钥。
- `COOKIE_SECURE=true` 只能与 HTTPS 来源一起使用；纯 HTTP 部署会被环境校验明确警告。
- 部署前执行 `make check` 和 `make compose-check`，部署后验证健康接口和备份拉取日志。

远程部署参数从 `deploy/deploy.env.example` 复制；可选归档参数从 `deploy/backup/archive.env.example` 复制。示例只使用 IANA 保留的 `example.com` 域名和 `/srv/texas-holdem` 通用路径，真实 `.env` 文件不会进入 Git。

完整 JSONL 字段、容量策略、可选归档协议和查询方式见 [`docs/observability.md`](docs/observability.md)。

## 通用远程发布（可选）

需要发布到自己管理的 Linux 主机时，复制部署参数并显式执行脚本：

```bash
cp deploy/deploy.env.example deploy/deploy.env
chmod 600 deploy/deploy.env
./deploy/deploy-remote-server.sh
```

脚本只读取 `TEXAS_HOLDEM_SERVER_HOST`、`TEXAS_HOLDEM_SERVER_USER`、`TEXAS_HOLDEM_SERVER_KEY` 和 `TEXAS_HOLDEM_SERVER_ROOT`，不会内置或推断任何基础设施地址。目标账号需要能够管理 Docker，并写入指定的服务目录。可选归档导出器会安装到 `$TEXAS_HOLDEM_SERVER_ROOT/bin/`；若不需要远程归档，不要为它配置 SSH 授权。

如果目标主机不能访问镜像或依赖仓库，可先在联网机器上构建目标架构镜像并导出，再配置 `TEXAS_HOLDEM_PREBUILT_IMAGE_FILE`。部署脚本会通过 SSH 流式加载该镜像，并跳过远端构建；健康检查与自动回滚保持不变。例如：

```bash
git archive HEAD | docker build --platform linux/amd64 -t friends-holdem:production -
mkdir -p releases
docker save friends-holdem:production | gzip > releases/friends-holdem-linux-amd64.tar.gz
TEXAS_HOLDEM_PREBUILT_IMAGE_FILE=releases/friends-holdem-linux-amd64.tar.gz \
  ./deploy/deploy-remote-server.sh
```

## Git 发布检查

```bash
git status --short --branch
git diff --check
git ls-files | grep -E '(^|/)(data|\.env|\.logs|\.run)/|\.(pem|key|p12|pfx|sqlite|db)$' && exit 1 || true
```

若敏感文件曾经进入历史，仅新增 `.gitignore` 不足以消除泄露：先轮换凭据，再通过经过审核的历史重写流程清除对象，最后协调所有克隆重新同步。不要在未备份和未沟通时直接改写共享分支。
