# 外部数据归档

应用服务在 `$DATA_DIR/hot` 保存低延迟热状态，并在 `$DATA_DIR/archive-ring` 保存有容量上限的待归档事件。独立归档端通过私有网络和限权 SSH 异步拉取，默认建议周期为 30 秒。归档端暂时离线不会中断牌局。

应用服务没有在线外部数据库：账号和牌局恢复状态仍是本地 JSON 文件。NAS 归档任务会维护一个离线 SQLite 分析库；它不参与发牌、行动或结算关键路径。归档包、逐手分析和数据库都属于敏感运行数据，不能提交到 Git。

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
- 私有逐手分析：`archive/analysis/hands/YYYY/MM/<hand-id>.json`
- 策略分析数据库：`database/texas-holdem-analytics.sqlite3`
- 结构化应用日志：`logs/app/YYYY/MM/DD/<sha256>-application-*.jsonl`
- 归档任务日志：`logs/backup.log`

只有内容变化时才新增快照，默认保留 90 天。目录和数据文件权限分别为 `0700` 与 `0600`。

## 安全边界

归档端使用独立 SSH 密钥连接应用主机。应用主机的 `authorized_keys` 必须将该密钥限制为只能执行固定导出命令，禁止终端、端口转发和其他命令。真实主机、用户名、密钥路径及目录只保存在被 Git 忽略的 `archive.env` 中。

拉取脚本会验证 JSON 结构，并拒绝包含明文会话令牌的文件。当前传输协议是 `backupVersion: 4`：除账号密码哈希、会话摘要、牌局历史、进行中房间快照和已轮转 JSONL 日志段外，还包含结算后的私有逐手分析。逐手分析保存全部玩家底牌、公共牌、座位、筹码变化、弃牌街道和下注行动路线，因此只落入 `0600` 权限的私有归档与 SQLite，不会写进通用日志。整个传输必须始终按敏感数据处理。

运行命令：

```bash
TEXAS_HOLDEM_ARCHIVE_ENV_FILE=deploy/backup/archive.env \
  ./deploy/backup/archive-pull-backup.sh
```

应用日志使用本地有界归档环；外部归档不可用不会影响牌局。详细字段、容量和排障方式见 [`docs/observability.md`](../../docs/observability.md)。

SQLite 采用幂等写入，重复拉取同一 `hand_id` 不会产生重复行。基础表为：

- `hands`：房间、手数、盲注、公共牌、结算原因和赢家；
- `hand_players`：每位玩家的初始/最终两张底牌、座位、起止筹码、弃牌/摊牌和牌型；
- `hand_actions`：按 `sequence` 保存翻牌前到河牌的过牌、跟注、下注、加注、全押和弃牌，以及行动前后的底池、跟注额、有效筹码和自动行动来源。
- `player_strategy_summary`：按稳定 `user_id` 汇总 VPIP、PFR、摊牌率、胜手率、侵略因子、超时行动和净筹码变化，并显示最近一次玩家显示名。

例如按最近一次玩家显示名查看 `pokerKing` 的累计策略指标：

```bash
sqlite3 "$TEXAS_HOLDEM_ARCHIVE_ROOT/database/texas-holdem-analytics.sqlite3" \
  "SELECT * FROM player_strategy_summary WHERE username = 'pokerKing';"
```

正式分析建议查询一次后记下 `user_id`，后续按稳定 ID 聚合，避免改昵称导致筛选不完整。

## 恢复原则

恢复前先停止游戏进程，从选中的归档快照中取出：

- `account` 写回 `$DATA_DIR/hot/texashold.json`
- `runtime` 写回 `$DATA_DIR/hot/runtime-rooms.json`；若为 `null` 则不创建该文件
- `archive` 写回 `$DATA_DIR/archive-ring/history-events.json`
- `analysis` 写回 `$DATA_DIR/archive-ring/hand-analysis-events.json`

目标文件保持 `0600` 权限，再启动服务。不要在进程仍写入数据时覆盖正式文件。新进程会恢复进行中的牌局、刷新行动令牌，并给当前玩家增加重连缓冲时间。
