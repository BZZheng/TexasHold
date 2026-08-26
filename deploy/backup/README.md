# 外部数据归档

应用服务在 `$DATA_DIR/hot` 保存低延迟热状态，并在 `$DATA_DIR/archive-ring` 保存有容量上限的待归档事件。独立归档端通过私有网络和限权 SSH 异步拉取，默认建议周期为 30 秒。归档端暂时离线不会中断牌局。

当前版本没有外部数据库：账号和牌局恢复状态都是本地 JSON 文件。归档包是敏感运行数据，不是可以提交到 Git 的数据库 fixture。

## 配置

在归档端从模板创建一个不进入 Git 的配置文件：

```bash
cp deploy/backup/archive.env.example deploy/backup/archive.env
chmod 600 deploy/backup/archive.env
```

`TEXAS_HOLDEM_ARCHIVE_ROOT` 必须是以 `/texas-holdem` 结尾的绝对路径。远端、专用 SSH 私钥和保留周期也必须显式配置；模板仅包含保留示例域名和通用占位路径。

- 根目录：`$TEXAS_HOLDEM_ARCHIVE_ROOT`
- 最新副本：`latest/texas-holdem-state.json`
- 时间点快照：`backups/YYYY/MM/DD/texas-holdem-state-YYYYMMDDTHHMMSSZ.json`
- 去重牌局事件：`archive/hands/YYYY/MM/<event-id>.json`
- 结构化应用日志：`logs/app/YYYY/MM/DD/<sha256>-application-*.jsonl`
- 归档任务日志：`logs/backup.log`

只有内容变化时才新增快照，默认保留 90 天。目录和数据文件权限分别为 `0700` 与 `0600`。

## 安全边界

归档端使用独立 SSH 密钥连接应用主机。应用主机的 `authorized_keys` 必须将该密钥限制为只能执行固定导出命令，禁止终端、端口转发和其他命令。真实主机、用户名、密钥路径及目录只保存在被 Git 忽略的 `archive.env` 中。

拉取脚本会验证 JSON 结构，并拒绝包含明文会话令牌的文件。当前传输协议是 `backupVersion: 3`：除账号密码哈希、会话摘要、牌局历史和进行中房间快照外，还可包含自上次拉取以来的已轮转 JSONL 日志段。归档端会校验日志 SHA-256 和脱敏规则后单独原子归档，日志不会进入长期状态快照。整个传输必须始终按敏感数据处理。

运行命令：

```bash
TEXAS_HOLDEM_ARCHIVE_ENV_FILE=deploy/backup/archive.env \
  ./deploy/backup/archive-pull-backup.sh
```

应用日志使用本地有界归档环；外部归档不可用不会影响牌局。详细字段、容量和排障方式见 [`docs/observability.md`](../../docs/observability.md)。

## 恢复原则

恢复前先停止游戏进程，从选中的归档快照中取出：

- `account` 写回 `$DATA_DIR/hot/texashold.json`
- `runtime` 写回 `$DATA_DIR/hot/runtime-rooms.json`；若为 `null` 则不创建该文件
- `archive` 写回 `$DATA_DIR/archive-ring/history-events.json`

目标文件保持 `0600` 权限，再启动服务。不要在进程仍写入数据时覆盖正式文件。新进程会恢复进行中的牌局、刷新行动令牌，并给当前玩家增加重连缓冲时间。
