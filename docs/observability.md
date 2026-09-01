# 可观测性与外部日志归档

## 设计目标

服务端将 HTTP、Socket.IO、房间生命周期和结算事件写成结构化 JSONL。玩家操作的关键路径只把已经脱敏的对象放入内存有界队列；文件追加、轮转、容量回收和外部归档均在后台进行。日志目录或归档端暂时不可用时，牌局继续运行，异常只会出现在 `/api/health` 的 `logging` 状态中。

浏览器只上报严格白名单内的诊断字段。服务端不会把请求体、聊天正文、密码、Cookie、Bearer Token、行动令牌、完整手牌、牌堆、技能三选一候选或技能私密判定结果写入通用 JSONL。牌桌行动日志只包含街道、下注量、底池、有效筹码和行动来源；完整底牌另存于访问受限的逐手分析归档。

## JSONL 结构

每行是一个独立 JSON 对象，基础字段为：

| 字段 | 说明 |
| --- | --- |
| `ts` | UTC ISO-8601 时间 |
| `level` | `trace/debug/info/warn/error/fatal` |
| `domain` | 功能域，见下表 |
| `event` / `eventId` | 稳定事件名和本次日志唯一 ID |
| `service/environment/release/instanceId` | 服务、环境、发布版本和实例 |
| `requestId` | HTTP 请求或 Socket 操作关联 ID；Socket ack 也返回该值 |
| `userId/roomCode/handId/handNumber` | 存在相应上下文时记录的关联 ID |
| `durationMs/statusCode/reason` | 耗时、HTTP 状态或拒绝原因（按事件出现） |

功能域：

| 域 | 覆盖范围 |
| --- | --- |
| `auth` | 注册、登录、会话、连接、限流与来源校验 |
| `lobby` | 大厅列表、排行榜、资料与历史 API |
| `room` | 创建、加入、离开、座位、准备、房主与聊天操作 |
| `game` | 开局及非下注类牌局生命周期 |
| `action` | 过牌、跟注、加注、全押、弃牌、亮牌和加时 |
| `spectator` | 观战视角和手牌可见性 |
| `hextech` | 人物、技能装备与技能命令；不记录私密结果 |
| `rebuy` | 接受或拒绝补筹 |
| `settlement` | 单手历史入账和终局结算 |
| `deploy` | 启动、关闭、健康检查、持久化与未捕获异常 |

示例：

```json
{"ts":"2026-08-26T12:00:00.000Z","level":"info","domain":"action","event":"socket_operation_succeeded","eventId":"…","service":"friends-holdem","environment":"production","release":"v1.2.0","instanceId":"instance-a","requestId":"…","userId":"…","roomCode":"ABCD","handId":"…","handNumber":8,"operation":"game:action","action":"call","durationMs":3}
```

## 本地文件与容量

默认目录：

```text
$DATA_DIR/logs/
├── hot/application.jsonl
└── archive-ring/application-<instance>-<UTC>-<sequence>.jsonl
```

