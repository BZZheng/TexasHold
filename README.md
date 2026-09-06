# 好友德州扑克

一个面向 2–8 位好友私局的响应式网页德州扑克原型。支持账号、房间码、实时在线积分榜、观战、选座申请、发牌、看牌、下注、加注、全押、摊牌、补充筹码、下一局入座，以及深浅色主题、三档字号和可静音的普通牌局行动线语音播报；每次轮到玩家时有 30 秒基础思考时间，并可在当前行动回合花费 500 筹码购买一次额外 60 秒。房间连续两小时只有一位真人玩家时会自动解散，测试机器人不计入人数。

## 本地运行

```bash
cp .env.example .env
make install
make dev
```

打开 `http://127.0.0.1:5173`。前端会连接运行在 `7790` 端口的本地服务端。

常用验证命令：

```bash
make doctor
make test
make build
```

若本机 Docker 可用：

```bash
docker compose -f docker-compose.local.yml up --build
```

然后打开 `http://127.0.0.1:7790`。

## 快速验证

1. 注册账号并创建房间。
2. 在房间等待页点击“添加测试玩家”，补足至少两人。
3. 所有玩家点击“准备”后由房主开始游戏；若仍有人未准备，服务端会阻止开局、向未准备玩家发送提醒，并把名单提示给房主。
4. 点击自己的背面底牌查看；轮到自己时测试加时卡、过牌、跟注、加注或全押。加时卡费用从当前筹码扣除且不进入底池。
5. 三人及以上牌局中弃牌后，当前玩家自动进入本局观战视角；座位和筹码保留，并可继续查看仍在本局中的非神秘玩家，即使对方关闭了外部观战；本局结束后自动恢复牌桌视角。
6. 房间聊天区保持固定高度，消息只在侧栏内部滚动，输入框固定在底部。
7. 筹码归零后选择补充筹码，或转为观战。
8. 也可以在另一个无痕窗口注册第二个账号，通过房间码加入；观战者申请入座时先选择空位，提交申请后在进行中的牌局里继续观战，验证真实多人同步。

本地账号数据保存在 `data/texashold.json`，房间、牌堆、手牌、筹码和当前行动状态保存在 `data/runtime-rooms.json`。两个文件都使用原子替换写入；服务重启后会恢复原牌局，并刷新一次性行动令牌。

## 防作弊与部署安全

本项目采用服务端权威牌局：浏览器不能提交手牌、牌堆、公共牌、筹码或玩家身份；所有下注合法性、发牌与结算都由服务端重新计算。每个行动回合都有一次性令牌，重复或延迟请求会被拒绝。登录使用 HttpOnly Cookie，Socket 来源、消息大小和调用频率也有服务端限制。

生产环境必须从安全模板创建一个不进入 Git 的目标配置：

```bash
cp deploy/production.env.example deploy/production.env
chmod 600 deploy/production.env
make env-check-production ENV_FILE=deploy/production.env
docker compose \
  --project-name texas-holdem \
  --env-file deploy/production.env \
  -f docker-compose.production.yml \
  up -d --build
```

生产配置默认把容器端口绑定到回环地址，并要求 `APP_ORIGINS` 精确匹配站点来源。推荐通过 HTTPS 反向代理访问并保持 `COOKIE_SECURE=true`；若使用纯 HTTP，环境校验会明确提示 Cookie 缺少传输层保护。

完整的 Make、Docker、通用远程发布、可选归档、日志和 Git 发布检查见 [`DEPLOY.md`](DEPLOY.md)，结构化日志说明见 [`docs/observability.md`](docs/observability.md)。真实环境文件、SSH 私钥、运行数据、数据库连接信息、备份、日志和构建产物均不得提交。

## 后续无感升级

运行中的房间状态已持久化到生产数据卷。Docker 停止旧容器时，服务会先完成最终快照；新容器恢复相同的房间码、牌堆、手牌、筹码、底池和行动顺序，当前玩家会得到额外 10 秒重连缓冲。浏览器的 Socket.IO 会自动重连并收到新的行动令牌，因此不会重新发牌或丢失本局。

```bash
./deploy/seamless-upgrade.sh
```

脚本会保留旧镜像用于回滚、先构建替换镜像、让旧进程在退出前写入最终快照，再检查 `/api/health` 的 `runtime.persistenceHealthy`。本次把旧版升级到首次支持快照的版本时，旧进程还没有恢复能力，因此第一次仍需在没有进行中牌局时执行：

```bash
TEXAS_HOLDEM_ALLOW_LEGACY_UPGRADE=1 ./deploy/seamless-upgrade.sh
```

完成这次部署后，后续兼容版本直接运行脚本即可恢复进行中的牌局。连接本身会短暂自动重连，但牌局连续性不受影响。

需要长期保留日志和快照时，可启用独立的远程归档；该能力默认关闭，不影响本地部署与联调。归档目录、保留策略和恢复方法见 [`deploy/backup/README.md`](deploy/backup/README.md)。

完整威胁模型与生产检查项见 [`SECURITY.md`](SECURITY.md)。