- 单个活跃文件默认最大 5 MiB，或每 15 分钟轮转一次。
- 本地归档环默认最多 12 个文件、总计 50 MiB；超过任一限制会删除最旧段并增加健康状态中的 `archiveDroppedFiles`。
- 内存队列默认最多 5000 条。磁盘长期不可写时保留最新日志并增加 `droppedEntries/failedWrites`，不会反压玩家操作。
- 文件权限为 `0600`，目录权限为 `0700`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LOG_ENABLED` | `true` | 总开关 |
| `LOG_LEVEL` | 生产 `info`，开发 `debug` | 最低级别 |
| `LOG_DIR` | `$DATA_DIR/logs` | 应用主机的本地日志根目录 |
| `LOG_STDOUT` | `true` | 同时输出 JSONL 到容器 stdout |
| `LOG_FILE_MAX_BYTES` | `5242880` | 活跃文件轮转大小 |
| `LOG_ROTATE_INTERVAL_MS` | `900000` | 时间轮转间隔 |
| `LOG_ARCHIVE_MAX_BYTES` | `52428800` | 本地归档环总容量 |
| `LOG_ARCHIVE_MAX_FILES` | `12` | 本地归档环文件数 |
| `LOG_QUEUE_MAX_ENTRIES` | `5000` | 内存队列上限 |
| `LOG_FLUSH_INTERVAL_MS` | `250` | 后台批量写入周期 |
| `APP_RELEASE` | `dev` | 发布版本，用镜像 tag 或 commit SHA |
| `INSTANCE_ID` | 自动生成 | 多实例查询标签，生产建议显式配置 |
| `LOG_ARCHIVE_MODE` | `disabled` | 外部归档模式：`disabled`、`pull` 或 `push` |
| `LOG_ARCHIVE_SYNC_INTERVAL_MS` | `30000` | 归档状态检查/推送周期 |
| `LOG_ARCHIVE_STALE_AFTER_MS` | `300000` | 多久未成功归档即标记 stale |
| `LOG_ARCHIVE_DIR` | 空 | 仅 `push`：已存在的外部日志目录 |
| `LOG_ARCHIVE_READY_FILE` | 空 | 仅 `push`：建议设为挂载内哨兵文件，防止掉挂后误写本地目录 |

远端部署可使用 `LOG_ARCHIVE_MODE=pull` 配合限权 SSH；不得把网络文件系统设为 `LOG_DIR`。真实主机、密钥和目录只配置在未跟踪的环境文件中。

## 外部归档拉取和落盘

`deploy/backup/archive-pull-backup.sh` 会发送固定能力标记 `texas-holdem-backup-v4`；受限导出器只有收到该标记才启用 v4 日志和私有逐手分析成员，并推进日志归档游标。v3 拉取器仍只能获得日志，旧版拉取器获得不含日志的 v2 业务快照。上线时应先更新归档拉取脚本，再更新应用主机导出器。

v4 协议会附带本地私有分析环，以及自上次日志拉取以来（含默认 5 分钟重试窗口）的已轮转日志段。归档端会：

1. 限制段数和传输总量；
2. 校验安全文件名、Base64、SHA-256 和单段 8 MiB 上限；
3. 逐行解析 JSONL，检查域、级别，以及敏感键是否已被替换为 `[REDACTED]`；
4. 按首条日志日期原子写入 `$TEXAS_HOLDEM_ARCHIVE_ROOT/logs/app/YYYY/MM/DD/`，以 SHA-256 去重；
5. 从账号/运行时快照中移除日志传输成员，避免日志造成业务快照重复。

私有分析成员会另外物化为逐手 JSON，并写入 NAS 上的 SQLite。它包含所有玩家底牌，不属于可观测性日志，不应复制到普通日志平台或开放给客户端查询。

归档端断线期间，应用主机继续在本地有界归档环中保留最新段。恢复后拉取器会补传仍在本地环中的段。应监控归档环容量，确保它覆盖计划中的最长离线窗口。

`push` 模式适合确有后台共享目录的环境：应用只在后台复制，要求目标目录预先存在，并建议强制配置 `LOG_ARCHIVE_READY_FILE`。复制失败不会创建挂载根目录，也不会影响牌局。

## 健康检查与排障

`GET /api/health` 的 `logging` 包含：

- `fileHealthy`、`lastWriteAt/lastWriteError`；
- `queuedEntries/droppedEntries/failedWrites`；
- 活跃文件和本地归档环容量；
- `archive.state`（`disabled/waiting/healthy/stale/degraded/unavailable`）、最近尝试/成功时间和待同步数。

排查玩家反馈时优先索取界面错误对应的 `requestId`，再按 `requestId` 查询；若没有，则组合 `roomCode + handId + userId + ts`。不要要求玩家提供密码、会话 Cookie 或完整底牌截图。

常用查询：

```bash
jq -c 'select(.requestId == "REQUEST_ID")' "$DATA_DIR"/logs/{hot,archive-ring}/*.jsonl
jq -c 'select(.roomCode == "ABCD" and .level != "info")' "$DATA_DIR"/logs/{hot,archive-ring}/*.jsonl
jq -c 'select(.domain == "settlement" and .handNumber == 8)' "$DATA_DIR"/logs/{hot,archive-ring}/*.jsonl
```
